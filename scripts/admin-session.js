// Signs a script in to the live admin routes. With ADMIN_TOTP_SECRET (the admin second factor) it works out the current 6-digit code itself,
// trades token + code for a session cookie and returns the headers to use. Without the secret it sends the token only, which is all the
// server needs while the second factor is off. The secret stays on this computer (.env) and is never printed.
const totp = require('../lib/totp');

async function adminHeaders({ site, token, secret }) {
  const base = { 'x-admin-token': token };
  if (!secret) return base;
  let lastError = 'unknown';
  // A code can be used once, so a second script run in the same 30 seconds needs the next one (the server accepts one step ahead).
  for (let attempt = 0; attempt < 4; attempt++) {
    const step = totp.stepOf(Date.now()) + (attempt === 0 ? 0 : 1);
    const code = totp.codeAt(secret, step);
    const res = await fetch(site + '/api/admin/2fa', { method: 'POST', headers: { ...base, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      if (j.required === false) return base;                    // the live site has no second factor set (yet)
      const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
      if (!cookie) throw new Error('The live site accepted the code but sent no session.');
      return { ...base, cookie };
    }
    lastError = j.error || String(res.status);
    if (res.status === 401 && /token/i.test(lastError)) throw new Error('The live site refused the admin token.');
    if (res.status === 429) throw new Error(lastError);
    await new Promise(r => setTimeout(r, attempt < 1 ? 1500 : 31000));   // already used: try the next step, then wait for a fresh one
  }
  throw new Error('The live site refused the 6-digit code: ' + lastError + ' (check ADMIN_TOTP_SECRET in .env matches Railway).');
}
module.exports = { adminHeaders };
