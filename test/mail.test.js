const assert = require('node:assert/strict');
const test = require('node:test');
const { createMailClient } = require('../src/mail');

test('Graph refresh reads inbox and junk with text content', async () => {
  const calls = [];
  const client = createMailClient({
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.includes('/token')) return new Response(JSON.stringify({
        access_token: 'access-token', refresh_token: 'new-refresh-token',
        scope: 'https://graph.microsoft.com/Mail.Read',
      }), { status: 200 });
      return new Response(JSON.stringify({ value: url.includes('/inbox/') ? [{
        id: 'message-one', from: { emailAddress: { address: 'sender@example.net' } },
        subject: 'Your code', bodyPreview: '123456', body: { content: 'Code: 123456' },
        receivedDateTime: '2026-10-10T10:00:00Z',
      }] : [] }), { status: 200 });
    },
  });
  const result = await client.fetchMessages({
    email: 'one@outlook.com', client_id: 'client', refresh_token: 'old-token',
  });
  assert.equal(result.method, 'graph');
  assert.equal(result.refreshToken, 'new-refresh-token');
  assert.equal(result.folders.inbox[0].bodyText, 'Code: 123456');
  assert.deepEqual(result.folders.junk, []);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.body.get('refresh_token'), 'old-token');
});

test('IMAP-only authorization falls back and discovers the junk folder', async () => {
  const opened = [];
  class FakeImap {
    constructor(options) {
      assert.equal(options.auth.accessToken, 'imap-token');
      assert.equal(options.secure, true);
      this.usable = true;
    }
    async connect() {}
    async list() { return [{ path: 'Junk Email', specialUse: '\\Junk' }]; }
    async getMailboxLock(folder) {
      opened.push(folder);
      this.mailbox = { exists: folder === 'INBOX' ? 1 : 0 };
      return { release() {} };
    }
    async *fetch() {
      yield { uid: 42, source: Buffer.from('From: sender@example.net\r\nSubject: Test message\r\nDate: Fri, 10 Oct 2025 10:00:00 +0000\r\n\r\nCode: 654321') };
    }
    async logout() { this.usable = false; }
  }
  let tokenRequests = 0;
  const client = createMailClient({
    ImapClass: FakeImap,
    async fetchImpl() {
      tokenRequests++;
      if (tokenRequests === 1) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ access_token: 'imap-token', refresh_token: 'rotated-imap-token' }), { status: 200 });
    },
  });
  const result = await client.fetchMessages({ email: 'one@outlook.com', client_id: 'client', refresh_token: 'token' });
  assert.equal(result.method, 'imap');
  assert.equal(result.refreshToken, 'rotated-imap-token');
  assert.deepEqual(opened, ['INBOX', 'Junk Email']);
  assert.equal(result.folders.inbox[0].id, '42');
  assert.match(result.folders.inbox[0].bodyText, /654321/);
  assert.deepEqual(result.folders.junk, []);
});
