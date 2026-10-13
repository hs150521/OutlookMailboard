const crypto = require('node:crypto');

const SESSION_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function csrfToken(key, sessionToken) {
  return crypto.createHmac('sha256', key).update(`csrf:${sessionToken}`).digest('base64url');
}

function readCookie(request, name) {
  const parts = (request.headers.cookie || '').split(';');
  const match = parts.find((part) => part.trim().startsWith(`${name}=`));
  return match ? match.trim().slice(name.length + 1) : null;
}

function issueSession(request, response, store) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  store.db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)')
    .run(tokenHash(token), Date.now() + SESSION_AGE_MS);
  response.cookie('mailboard_session', token, {
    httpOnly: true, sameSite: 'strict', secure: request.secure,
    path: '/', maxAge: SESSION_AGE_MS,
  });
  return csrfToken(store.key, token);
}

function getSession(request, store) {
  const token = readCookie(request, 'mailboard_session');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = tokenHash(token);
  const row = store.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash);
  if (!row || row.expires_at <= Date.now()) return null;
  return { hash, csrf: csrfToken(store.key, token) };
}

function equalToken(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { hashPassword, verifyPassword, issueSession, getSession, equalToken };
