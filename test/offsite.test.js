const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const O = require('../lib/offsite');
const { createStore } = require('../lib/db');

const KEY = 'AKIATESTKEY', SECRET = 'test-secret-key-abc', PASS = 'correct horse battery staple';

test('signing matches the example AWS publishes', () => {
  const r = O.signRequest({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' }, accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});
test('a backup is encrypted: unreadable without the passphrase, and any change is noticed', () => {
  const plain = Buffer.from('SQLite format 3\0 emails and hashes '.repeat(50));
  const blob = O.encryptBackup(plain, PASS);
  assert.ok(!blob.includes('emails and hashes'));
  assert.deepEqual(O.decryptBackup(blob, PASS), plain);
  assert.throws(() => O.decryptBackup(blob, 'a different passphrase'), /passphrase is wrong/);
  const t = Buffer.from(blob); t[t.length - 5] ^= 1;
  assert.throws(() => O.decryptBackup(t, PASS), /damaged/);
  assert.throws(() => O.decryptBackup(Buffer.from('not a backup at all, just text'), PASS), /not a WIN AI backup/);
  assert.notDeepEqual(O.encryptBackup(plain, PASS), blob);                                // fresh salt and iv every time
  assert.throws(() => O.encryptBackup(plain, 'short'), /at least 12/);
});

// A small stand-in bucket that checks every signature the way a real one does.
function fakeBucket() {
  const objects = new Map(); const log = []; let badSigs = 0;
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks); const url = `http://${req.headers.host}${req.url}`;
      const auth = req.headers.authorization || '';
      const date = new Date(Date.parse(req.headers['x-amz-date'].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')));
      const signed = (/SignedHeaders=([^,]+)/.exec(auth) || [])[1]?.split(';') || [];
      const hdrs = Object.fromEntries(signed.filter(n => n !== 'host' && !n.startsWith('x-amz-')).map(n => [n, req.headers[n]]));
      const expect = O.signRequest({ method: req.method, url, headers: hdrs, body, accessKeyId: KEY, secretAccessKey: SECRET, region: 'auto', date });
      if (expect.headers.authorization !== auth || (req.headers['x-amz-content-sha256'] !== expect.headers['x-amz-content-sha256'])) { badSigs++; res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
      const u = new URL(url), key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ''));
      log.push(`${req.method} ${key || '(list)'}`);
      if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && !key) {
        const prefix = u.searchParams.get('prefix') || '';
        const xml = '<ListBucketResult>' + [...objects.keys()].filter(k => k.startsWith(prefix)).map(k => `<Contents><Key>${k}</Key><LastModified>2026-10-12T00:00:00.000Z</LastModified><Size>${objects.get(k).length}</Size></Contents>`).join('') + '</ListBucketResult>';
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(xml);
      }
      if (req.method === 'GET') { if (!objects.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); } res.writeHead(200); return res.end(objects.get(key)); }
      res.writeHead(405); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, objects, log, port: server.address().port, badSigs: () => badSigs })));
}
function makeDb(file, users = 2) {
  const store = createStore({ dbPath: file });
  for (let i = 0; i < users; i++) store.createUser(`u${i}@example.com`, new Date().toISOString(), new Date().toISOString(), { name: 'U', passwordHash: 'x' });
  store.close();
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'winai-offsite-test-'));

test('upload, list, retention and a full restore test against a bucket that checks signatures', async () => {
  const b = await fakeBucket(); const dir = tmp(); const db = path.join(dir, 'a.db'); makeDb(db, 3);
  let day = Date.parse('2026-10-01T12:00:00Z');
  const make = (over = {}) => O.createOffsite({ endpoint: `http://127.0.0.1:${b.port}`, bucket: 'bucket', accessKeyId: KEY, secretAccessKey: SECRET, passphrase: PASS, keep: 3, now: () => day, ...over });
  const off = make();
  assert.equal(off.configured, true);
  for (let i = 0; i < 5; i++) { const r = await off.upload(db); assert.match(r.key, /^winai\/winai-2026-10-0\d\.db\.enc$/); day += 24 * 3600e3; }
  const keys = (await off.list()).map(o => o.key);
  assert.deepEqual(keys, ['winai/winai-2026-10-03.db.enc', 'winai/winai-2026-10-04.db.enc', 'winai/winai-2026-10-05.db.enc']);   // only the newest 3 remain
  assert.ok(![...b.objects.values()].some(v => v.includes('u0@example.com')));                  // nothing readable is stored
  const v = await off.verifyLatest();
  assert.equal(v.ok, true); assert.equal(v.users, 3); assert.equal(v.copies, 3); assert.equal(v.key, 'winai/winai-2026-10-05.db.enc');
  assert.equal(b.badSigs(), 0);
  // a wrong passphrase cannot restore, and says so
  await assert.rejects(() => make({ passphrase: 'another long passphrase' }).verifyLatest(), /passphrase is wrong/);
  b.server.close();
});
test('wrong keys are refused by the bucket, and the error says what happened', async () => {
  const b = await fakeBucket(); const dir = tmp(); const db = path.join(dir, 'a.db'); makeDb(db);
  const off = O.createOffsite({ endpoint: `http://127.0.0.1:${b.port}`, bucket: 'bucket', accessKeyId: KEY, secretAccessKey: 'wrong', passphrase: PASS });
  await assert.rejects(() => off.upload(db), /Uploading the backup failed \(403.*SignatureDoesNotMatch/);
  assert.equal(b.objects.size, 0); b.server.close();
});
test('the restore test catches a copy that is not a real database, and an empty bucket', async () => {
  const b = await fakeBucket(); const dir = tmp();
  const off = O.createOffsite({ endpoint: `http://127.0.0.1:${b.port}`, bucket: 'bucket', accessKeyId: KEY, secretAccessKey: SECRET, passphrase: PASS });
  await assert.rejects(() => off.verifyLatest(), /no offsite copies/);
  const junk = path.join(dir, 'junk.db'); fs.writeFileSync(junk, 'this is not sqlite at all'.repeat(100));
  await off.upload(junk);
  await assert.rejects(() => off.verifyLatest(), /damaged|not a database|file is not/i);
  const bad = path.join(dir, 'empty.db'); const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(bad); d.exec('CREATE TABLE x(a)'); d.close();
  await off.upload(bad, { name: 'winai-2099-01-01.db' });
  await assert.rejects(() => off.verifyLatest(), /missing/);
  b.server.close();
});
test('not configured: nothing is attempted', async () => {
  const off = O.createOffsite({ endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', passphrase: '' });
  assert.equal(off.configured, false);
  await assert.rejects(() => off.upload('/nope'), /not set up/);
  await assert.rejects(() => off.verifyLatest(), /not set up/);
});
