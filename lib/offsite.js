// Offsite backups: an encrypted copy of the database in any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3...),
// and a restore test that proves a copy can really be brought back. No SDK: requests are signed here (AWS Signature V4).
//
// The database holds emails and password hashes, so a copy is compressed and then encrypted (AES-256-GCM, key from
// BACKUP_PASSPHRASE) BEFORE it leaves the server. Whoever holds the bucket cannot read it without the passphrase.
// Keep that passphrase somewhere other than this server, or the copies are no use after a disaster.
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAGIC = Buffer.from('WINAIBK1');
const sha256hex = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// ── encryption ──
function encryptBackup(buf, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('BACKUP_PASSPHRASE must be at least 12 characters');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(buf)), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
function decryptBackup(blob, passphrase) {
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + 44 || !blob.subarray(0, 8).equals(MAGIC)) throw new Error('This is not a WIN AI backup file');
  const salt = blob.subarray(8, 24), iv = blob.subarray(24, 36), tag = blob.subarray(36, 52), body = blob.subarray(52);
  const key = crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  try { return zlib.gunzipSync(Buffer.concat([d.update(body), d.final()])); }
  catch (_) { throw new Error('Could not decrypt the backup. The passphrase is wrong or the file is damaged.'); }
}

// ── AWS Signature V4 (path-style URLs: endpoint/bucket/key) ──
function signRequest({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(h).sort();
  const canonicalQuery = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalPath = u.pathname.split('/').map(seg => enc(decodeURIComponent(seg))).join('/') || '/';
  const canonical = [method, canonicalPath, canonicalQuery, names.map(n => `${n}:${h[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { headers: h, signature, canonical };
}

// ── the client ──
function createOffsite({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', prefix = 'winai/', passphrase, fetchImpl = fetch, now = () => Date.now(), keep = 14 }) {
  const configured = !!(endpoint && bucket && accessKeyId && secretAccessKey && passphrase);
  const base = String(endpoint || '').replace(/\/+$/, '');
  const pre = prefix ? prefix.replace(/^\/+/, '').replace(/\/?$/, '/') : '';
  async function call(method, key, { body = '', query = '', headers = {} } = {}) {
    const url = `${base}/${bucket}${key ? '/' + key.split('/').map(enc).join('/') : ''}${query ? '?' + query : ''}`;
    const s = signRequest({ method, url, headers, body, accessKeyId, secretAccessKey, region, date: new Date(now()) });
    const res = await fetchImpl(url, { method, headers: s.headers, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(120000) });
    return res;
  }
  const fail = async (what, res) => { const t = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); return new Error(`${what} failed (${res.status}${t ? ': ' + t : ''})`); };

  async function list() {
    const res = await call('GET', '', { query: `list-type=2&prefix=${enc(pre)}` });
    if (!res.ok) throw await fail('Listing the backups', res);
    const xml = await res.text();
    return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(m => ({ key: /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1], size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0), modified: /<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] }))
      .filter(o => o.key && /winai-\d{4}-\d{2}-\d{2}\.db\.enc$/.test(o.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  // Encrypts a database file and uploads it, then removes copies beyond the newest `keep`.
  async function upload(file, { name } = {}) {
    if (!configured) throw new Error('Offsite backups are not set up');
    const day = new Date(now()).toISOString().slice(0, 10), key = `${pre}${name || `winai-${day}.db`}.enc`;
    const blob = encryptBackup(fs.readFileSync(file), passphrase);
    const res = await call('PUT', key, { body: blob, headers: { 'content-type': 'application/octet-stream' } });
    if (!res.ok) throw await fail('Uploading the backup', res);
    let removed = 0;
    try { const all = await list(); for (const o of all.slice(0, Math.max(0, all.length - keep))) { const d = await call('DELETE', o.key); if (d.ok || d.status === 404) removed++; } } catch (_) { /* old copies are tidied next time */ }
    return { key, bytes: blob.length, removed };
  }
  async function download(key) {
    const res = await call('GET', key);
    if (!res.ok) throw await fail('Downloading the backup', res);
    return Buffer.from(await res.arrayBuffer());
  }
  // The restore test: fetch the newest copy, decrypt it, open it as a database and check it. Nothing live is touched.
  async function verifyLatest({ openDb } = {}) {
    if (!configured) throw new Error('Offsite backups are not set up');
    const all = await list();
    if (!all.length) throw new Error('There are no offsite copies to test');
    const newest = all[all.length - 1];
    const plain = decryptBackup(await download(newest.key), passphrase);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'winai-restore-')), 'restored.db');
    try {
      fs.writeFileSync(tmp, plain);
      const info = (openDb || defaultOpen)(tmp);
      if (!info.ok) throw new Error(`The restored copy is damaged: ${info.problem}`);
      return { ok: true, key: newest.key, bytes: plain.length, users: info.users, picks: info.picks, copies: all.length };
    } finally { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch (_) {} }
  }
  return { configured, list, upload, download, verifyLatest, prefix: pre };
}

// Opens a restored file read-only and runs SQLite's own checks.
function defaultOpen(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const chk = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
    if (chk.length !== 1 || chk[0] !== 'ok') return { ok: false, problem: String(chk[0] || 'unknown') };
    const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    if (!has('picks') || !has('users')) return { ok: false, problem: 'the picks or users table is missing' };
    return { ok: true, users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n, picks: db.prepare('SELECT COUNT(*) AS n FROM picks').get().n };
  } finally { db.close(); }
}

module.exports = { createOffsite, encryptBackup, decryptBackup, signRequest, defaultOpen };
