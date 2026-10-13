const path = require('node:path');
const express = require('express');
const { createStore } = require('./storage');
const { hashPassword, verifyPassword, issueSession, getSession, equalToken } = require('./auth');
const { createMailClient } = require('./mail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicMailbox(row) {
  return {
    id: row.id, email: row.email, clientId: row.client_id,
    lastReceivedAt: row.last_received_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function validateMailbox(body, editing = false) {
  const email = String(body.email || '').trim().toLowerCase();
  const clientId = String(body.clientId || '').trim();
  const refreshToken = String(body.refreshToken || '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return '请输入有效邮箱地址';
  if (!clientId || clientId.length > 200) return '请输入客户端 ID';
  if ((!editing && !refreshToken) || refreshToken.length > 10000) return '请输入刷新令牌';
  return null;
}

function parseImportLine(line) {
  const fields = String(line).split('----').map((value) => value.trim());
  if (fields.length === 4) fields.splice(1, 1); // Legacy format includes a password we do not store.
  if (fields.length !== 3) throw new Error('格式应为 邮箱----客户端ID----刷新令牌');
  const [email, clientId, refreshToken] = fields;
  const error = validateMailbox({ email, clientId, refreshToken });
  if (error) throw new Error(error);
  return { email: email.toLowerCase(), clientId, refreshToken };
}

function createApp({ store = createStore(), mailClient = createMailClient() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.use((_request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.get('Origin');
      if (origin) {
        try {
          if (new URL(origin).host !== request.get('host')) return response.status(403).json({ error: '请求来源不匹配' });
        } catch {
          return response.status(403).json({ error: '请求来源无效' });
        }
      }
      if (!request.is('application/json')) return response.status(415).json({ error: '只接受 JSON 请求' });
    }
    next();
  });

  const loginAttempts = new Map();
  const refreshLocks = new Set();

  app.get('/api/auth/state', (request, response) => {
    const admin = store.db.prepare('SELECT username FROM admin WHERE id = 1').get();
    const session = getSession(request, store);
    response.json({ initialized: !!admin, authenticated: !!(admin && session),
      username: admin && session ? admin.username : null, csrfToken: session?.csrf || null });
  });

  app.post('/api/auth/setup', (request, response) => {
    if (store.db.prepare('SELECT id FROM admin WHERE id = 1').get()) return response.status(409).json({ error: '管理员已设置' });
    const username = String(request.body?.username || '').trim();
    const password = String(request.body?.password || '');
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) return response.status(400).json({ error: '用户名须为 3 至 32 个字母、数字、下划线或连字符' });
    if (password.length < 12 || password.length > 128) return response.status(400).json({ error: '密码须为 12 至 128 个字符' });
    try {
      store.db.prepare('INSERT INTO admin (id, username, password_hash) VALUES (1, ?, ?)')
        .run(username, hashPassword(password));
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) return response.status(409).json({ error: '管理员已设置' });
      throw error;
    }
    response.status(201).json({ username, csrfToken: issueSession(request, response, store) });
  });

  app.post('/api/auth/login', (request, response) => {
    const key = request.ip;
    const recent = (loginAttempts.get(key) || []).filter((time) => Date.now() - time < 10 * 60 * 1000);
    if (recent.length >= 5) return response.status(429).json({ error: '尝试次数过多，请稍后再试' });
    const admin = store.db.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get();
    const username = String(request.body?.username || '').trim();
    const password = String(request.body?.password || '');
    if (!admin || username !== admin.username || !verifyPassword(password, admin.password_hash)) {
      recent.push(Date.now());
      loginAttempts.set(key, recent);
      return response.status(401).json({ error: '用户名或密码错误' });
    }
    loginAttempts.delete(key);
    response.json({ username: admin.username, csrfToken: issueSession(request, response, store) });
  });

  app.use('/api', (request, response, next) => {
    const session = getSession(request, store);
    if (!session) return response.status(401).json({ error: '请先登录' });
    if (request.method !== 'GET' && request.method !== 'HEAD' && !equalToken(request.get('X-CSRF-Token'), session.csrf)) {
      return response.status(403).json({ error: '会话校验失败，请重新加载页面' });
    }
    request.mailboardSession = session;
    next();
  });

  app.post('/api/auth/logout', (request, response) => {
    store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(request.mailboardSession.hash);
    response.clearCookie('mailboard_session', { path: '/', sameSite: 'strict', secure: request.secure });
    response.json({ ok: true });
  });

  app.get('/api/mailboxes', (_request, response) => {
    const rows = store.db.prepare('SELECT * FROM mailboxes ORDER BY email COLLATE NOCASE').all();
    response.json({ mailboxes: rows.map(publicMailbox) });
  });

  app.post('/api/mailboxes', (request, response) => {
    const error = validateMailbox(request.body || {});
    if (error) return response.status(400).json({ error });
    const email = request.body.email.trim().toLowerCase();
    try {
      const info = store.db.prepare('INSERT INTO mailboxes (email, client_id, refresh_token) VALUES (?, ?, ?)')
        .run(email, request.body.clientId.trim(), store.encrypt(request.body.refreshToken.trim()));
      response.status(201).json({ mailbox: publicMailbox(store.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(info.lastInsertRowid)) });
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) return response.status(409).json({ error: '该邮箱已存在' });
      throw error;
    }
  });

  app.post('/api/mailboxes/import', (request, response) => {
    const lines = String(request.body?.text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 500) return response.status(400).json({ error: '一次可导入 1 至 500 行' });
    const parsed = [];
    for (let index = 0; index < lines.length; index++) {
      try { parsed.push(parseImportLine(lines[index])); }
      catch (error) { return response.status(400).json({ error: `第 ${index + 1} 行：${error.message}` }); }
    }
    const upsert = store.db.prepare(`INSERT INTO mailboxes (email, client_id, refresh_token) VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET client_id = excluded.client_id, refresh_token = excluded.refresh_token`);
    store.db.transaction(() => {
      for (const row of parsed) upsert.run(row.email, row.clientId, store.encrypt(row.refreshToken));
    })();
    response.json({ count: parsed.length });
  });

  app.put('/api/mailboxes/:id', (request, response) => {
    const id = Number(request.params.id);
    const existing = store.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
    if (!existing) return response.status(404).json({ error: '邮箱不存在' });
    const body = { email: request.body?.email, clientId: request.body?.clientId,
      refreshToken: request.body?.refreshToken || 'unchanged' };
    const error = validateMailbox(body, true);
    if (error) return response.status(400).json({ error });
    try {
      store.db.prepare('UPDATE mailboxes SET email = ?, client_id = ?, refresh_token = ? WHERE id = ?')
        .run(body.email.trim().toLowerCase(), body.clientId.trim(), request.body.refreshToken
          ? store.encrypt(request.body.refreshToken.trim()) : existing.refresh_token, id);
      response.json({ mailbox: publicMailbox(store.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id)) });
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) return response.status(409).json({ error: '该邮箱已存在' });
      throw error;
    }
  });

  app.delete('/api/mailboxes/:id', (request, response) => {
    const info = store.db.prepare('DELETE FROM mailboxes WHERE id = ?').run(Number(request.params.id));
    if (!info.changes) return response.status(404).json({ error: '邮箱不存在' });
    response.json({ ok: true });
  });

  app.get('/api/mailboxes/:id/messages', (request, response) => {
    const id = Number(request.params.id);
    const folder = request.query.folder === 'junk' ? 'junk' : 'inbox';
    if (!store.db.prepare('SELECT id FROM mailboxes WHERE id = ?').get(id)) return response.status(404).json({ error: '邮箱不存在' });
    const rows = store.db.prepare(`SELECT external_id AS id, sender, subject, preview,
      body_text AS bodyText, received_at AS receivedAt FROM messages
      WHERE mailbox_id = ? AND folder = ? ORDER BY received_at DESC LIMIT 30`).all(id, folder);
    response.json({ messages: rows });
  });

  app.post('/api/mailboxes/:id/refresh', async (request, response) => {
    const id = Number(request.params.id);
    const row = store.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
    if (!row) return response.status(404).json({ error: '邮箱不存在' });
    if (refreshLocks.has(id)) return response.status(409).json({ error: '该邮箱正在刷新' });
    refreshLocks.add(id);
    try {
      const result = await mailClient.fetchMessages({ email: row.email, client_id: row.client_id,
        refresh_token: store.decrypt(row.refresh_token) });
      store.db.transaction(() => {
        if (result.refreshToken) store.db.prepare('UPDATE mailboxes SET refresh_token = ? WHERE id = ?')
          .run(store.encrypt(result.refreshToken), id);
        store.saveMessages(id, result.folders);
      })();
      response.json({ mailbox: publicMailbox(store.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id)),
        counts: { inbox: result.folders.inbox.length, junk: result.folders.junk.length }, method: result.method });
    } catch (error) {
      const message = error.status ? error.message : '读取邮箱失败，请检查服务器日志';
      store.db.prepare('UPDATE mailboxes SET last_checked_at = ?, last_error = ? WHERE id = ?')
        .run(new Date().toISOString(), message, id);
      if (!error.status) console.error('Mailbox refresh failed:', error);
      response.status(error.status || 502).json({ error: message });
    } finally {
      refreshLocks.delete(id);
    }
  });

  app.post('/api/mailboxes/:id/clear', async (request, response) => {
    const id = Number(request.params.id);
    const row = store.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
    if (!row) return response.status(404).json({ error: '邮箱不存在' });
    const folder = request.body?.folder;
    if (!['inbox', 'junk'].includes(folder) || request.body?.confirmEmail !== row.email) {
      return response.status(400).json({ error: '需要确认邮箱地址与文件夹' });
    }
    if (refreshLocks.has(id)) return response.status(409).json({ error: '该邮箱正在操作' });
    refreshLocks.add(id);
    try {
      const result = await mailClient.clearFolder({ email: row.email, client_id: row.client_id,
        refresh_token: store.decrypt(row.refresh_token) }, folder);
      store.db.transaction(() => {
        if (result.refreshToken) store.db.prepare('UPDATE mailboxes SET refresh_token = ? WHERE id = ?')
          .run(store.encrypt(result.refreshToken), id);
        store.clearMessages(id, folder);
      })();
      response.json({ deleted: result.deleted, method: result.method });
    } catch (error) {
      if (!error.status) console.error('Mailbox clear failed:', error);
      response.status(error.status || 502).json({ error: error.status ? error.message : '清空邮箱失败' });
    } finally {
      refreshLocks.delete(id);
    }
  });

  app.get('/api/platforms', (_request, response) => {
    response.json({ platforms: store.db.prepare('SELECT id, name, created_at AS createdAt FROM platforms ORDER BY name COLLATE NOCASE').all() });
  });

  app.post('/api/platforms', (request, response) => {
    const name = String(request.body?.name || '').trim();
    if (!name || name.length > 80) return response.status(400).json({ error: '平台名称须为 1 至 80 个字符' });
    try {
      const info = store.db.prepare('INSERT INTO platforms (name) VALUES (?)').run(name);
      response.status(201).json({ platform: { id: info.lastInsertRowid, name } });
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) return response.status(409).json({ error: '平台已存在' });
      throw error;
    }
  });

  app.get('/api/platforms/:id/registrations', (request, response) => {
    const id = Number(request.params.id);
    const platform = store.db.prepare('SELECT id, name FROM platforms WHERE id = ?').get(id);
    if (!platform) return response.status(404).json({ error: '平台不存在' });
    const rows = store.db.prepare(`SELECT m.id, m.email, m.last_received_at, m.last_checked_at, m.last_error,
      COALESCE(r.registered, 0) AS registered
      FROM mailboxes m LEFT JOIN registrations r ON r.mailbox_id = m.id AND r.platform_id = ?
      ORDER BY m.email COLLATE NOCASE`).all(id);
    response.json({ platform, mailboxes: rows.map((row) => ({ id: row.id, email: row.email,
      lastReceivedAt: row.last_received_at, lastCheckedAt: row.last_checked_at, lastError: row.last_error,
      registered: !!row.registered })) });
  });

  app.put('/api/platforms/:platformId/registrations/:mailboxId', (request, response) => {
    const platformId = Number(request.params.platformId);
    const mailboxId = Number(request.params.mailboxId);
    if (typeof request.body?.registered !== 'boolean') return response.status(400).json({ error: '状态必须为布尔值' });
    if (!store.db.prepare('SELECT id FROM platforms WHERE id = ?').get(platformId)) return response.status(404).json({ error: '平台不存在' });
    if (!store.db.prepare('SELECT id FROM mailboxes WHERE id = ?').get(mailboxId)) return response.status(404).json({ error: '邮箱不存在' });
    store.db.prepare(`INSERT INTO registrations (platform_id, mailbox_id, registered) VALUES (?, ?, ?)
      ON CONFLICT(platform_id, mailbox_id) DO UPDATE SET registered = excluded.registered, updated_at = CURRENT_TIMESTAMP`)
      .run(platformId, mailboxId, request.body.registered ? 1 : 0);
    response.json({ registered: request.body.registered });
  });

  app.use('/api', (_request, response) => response.status(404).json({ error: '接口不存在' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
  app.use((_request, response) => response.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use((error, _request, response, _next) => {
    console.error('Request failed:', error);
    response.status(500).json({ error: '服务器内部错误' });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Mailboard listening on ${port}`));
}

module.exports = { createApp, parseImportLine };
