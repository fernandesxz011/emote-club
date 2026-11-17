import {scrypt as nativeScrypt} from 'node:crypto';

export const SESSION_TTL = {temporary: 12 * 60 * 60 * 1000, remembered: 30 * 24 * 60 * 60 * 1000};
export const PASSWORD_SCRYPT = {N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024};
const authEncoder = new TextEncoder();
const dummySalt = new Uint8Array(16);
let activePasswordOperations = 0;

export class AuthError extends Error {
  constructor(message, status = 400, code, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unbase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoded hash');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', authEncoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function deriveScrypt(password, salt) {
  if (activePasswordOperations >= 2) throw new AuthError('O acesso está ocupado por um instante. Tente novamente em alguns segundos.', 503, 'AUTH_BUSY');
  activePasswordOperations++;
  try {
    return new Uint8Array(await new Promise((resolve, reject) => {
      nativeScrypt(authEncoder.encode(password), salt, 64, PASSWORD_SCRYPT, (error, derived) => error ? reject(error) : resolve(derived));
    }));
  } finally { activePasswordOperations--; }
}

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await deriveScrypt(password, salt);
  return `scrypt$${PASSWORD_SCRYPT.N}$${PASSWORD_SCRYPT.r}$${PASSWORD_SCRYPT.p}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const fields = typeof stored === 'string' ? stored.split('$') : [];
  if (fields.length !== 6 || fields[0] !== 'scrypt' || Number(fields[1]) !== PASSWORD_SCRYPT.N || Number(fields[2]) !== PASSWORD_SCRYPT.r || Number(fields[3]) !== PASSWORD_SCRYPT.p) throw new AuthError('Não foi possível verificar esta conta agora. Tente novamente em instantes.', 503);
  let salt, expected;
  try { salt = unbase64url(fields[4]); expected = unbase64url(fields[5]); } catch { throw new AuthError('Não foi possível verificar esta conta agora. Tente novamente em instantes.', 503); }
  if (salt.length !== 16 || expected.length !== 64) throw new AuthError('Não foi possível verificar esta conta agora. Tente novamente em instantes.', 503);
  return constantTimeEqual(await deriveScrypt(password, salt), expected);
}

function requireDatabase(db) {
  if (!db) throw new AuthError('O acesso à sua conta está temporariamente indisponível. Tente novamente em instantes.', 503);
}

export function normalizedUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateCredentials(body, registering = false) {
  const username = normalizedUsername(body.username);
  if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new AuthError('Use um usuário de 3 a 24 letras, números ou sublinhados.');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new AuthError('A senha precisa ter entre 12 e 128 caracteres.');
  if (body.remember !== undefined && typeof body.remember !== 'boolean') throw new AuthError('A opção de manter o acesso precisa ser verdadeira ou falsa.');
  let displayName;
  if (registering) {
    displayName = typeof body.displayName === 'string' ? body.displayName.trim().replace(/\s+/g, ' ') : '';
    if (displayName.length < 2 || displayName.length > 50 || /[\u0000-\u001f\u007f]/.test(displayName)) throw new AuthError('Escolha um nome com 2 a 50 caracteres.');
  }
  return {username, password: body.password, remember: body.remember === true, displayName};
}

async function consumeBucket(db, key, limit, windowMs, now) {
  const bucketKey = await sha256(key);
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const expiresAt = windowStart + windowMs;
  const result = await db.prepare('INSERT INTO auth_rate_limits (bucket_key, window_start, attempts, expires_at) VALUES (?, ?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET attempts = CASE WHEN auth_rate_limits.window_start = excluded.window_start THEN auth_rate_limits.attempts + 1 ELSE 1 END, window_start = excluded.window_start, expires_at = excluded.expires_at RETURNING attempts, expires_at').bind(bucketKey, windowStart, expiresAt).first();
  if (!result || !Number.isInteger(result.attempts)) throw new AuthError('Não foi possível verificar o limite de acesso agora. Tente novamente em instantes.', 503);
  if (result.attempts > limit) throw new AuthError('Muitas tentativas de acesso. Aguarde um pouco antes de tentar novamente.', 429, 'RATE_LIMITED', Math.max(1, Math.ceil((result.expires_at - now) / 1000)));
}

async function limitAttempts(db, request, action, username, now) {
  // Bound maintenance work so expired authentication records cannot grow indefinitely.
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at <= ? LIMIT 100)').bind(new Date(now).toISOString()),
    db.prepare('DELETE FROM auth_rate_limits WHERE bucket_key IN (SELECT bucket_key FROM auth_rate_limits WHERE expires_at <= ? LIMIT 100)').bind(now),
  ]);
  // Cloudflare replaces this header at the edge; never accept an IP supplied in JSON.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (action === 'register') {
    await consumeBucket(db, `register:ip:${ip}`, 20, 60 * 60 * 1000, now);
  } else {
    await consumeBucket(db, `login:ip:${ip}`, 100, 15 * 60 * 1000, now);
    await consumeBucket(db, `login:username:${username}`, 10, 15 * 60 * 1000, now);
  }
}

async function newSession(accountId, remember, now) {
  const token = base64url(randomBytes(32));
  return {token, tokenHash: await sha256(token), accountId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + (remember ? SESSION_TTL.remembered : SESSION_TTL.temporary)).toISOString()};
}

export async function registerAccount(db, request, body, now = Date.now()) {
  requireDatabase(db);
  const fields = validateCredentials(body, true);
  await limitAttempts(db, request, 'register', fields.username, now);
  const existing = await db.prepare('SELECT id FROM accounts WHERE username = ?').bind(fields.username).first();
  if (existing) throw new AuthError('Este usuário já está em uso. Escolha outro nome de usuário.', 409, 'USERNAME_TAKEN');
  const passwordHash = await hashPassword(fields.password);
  const id = `acct_${crypto.randomUUID()}`;
  const session = await newSession(id, fields.remember, now);
  const createdAt = new Date(now).toISOString();
  try {
    await db.batch([
      db.prepare('INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').bind(id, fields.username, passwordHash, createdAt),
      db.prepare('INSERT INTO profiles (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, fields.displayName, createdAt, createdAt),
      db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(session.tokenHash, id, session.createdAt, session.expiresAt),
    ]);
  } catch (error) {
    if (/unique.*accounts\.username/i.test(String(error?.message))) throw new AuthError('Este usuário já está em uso. Escolha outro nome de usuário.', 409, 'USERNAME_TAKEN');
    throw error;
  }
  return {token: session.token, expiresAt: session.expiresAt, user: {id, username: fields.username, name: fields.displayName}};
}

export async function loginAccount(db, request, body, now = Date.now()) {
  requireDatabase(db);
  const fields = validateCredentials(body);
  await limitAttempts(db, request, 'login', fields.username, now);
  const account = await db.prepare('SELECT id, username, password_hash FROM accounts WHERE username = ?').bind(fields.username).first();
  if (!account) {
    // Unknown users perform the same expensive KDF as valid accounts.
    constantTimeEqual(await deriveScrypt(fields.password, dummySalt), new Uint8Array(64));
    throw new AuthError('Usuário ou senha incorretos.', 401, 'BAD_CREDENTIALS');
  }
  if (!await verifyPassword(fields.password, account.password_hash)) throw new AuthError('Usuário ou senha incorretos.', 401, 'BAD_CREDENTIALS');
  const session = await newSession(account.id, fields.remember, now);
  await db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(session.tokenHash, account.id, session.createdAt, session.expiresAt).run();
  return {token: session.token, expiresAt: session.expiresAt, user: {id: account.id, username: account.username, name: account.username}};
}

function bearerToken(request) {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  return authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] || null;
}

export async function sessionIdentity(request, db, now = Date.now()) {
  const token = bearerToken(request);
  if (!token) return null;
  requireDatabase(db);
  const row = await db.prepare('SELECT accounts.id, accounts.username, profiles.display_name FROM sessions JOIN accounts ON accounts.id = sessions.account_id LEFT JOIN profiles ON profiles.user_id = accounts.id WHERE sessions.token_hash = ? AND sessions.expires_at > ?').bind(await sha256(token), new Date(now).toISOString()).first();
  return row ? {id: row.id, username: row.username, name: row.display_name || row.username} : null;
}

export async function logoutAccount(db, request) {
  requireDatabase(db);
  const token = bearerToken(request);
  if (!token) throw new AuthError('Entre na sua conta para encerrar esta sessão.', 401);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return {ok: true};
}
