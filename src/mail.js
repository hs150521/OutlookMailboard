const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const GRAPH_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders';
const MAX_MESSAGES = 30;

class MailError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function plainText(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .slice(0, 50000);
}

async function responseJson(response, label) {
  if (!response.ok) throw new MailError(`${label}失败（HTTP ${response.status}）`);
  return response.json();
}

function createMailClient({ fetchImpl = globalThis.fetch, ImapClass = ImapFlow } = {}) {
  async function requestToken(mailbox, scope) {
    const body = new URLSearchParams({
      client_id: mailbox.client_id,
      grant_type: 'refresh_token',
      refresh_token: mailbox.refresh_token,
    });
    if (scope) body.set('scope', scope);
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new MailError('连接微软授权服务失败');
    }
    const data = await responseJson(response, '邮箱授权');
    if (!data.access_token) throw new MailError('微软未返回访问令牌');
    return data;
  }

  async function graphFolder(token, folder) {
    const folderId = folder === 'junk' ? 'junkemail' : 'inbox';
    const query = new URLSearchParams({
      '$top': String(MAX_MESSAGES),
      '$orderby': 'receivedDateTime desc',
      '$select': 'id,from,subject,bodyPreview,body,receivedDateTime',
    });
    let response;
    try {
      response = await fetchImpl(`${GRAPH_URL}/${folderId}/messages?${query}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'outlook.body-content-type="text"',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new MailError('连接 Microsoft Graph 失败');
    }
    if (response.status === 401 || response.status === 403) {
      throw new MailError('Graph 邮件读取权限不足', 403);
    }
    const data = await responseJson(response, '读取邮件');
    return (data.value || []).map((item) => {
      const bodyText = plainText(item.body?.content || item.bodyPreview);
      return {
        id: item.id,
        sender: item.from?.emailAddress?.address || '',
        subject: item.subject || '',
        preview: plainText(item.bodyPreview || bodyText).slice(0, 300),
        bodyText,
        receivedAt: item.receivedDateTime || null,
      };
    });
  }

  async function folderName(client, folder) {
    if (folder === 'inbox') return 'INBOX';
    const folders = await client.list();
    return folders.find((item) => item.specialUse === '\\Junk')?.path
      || folders.find((item) => /^(junk|junk email|spam)$/i.test(item.name || item.path))?.path
      || null;
  }

  async function imapFolder(client, folder) {
    const name = await folderName(client, folder);
    if (!name) return [];
    let lock;
    try {
      lock = await client.getMailboxLock(name);
    } catch (error) {
      if (folder === 'junk' && /nonexistent|does not exist|no such|not found/i.test(error.message || '')) return [];
      throw error;
    }
    try {
      const total = client.mailbox.exists;
      if (!total) return [];
      const first = Math.max(1, total - MAX_MESSAGES + 1);
      const messages = [];
      for await (const item of client.fetch(`${first}:*`, { source: true, envelope: true, uid: true })) {
        const parsed = await simpleParser(item.source);
        const bodyText = plainText(parsed.text || parsed.html || '');
        messages.push({
          id: String(item.uid),
          sender: parsed.from?.text || '',
          subject: parsed.subject || '',
          preview: bodyText.slice(0, 300),
          bodyText,
          receivedAt: parsed.date ? parsed.date.toISOString() : null,
        });
      }
      return messages.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    } finally {
      lock.release();
    }
  }

  async function imapMessages(mailbox, token) {
    const client = new ImapClass({
      host: 'outlook.office365.com', port: 993, secure: true,
      auth: { user: mailbox.email, accessToken: token },
      logger: false,
      connectionTimeout: 20000,
      socketTimeout: 30000,
    });
    try {
      await client.connect();
      return { inbox: await imapFolder(client, 'inbox'), junk: await imapFolder(client, 'junk') };
    } catch {
      throw new MailError('IMAP 读取失败，请检查邮箱授权是否包含 IMAP 权限');
    } finally {
      if (client.usable) await client.logout().catch(() => {});
    }
  }

  async function clearGraphFolder(token, folder) {
    const folderId = folder === 'junk' ? 'junkemail' : 'inbox';
    const url = `${GRAPH_URL}/${folderId}/messages?$top=100&$select=id`;
    let deleted = 0;
    for (;;) {
      let listResponse;
      try {
        listResponse = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000),
        });
      } catch { throw new MailError('连接 Microsoft Graph 失败'); }
      if (listResponse.status === 403) throw new MailError('清空文件夹需要 Mail.ReadWrite 权限', 403);
      const list = await responseJson(listResponse, '列出待删除邮件');
      if (!list.value?.length) break;
      for (const item of list.value) {
        const response = await fetchImpl(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(item.id)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000),
        }).catch(() => { throw new MailError('删除邮件时连接失败'); });
        if (response.status === 403) throw new MailError('清空文件夹需要 Mail.ReadWrite 权限', 403);
        if (!response.ok) throw new MailError(`删除邮件失败（HTTP ${response.status}）`);
        deleted++;
      }
      if (deleted >= 10000) throw new MailError('已删除 10000 封邮件，请再次执行以处理剩余邮件');
    }
    return deleted;
  }

  async function clearImapFolder(mailbox, token, folder) {
    const client = new ImapClass({
      host: 'outlook.office365.com', port: 993, secure: true,
      auth: { user: mailbox.email, accessToken: token },
      logger: false, connectionTimeout: 20000, socketTimeout: 30000,
    });
    try {
      await client.connect();
      const name = await folderName(client, folder);
      if (!name) return 0;
      const lock = await client.getMailboxLock(name);
      try {
        const count = client.mailbox.exists;
        if (count && !(await client.messageDelete('1:*'))) throw new MailError('IMAP 删除邮件失败');
        return count;
      } finally { lock.release(); }
    } catch (error) {
      if (error instanceof MailError) throw error;
      throw new MailError('IMAP 清空失败，请检查邮箱授权与文件夹权限');
    } finally {
      if (client.usable) await client.logout().catch(() => {});
    }
  }

  async function fetchMessages(mailbox) {
    let graphToken;
    try {
      graphToken = await requestToken(mailbox, 'https://graph.microsoft.com/.default');
    } catch (error) {
      // Some existing accounts were authorized only for Outlook IMAP.
      if (!(error instanceof MailError)) throw error;
    }
    const graphScopes = String(graphToken?.scope || '').toLowerCase();
    if (graphToken?.access_token && (graphScopes.includes('mail.read') || !graphScopes)) {
      try {
        const folders = {
          inbox: await graphFolder(graphToken.access_token, 'inbox'),
          junk: await graphFolder(graphToken.access_token, 'junk'),
        };
        return { folders, refreshToken: graphToken.refresh_token || null, method: 'graph' };
      } catch (error) {
        if (error.status !== 403) throw error;
      }
    }
    const imapMailbox = graphToken?.refresh_token
      ? { ...mailbox, refresh_token: graphToken.refresh_token } : mailbox;
    const imapToken = await requestToken(imapMailbox);
    return {
      folders: await imapMessages(mailbox, imapToken.access_token),
      refreshToken: imapToken.refresh_token || graphToken?.refresh_token || null,
      method: 'imap',
    };
  }

  async function clearFolder(mailbox, folder) {
    if (!['inbox', 'junk'].includes(folder)) throw new MailError('无效的邮箱文件夹', 400);
    let graphToken;
    try { graphToken = await requestToken(mailbox, 'https://graph.microsoft.com/.default'); }
    catch (error) { if (!(error instanceof MailError)) throw error; }
    const scopes = String(graphToken?.scope || '').toLowerCase();
    if (graphToken?.access_token && scopes.includes('mail.readwrite')) {
      return { deleted: await clearGraphFolder(graphToken.access_token, folder),
        refreshToken: graphToken.refresh_token || null, method: 'graph' };
    }
    try {
      const imapMailbox = graphToken?.refresh_token
        ? { ...mailbox, refresh_token: graphToken.refresh_token } : mailbox;
      const imapToken = await requestToken(imapMailbox);
      return { deleted: await clearImapFolder(mailbox, imapToken.access_token, folder),
        refreshToken: imapToken.refresh_token || graphToken?.refresh_token || null, method: 'imap' };
    } catch (error) {
      if (graphToken?.access_token && !scopes.includes('mail.readwrite')) {
        throw new MailError('清空文件夹需要 Graph Mail.ReadWrite 或 IMAP 权限', 403);
      }
      throw error;
    }
  }

  return { fetchMessages, clearFolder };
}

module.exports = { createMailClient, MailError };
