// Scripts that call the live admin routes: they log in with the token alone, or with token + a 6-digit code they work out from the secret.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const totp = require('../lib/totp');
const { adminHeaders } = require('../scripts/admin-session');

// A stand-in for the server's /api/admin/2fa with the same rules: token first, one use per code, one step of clock drift.
function fakeServer(secret) {
  const app = express(); app.use(express.json()); let lastStep = -1; const sessions = new Set(); const calls = [];
  app.post('/api/admin/2fa', (req, res) => {
    calls.push(req.body.code);
    if (req.get('x-admin-token') !== 'right') return res.status(401).json({ error: 'Invalid admin token' });
    if (!secret) return res.json({ ok: true, required: false });
    const step = totp.verify(secret, req.body.code, { afterStep: lastStep });
    if (step == null) return res.status(401).json({ error: 'That code is not right, or was already used.' });
    lastStep = step; sessions.add('abc'); res.set('Set-Cookie', 'winai_admin=abc; Path=/; HttpOnly'); res.json({ ok: true, required: true });
  });
  return new Promise(r => { const srv = app.listen(0, () => r({ url: 'http://127.0.0.1:' + srv.address().port, srv, calls })); });
}

test('with no secret the token is sent as it is, and no login call is made', async () => {
  const s = await fakeServer(null);
  try { assert.deepEqual(await adminHeaders({ site: s.url, token: 'right', secret: '' }), { 'x-admin-token': 'right' }); assert.equal(s.calls.length, 0); } finally { s.srv.close(); }
});

test('with the secret it works out the code, logs in, and returns the token and the session cookie', async () => {
  const secret = totp.newSecret(); const s = await fakeServer(secret);
  try { const h = await adminHeaders({ site: s.url, token: 'right', secret }); assert.equal(h['x-admin-token'], 'right'); assert.equal(h.cookie, 'winai_admin=abc'); } finally { s.srv.close(); }
});

test('a second login inside the same 30 seconds uses the next code instead of failing (each code works once)', async () => {
  const secret = totp.newSecret(); const s = await fakeServer(secret);
  try { await adminHeaders({ site: s.url, token: 'right', secret }); const h = await adminHeaders({ site: s.url, token: 'right', secret }); assert.equal(h.cookie, 'winai_admin=abc'); } finally { s.srv.close(); }
});

test('a wrong token, or a secret that does not match the server, ends with a plain message and no endless retrying', async () => {
  const s = await fakeServer(totp.newSecret());
  try {
    await assert.rejects(() => adminHeaders({ site: s.url, token: 'wrong', secret: totp.newSecret() }), /refused the admin token/);
    assert.equal(s.calls.length, 1, 'stops at once on a wrong token');
  } finally { s.srv.close(); }
});
