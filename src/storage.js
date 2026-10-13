const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function loadKey(dataDir) {
  const configured = process.env.MAILBOARD_ENCRYPTION_KEY;
  if (configured) {
    const key = /^[a-f0-9]{64}$/i.test(configured)
      ? Buffer.from(configured, 'hex')
      : Buffer.from(configured, 'base64');
    if (key.length !== 32) throw new Error('MAILBOARD_ENCRYPTION_KEY must be 32 bytes (hex or base64)');
    return key;
  }
  const keyPath = path.join(dataDir, '.mailboard-key');
  try {
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Stored encryption key is invalid');
  return key;
}

function createStore(dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = loadKey(dataDir);
  const db = new Database(path.join(dataDir, 'mailboard.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mailboxes (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      client_id TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      last_received_at TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS platforms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS registrations (
      platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      registered INTEGER NOT NULL CHECK (registered IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (platform_id, mailbox_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      folder TEXT NOT NULL CHECK (folder IN ('inbox', 'junk')),
      external_id TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      received_at TEXT,
      PRIMARY KEY (mailbox_id, folder, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(mailbox_id, received_at DESC);
  `);

  function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
  }

  function decrypt(value) {
    const [iv, tag, ciphertext] = String(value).split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  function saveMessages(mailboxId, folders) {
    const insert = db.prepare(`INSERT INTO messages
      (mailbox_id, folder, external_id, sender, subject, preview, body_text, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const folder of ['inbox', 'junk']) {
        db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ?').run(mailboxId, folder);
        for (const message of folders[folder] || []) {
          insert.run(mailboxId, folder, String(message.id), message.sender || '',
            message.subject || '', message.preview || '', message.bodyText || '', message.receivedAt || null);
        }
      }
      const latest = db.prepare('SELECT MAX(received_at) AS value FROM messages WHERE mailbox_id = ?').get(mailboxId).value;
      db.prepare(`UPDATE mailboxes SET last_received_at = ?, last_checked_at = ?, last_error = NULL WHERE id = ?`)
        .run(latest, new Date().toISOString(), mailboxId);
    })();
  }

  function clearMessages(mailboxId, folder) {
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ?').run(mailboxId, folder);
      const latest = db.prepare('SELECT MAX(received_at) AS value FROM messages WHERE mailbox_id = ?').get(mailboxId).value;
      db.prepare('UPDATE mailboxes SET last_received_at = ?, last_checked_at = ?, last_error = NULL WHERE id = ?')
        .run(latest, new Date().toISOString(), mailboxId);
    })();
  }

  return { db, key, encrypt, decrypt, saveMessages, clearMessages, close: () => db.close() };
}

module.exports = { createStore };
