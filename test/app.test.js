const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, parseImportLine } = require('../src/server');
const { createStore } = require('../src/storage');

test('four-column import ignores the legacy password', () => {
  assert.deepEqual(parseImportLine('Mail@Outlook.com----secret----00000000-0000-0000-0000-000000000001----M.TEST.!sample*token'), {
    email: 'mail@outlook.com', clientId: '00000000-0000-0000-0000-000000000001', refreshToken: 'M.TEST.!sample*token',
  });
});

test('password changes enforce ten characters, require the current password and revoke old sessions', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-password-test-'));
  const store = createStore(dataDir);
  const server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body, cookie = '', csrf = '') {
    return fetch(`${base}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify(body),
    });
  }
  const oldPassword = '1234567890';
  const newPassword = 'abcdefghij';
  assert.equal((await request('/api/auth/password', { currentPassword: oldPassword, newPassword })).status, 401);
  assert.equal((await request('/api/auth/setup', { username: 'admin', password: '123456789' })).status, 400);
  const setup = await request('/api/auth/setup', { username: 'admin', password: oldPassword });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const csrf = (await setup.json()).csrfToken;
  const otherLogin = await request('/api/auth/login', { username: 'admin', password: oldPassword });
  const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
  const originalHash = store.db.prepare('SELECT password_hash FROM admin').get().password_hash;
  assert.equal((await request('/api/auth/password', { currentPassword: oldPassword, newPassword }, cookie)).status, 403);
  assert.equal((await request('/api/auth/password', { currentPassword: 'wrong-password', newPassword }, cookie, csrf)).status, 400);
  for (const invalidPassword of ['123456789', 'a'.repeat(129)]) {
    assert.equal((await request('/api/auth/password', { currentPassword: oldPassword, newPassword: invalidPassword }, cookie, csrf)).status, 400);
  }
  assert.equal(store.db.prepare('SELECT password_hash FROM admin').get().password_hash, originalHash);
  const changed = await request('/api/auth/password', { currentPassword: oldPassword, newPassword }, cookie, csrf);
  assert.equal(changed.status, 200);
  const newCookie = changed.headers.get('set-cookie').split(';')[0];
  const newCsrf = (await changed.json()).csrfToken;
  assert.notEqual(newCookie, cookie);
  assert.notEqual(newCsrf, csrf);
  assert.notEqual(store.db.prepare('SELECT password_hash FROM admin').get().password_hash, newPassword);
  for (const oldCookie of [cookie, otherCookie]) {
    assert.equal((await fetch(`${base}/api/mailboxes`, { headers: { Cookie: oldCookie } })).status, 401);
  }
  assert.equal((await fetch(`${base}/api/mailboxes`, { headers: { Cookie: newCookie } })).status, 200);
  assert.equal((await request('/api/auth/login', { username: 'admin', password: oldPassword })).status, 401);
  assert.equal((await request('/api/auth/login', { username: 'admin', password: newPassword })).status, 200);
  assert.equal((await request('/api/auth/logout', {}, newCookie, newCsrf)).status, 200);
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
  r = await request('POST', '/api/mailboxes/export', { ids: [mailboxId] });
  assert.deepEqual(r.result.mailboxes, [{
    email: 'one@outlook.com', clientId: 'client-a', refreshToken: 'secret-token',
  }]);

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

  r = await request('PUT', `/api/platforms/${secondPlatform}/registrations/${mailboxId}`, { registered: true });
  assert.equal(r.response.status, 200);
  r = await request('DELETE', `/api/platforms/${secondPlatform}`, {}, false);
  assert.equal(r.response.status, 403);
  r = await request('DELETE', '/api/platforms/invalid', {});
  assert.equal(r.response.status, 400);
  r = await request('DELETE', `/api/platforms/${secondPlatform}`, {});
  assert.equal(r.response.status, 200);
  assert.equal(r.result.deleted, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM registrations WHERE platform_id = ?').get(secondPlatform).count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM mailboxes').get().count, 1);
  assert.equal(store.decrypt(store.db.prepare('SELECT refresh_token FROM mailboxes WHERE id = ?').get(mailboxId).refresh_token), 'rotated-token');
  r = await request('GET', `/api/platforms/${firstPlatform}/registrations`);
  assert.equal(r.result.mailboxes[0].registered, true);
  r = await request('GET', `/api/mailboxes/${mailboxId}/messages?folder=inbox`);
  assert.equal(r.result.messages[0].bodyText, '验证码 123456');
  r = await request('DELETE', `/api/platforms/${secondPlatform}`, {});
  assert.equal(r.response.status, 404);

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
  r = await request('DELETE', `/api/platforms/${firstPlatform}`, {});
  assert.equal(r.response.status, 401);
  r = await request('POST', '/api/auth/login', { username: 'admin', password: 'a-strong-password-123' }, false);
  assert.equal(r.response.status, 200);
  cookie = r.response.headers.get('set-cookie').split(';')[0];
  csrf = r.result.csrfToken;
  r = await request('POST', '/api/mailboxes/delete-batch', { ids: [mailboxId] });
  assert.equal(r.result.deleted, 1);
  r = await request('GET', `/api/platforms/${firstPlatform}/registrations`);
  assert.deepEqual(r.result.mailboxes, []);

  r = await request('POST', '/api/mailboxes/import', {
    text: 'bulk-one@example.net----ignored-password----client-one----M.TEST.!token*one\n\n bulk-two@example.net----client-two----token-two ',
  });
  assert.equal(r.response.status, 200);
  assert.equal(r.result.count, 2);
  r = await request('POST', '/api/mailboxes/export', { ids: [] });
  assert.deepEqual(r.result.mailboxes, [
    { email: 'bulk-one@example.net', clientId: 'client-one', refreshToken: 'M.TEST.!token*one' },
    { email: 'bulk-two@example.net', clientId: 'client-two', refreshToken: 'token-two' },
  ]);
});
