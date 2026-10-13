const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStore } = require('../src/storage');
const { hashPassword, verifyPassword } = require('../src/auth');

test('administrator, encrypted credentials, platform status and mail survive reopening', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-persistence-'));
  let store;
  try {
    store = createStore(dataDir);
    store.db.prepare('INSERT INTO admin (id, username, password_hash) VALUES (1, ?, ?)')
      .run('admin', hashPassword('a-persistent-password'));
    store.db.prepare('INSERT INTO mailboxes (id, email, client_id, refresh_token) VALUES (1, ?, ?, ?)')
      .run('one@outlook.com', 'client', store.encrypt('persisted-refresh-token'));
    store.db.prepare('INSERT INTO platforms (id, name) VALUES (1, ?)').run('GPTZero');
    store.db.prepare('INSERT INTO registrations (platform_id, mailbox_id, registered) VALUES (1, 1, 1)').run();
    store.saveMessages(1, {
      inbox: [{ id: 'inbox-one', bodyText: 'older message', receivedAt: '2026-10-10T10:00:00.000Z' }],
      junk: [{ id: 'junk-one', bodyText: 'newest message', receivedAt: '2026-10-12T10:00:00.000Z' }],
    });
    store.close();
    store = createStore(dataDir);
    const admin = store.db.prepare('SELECT * FROM admin').get();
    assert.equal(admin.username, 'admin');
    assert.equal(verifyPassword('a-persistent-password', admin.password_hash), true);
    const mailbox = store.db.prepare('SELECT * FROM mailboxes').get();
    assert.equal(store.decrypt(mailbox.refresh_token), 'persisted-refresh-token');
    assert.equal(mailbox.last_received_at, '2026-10-12T10:00:00.000Z');
    assert.ok(mailbox.last_checked_at);
    assert.equal(store.db.prepare('SELECT registered FROM registrations').get().registered, 1);
    assert.equal(store.db.prepare("SELECT body_text FROM messages WHERE folder = 'junk'").get().body_text, 'newest message');
  } finally {
    store?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
