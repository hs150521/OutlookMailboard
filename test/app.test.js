const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, parseImportLine } = require('../src/server');
const { createStore } = require('../src/storage');

test('four-column import ignores the legacy password', () => {
  assert.deepEqual(parseImportLine('Mail@Outlook.com----secret----client-id----refresh-token'), {
    email: 'mail@outlook.com', clientId: 'client-id', refreshToken: 'refresh-token',
  });
});

test('admin, mailboxes, platform states and manual refresh work together', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-test-'));
  const store = createStore(dataDir);
  let fetchCount = 0;
  const mailClient = {
    async fetchMessages() {
      fetchCount++;
      return {
        method: 'graph', refreshToken: 'rotated-token',
        folders: {
          inbox: [{ id: 'm1', sender: 'sender@example.net', subject: '验证码',
            preview: '123456', bodyText: '验证码 123456', receivedAt: '2026-10-10T10:00:00.000Z' }],
          junk: [],
        },
      };
    },
    async clearFolder(_mailbox, folder) {
      assert.equal(folder, 'inbox');
      return { deleted: 1, method: 'graph', refreshToken: null };
    },
  };
  const server = createApp({ store, mailClient }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';
  async function request(method, route, body, includeCsrf = true) {
    const headers = { Cookie: cookie };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (includeCsrf && csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`${base}${route}`, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    return { response, result };
  }

  let r = await request('GET', '/api/auth/state');
  assert.equal(r.result.initialized, false);
  r = await request('GET', '/api/mailboxes');
  assert.equal(r.response.status, 401);
  r = await request('POST', '/api/auth/setup', { username: 'admin', password: 'a-strong-password-123' });
  assert.equal(r.response.status, 201);
  cookie = r.response.headers.get('set-cookie').split(';')[0];
  csrf = r.result.csrfToken;
  assert.match(r.response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(r.response.headers.get('set-cookie'), /SameSite=Strict/i);
  r = await request('POST', '/api/auth/setup', { username: 'second', password: 'another-long-password' });
  assert.equal(r.response.status, 409);
  r = await request('POST', '/api/mailboxes', { email: 'one@outlook.com', clientId: 'client-a', refreshToken: 'secret-token' }, false);
  assert.equal(r.response.status, 403);

  r = await request('POST', '/api/mailboxes', { email: 'one@outlook.com', clientId: 'client-a', refreshToken: 'secret-token' });
  assert.equal(r.response.status, 201);
  const mailboxId = r.result.mailbox.id;
  assert.equal(r.result.mailbox.refreshToken, undefined);
  const stored = store.db.prepare('SELECT refresh_token FROM mailboxes WHERE id = ?').get(mailboxId).refresh_token;
  assert.notEqual(stored, 'secret-token');
  assert.equal(store.decrypt(stored), 'secret-token');

  r = await request('POST', '/api/platforms', { name: 'GPTZero' });
  const firstPlatform = r.result.platform.id;
  r = await request('POST', '/api/platforms', { name: 'Other' });
  const secondPlatform = r.result.platform.id;
  r = await request('GET', `/api/platforms/${firstPlatform}/registrations`);
  assert.equal(r.result.mailboxes[0].registered, false);
  r = await request('PUT', `/api/platforms/${firstPlatform}/registrations/${mailboxId}`, { registered: true });
  assert.equal(r.result.registered, true);
  r = await request('GET', `/api/platforms/${secondPlatform}/registrations`);
  assert.equal(r.result.mailboxes[0].registered, false);
  r = await request('GET', '/api/mailboxes');
  assert.equal(r.result.mailboxes[0].registered, undefined);
  assert.equal(r.result.mailboxes[0].lastReceivedAt, null);
  assert.equal(fetchCount, 0);

  r = await request('POST', `/api/mailboxes/${mailboxId}/refresh`, {});
  assert.equal(r.response.status, 200);
  assert.equal(fetchCount, 1);
  assert.equal(r.result.mailbox.lastReceivedAt, '2026-10-10T10:00:00.000Z');
  assert.ok(r.result.mailbox.lastCheckedAt);
  assert.equal(store.decrypt(store.db.prepare('SELECT refresh_token FROM mailboxes WHERE id = ?').get(mailboxId).refresh_token), 'rotated-token');
  r = await request('GET', `/api/mailboxes/${mailboxId}/messages?folder=inbox`);
  assert.equal(r.result.messages[0].bodyText, '验证码 123456');
  r = await request('GET', `/api/platforms/${firstPlatform}/registrations`);
  assert.equal(r.result.mailboxes[0].registered, true);

  r = await request('POST', `/api/mailboxes/${mailboxId}/clear`, { folder: 'inbox', confirmEmail: 'wrong@outlook.com' });
  assert.equal(r.response.status, 400);
  r = await request('POST', `/api/mailboxes/${mailboxId}/clear`, { folder: 'inbox', confirmEmail: 'one@outlook.com' });
  assert.equal(r.result.deleted, 1);
  r = await request('GET', `/api/mailboxes/${mailboxId}/messages?folder=inbox`);
  assert.deepEqual(r.result.messages, []);
  r = await request('GET', '/api/mailboxes');
  assert.equal(r.result.mailboxes[0].lastReceivedAt, null);

  r = await request('POST', '/api/auth/logout', {});
  assert.equal(r.response.status, 200);
  r = await request('GET', '/api/mailboxes');
  assert.equal(r.response.status, 401);
  r = await request('POST', '/api/auth/login', { username: 'admin', password: 'a-strong-password-123' }, false);
  assert.equal(r.response.status, 200);
});
