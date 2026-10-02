'use strict';
/* Mots de passe (scrypt) et jetons de session signés (HMAC-SHA256), sans dépendance externe. */
const crypto = require('crypto');

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  JWT_SECRET non défini : un secret temporaire est utilisé (tout le monde sera déconnecté au redémarrage).');
}
const TTL = 30 * 24 * 3600 * 1000; // 30 jours

const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function sign(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() + TTL })).toString('base64url');
  return payload + '.' + hmac(payload);
}

function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

async function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verify(password, stored) {
  const [, salt, key] = String(stored || '').split('$');
  if (!salt || !key) return false;
  const k = await scrypt(String(password), Buffer.from(salt, 'hex'));
  const kb = Buffer.from(key, 'hex');
  return kb.length === k.length && crypto.timingSafeEqual(k, kb);
}

function sameCode(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { sign, verifyToken, hash, verify, sameCode };
