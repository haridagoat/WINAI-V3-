// Live attack suite. Run it with scripts/redteam.sh, which starts a throwaway server (own database, blank outside keys).
// Every line says whether the app defended itself. A FAIL is a real problem or a test that needs updating.
const http = require('http'), zlib = require('zlib'), path = require('path');
const PORT = Number(process.env.RT_PORT || 3081), B = `http://localhost:${PORT}`, ADM = { 'x-admin-token': process.env.RT_ADMIN_TOKEN || 'audit-token-123' }, PW = 'bluejay-sunrise-42';
const T = require(path.join(__dirname, '..', '..', 'lib', 'totp'));
const TOTP_SECRET = process.env.RT_TOTP_SECRET || 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
let pass = 0, fail = 0; const bad = [];
const ok = (n, c, x = '') => { c ? pass++ : (fail++, bad.push(n)); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '   <-- ' + x}`); };
const note = m => console.log('NOTE  ' + m);
const call = async (m, p, { body, h = {}, cookie = '' } = {}) => { const r = await fetch(B + p, { method: m, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...h }, body: body !== undefined ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (_) { j = t; } return { s: r.status, j, h: r.headers }; };
const person = () => { const p = { cookie: '' }; p.call = async (m, path_, o = {}) => { const r = await call(m, path_, { ...o, cookie: p.cookie }); const sc = r.h.get('set-cookie'); if (sc) p.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0]; return r; }; p.up = e => p.call('POST', '/api/auth/signup', { body: { name: 'Test', email: e, password: PW, ageConfirmed: true } }); return p; };
const raw = (opts, body) => new Promise(res => { const r = http.request({ host: 'localhost', port: PORT, ...opts }, rs => { const c = []; rs.on('data', d => c.push(d)); rs.on('end', () => res({ s: rs.statusCode, t: Buffer.concat(c).toString() })); }); r.on('error', e => res({ s: 0, t: String(e.message) })); r.setTimeout(8000, () => { r.destroy(); res({ s: -1, t: 'timeout' }); }); if (body) r.write(body); r.end(); });
const alive = async () => (await call('GET', '/api/ping')).s === 200;
const code = (off = 0) => T.codeAt(TOTP_SECRET, T.stepOf(Date.now()) + off);

(async () => {
  console.log('--- 1. compressed / malformed bodies');
  const gz = zlib.gzipSync(JSON.stringify({ email: 'a@b.co', password: 'x' }));
  let r = await raw({ method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, Buffer.concat([gz, Buffer.from('TRAILING-JUNK')]));
  ok('gzip body with trailing bytes is refused, server survives', r.s === 415 && await alive(), JSON.stringify(r));
  r = await raw({ method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json', 'content-encoding': 'br' } }, 'xx'); ok('brotli body refused', r.s === 415 && await alive(), JSON.stringify(r));
  r = await raw({ method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } }, '{"a":' + '['.repeat(5000)); ok('deeply nested JSON refused', [400, 413].includes(r.s) && await alive(), JSON.stringify(r).slice(0, 120));
  const big = '{"x":"' + 'a'.repeat(300000) + '"}'; r = await raw({ method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) } }, big); ok('oversized body refused', [400, 413, 0].includes(r.s) && await alive(), String(r.s));

  console.log('--- 2. responsible-gambling endpoints');
  const A = person(), Bp = person(); await A.up('ra@example.com'); await Bp.up('rb@example.com');
  const lim = async v => (await A.call('POST', '/api/account/rg/limit', { body: { limit: v } }));
  for (const v of ['5', [5], { a: 1 }, true, 'abc', 1e308, -0, 0, 100.5, 101, false]) { const x = await lim(v); ok(`limit ${JSON.stringify(v)} is refused`, x.s === 400, JSON.stringify(x.j)); }
  ok('limit 5 still accepted after the junk', (await lim(5)).j.dailyLimit === 5);
  r = await A.call('POST', '/api/account/rg/break', { body: { kind: 'break', amount: '24' } }); note('break amount as string "24" -> ' + r.s);
  r = await A.call('POST', '/api/account/rg/break', { body: { kind: ['break'], amount: 24 } }); ok('kind as array refused', r.s === 400, JSON.stringify(r.j));
  r = await A.call('POST', '/api/account/rg/break', { body: { kind: 'break', amount: 24, __proto__: { restricted: true } } }); ok('proto keys do not break anything', [200, 400].includes(r.s) && await alive());
  ok("a second person is not affected by the first person's break", (await Bp.call('GET', '/api/account/rg')).j.restricted === false);
  r = await A.call('POST', '/api/account/rg/limit', { body: { limit: 5 }, h: { Origin: 'https://evil.example' } }); ok('cross-site post refused', r.s === 403);
  r = await A.call('POST', '/api/account/rg/limit', { body: { limit: 5 }, h: { 'Sec-Fetch-Site': 'cross-site' } }); ok('cross-site fetch metadata refused', r.s === 403);
  r = await call('GET', '/api/account/rg'); ok('guests cannot read settings', r.s === 401);
  ok('no endpoint accepts a user id to touch someone else', (await A.call('POST', '/api/account/rg/limit', { body: { limit: 2, userId: 999, user_id: 999 } })).s === 200 && (await Bp.call('GET', '/api/account/rg')).j.dailyLimit === null);
  r = await call('POST', '/api/analyze', { body: { prompt: 'Analyze this prop please', kind: 'prop' } }); note('signed-out visitor analyzing while the paywall is off -> ' + r.s + ' (self-set limits only follow the account)');

  console.log('--- 3. the limit race: overlapping analyses');
  const R = person(); await R.up('race@example.com'); await R.call('POST', '/api/account/rg/limit', { body: { limit: 1 } });
  const flights = [];
  for (let i = 0; i < 8; i++) {
    const st = await R.call('POST', '/api/analysis/start', { body: {} });
    if (st.s === 200 && st.j.ticket) flights.push(R.call('POST', '/api/analyze', { body: { prompt: 'Analyze this prop please', kind: 'prop' }, h: { 'X-Analysis-Ticket': st.j.ticket } }));
  }
  const done = await Promise.all(flights); const okN = done.filter(x => x.s === 200).length;
  ok(`a limit of 1 allows only 1 analysis even when started back to back (${okN} of ${flights.length} started)`, okN <= 1, `${okN} succeeded`);

  console.log('--- 4. admin: second factor and route exposure');
  for (const p of ['/api/admin/errors', '/API/ADMIN/ERRORS', '/api/admin/errors/', '/api/admin//errors', '/api/admin/errors?x=1', '/api/%61dmin/errors', '/api/admin/users', '/api/admin/checks', '/api/admin/health']) { const x = await call('GET', p, { h: ADM }); ok(`token alone gets nothing from ${p}`, x.s !== 200, x.s); }
  r = await call('GET', '/api/admin/errors', { h: ADM, cookie: 'winai_admin=' + 'a'.repeat(43) }); ok('forged admin cookie refused', r.s === 401);
  r = await call('GET', '/api/admin/errors', { h: { 'x-admin-token': (ADM['x-admin-token']) + ' ' } }); ok('token with trailing space refused', r.s === 401);
  r = await call('GET', '/api/admin/errors', { h: { ...ADM, 'x-admin-code': '000000' } }); ok('a code header does nothing', r.s === 401);
  r = await call('GET', '/api/admin/errors?token=' + ADM['x-admin-token'] + '&code=' + code()); ok('token and code in the query string do nothing', r.s === 401);
  r = await call('POST', '/api/admin/2fa', { h: ADM, body: { code: [code()] } }); ok('code as an array refused', r.s === 401);
  r = await call('POST', '/api/admin/2fa', { h: ADM, body: { code: code() + '0' } }); ok('7-digit code refused', r.s === 401);
  const good = await call('POST', '/api/admin/2fa', { h: ADM, body: { code: code() } }); ok('right token + code signs in', good.s === 200);
  const ck = (good.h.get('set-cookie') || '').split(';')[0];
  r = await call('GET', '/api/admin/errors', { h: ADM, cookie: ck }); ok('session works', r.s === 200);
  r = await call('GET', '/api/admin/errors', { h: { 'x-admin-token': 'wrong' }, cookie: ck }); ok('session cookie without the token is refused', r.s === 401);
  r = await call('POST', '/api/admin/signout', { cookie: ck }); r = await call('GET', '/api/admin/errors', { h: ADM, cookie: ck }); ok('sign-out kills the session', r.s === 401);

  console.log('--- 5. errors and browser reports');
  const xss = '<img src=x onerror=alert(1)>"><script>alert(2)</script> maya@example.com Bearer abcdef123456 sk-ant-api03-ABCDEFGHIJKLMNOP';
  r = await call('POST', '/api/client-error', { body: { message: xss, at: '</script><svg onload=1>', page: '/<script>' } }); ok('hostile browser report accepted quietly', r.s === 204);
  const s2 = await call('POST', '/api/admin/2fa', { h: ADM, body: { code: code(1) } }); const ck2 = (s2.h.get('set-cookie') || '').split(';')[0];
  const errs = await call('GET', '/api/admin/errors', { h: ADM, cookie: ck2 });
  const blob = JSON.stringify(errs.j); ok('stored report has the email, key and token removed', !/maya@|abcdef123456|ABCDEFGHIJKLMNOP/.test(blob), blob.slice(0, 200));
  for (let i = 0; i < 12; i++) await call('POST', '/api/client-error', { body: { message: 'flood ' + i } });
  r = await call('POST', '/api/client-error', { body: { message: 'x' } }); ok('flooding one source is rate limited', r.s === 429);
  r = await call('POST', '/api/client-error', { body: { message: 'evil' }, h: { Origin: 'https://evil.example' } }); ok('other sites cannot post reports', r.s === 403 || r.s === 429);

  console.log('--- 6. public endpoints leak nothing private');
  for (const p of ['/api/health', '/api/data-status', '/api/ping', '/api/auth/me', '/api/today', '/api/wnba/today', '/api/clv', '/api/debug']) { const x = await call('GET', p); const t = JSON.stringify(x.j); ok(`${p} shows no secrets or emails`, !/(@[a-z0-9-]+\.[a-z]{2,})|password_hash|apiKey|sk-ant-|ODDS_API_KEY|STRIPE_|whsec_|secret|token/i.test(t), t.slice(0, 200)); }
  for (const f of ['/.env', '/server.js', '/winai.db', '/lib/auth.js', '/package.json', '/season_meta.json', '/../.env', '/%2e%2e/.env', '/public/../.env']) { const x = await raw({ method: 'GET', path: f }); ok(`${f} is not served`, x.s !== 200 || !/ANTHROPIC|createAuth|SQLite format|"name"/.test(x.t), `${x.s} ${x.t.slice(0, 60)}`); }

  console.log('--- 7. parameter fuzzing');
  const evil = ['../../etc/passwd', '`id`', '$(id)', '; ls', '--help', 'a'.repeat(5000), '\n\r', '\u0000', '%00', '{"$ne":1}'];
  for (const e of evil) { const x = await call('GET', `/api/nba-bridge?player=${encodeURIComponent(e)}&season=${encodeURIComponent(e)}`); ok(`bridge handles ${JSON.stringify(e).slice(0, 24)}`, x.s !== 500 || typeof x.j === 'object', x.s); }
  ok('server alive after fuzzing', await alive());
  for (const q of ['propType=__proto__', 'propType=constructor', 'player=%00&propType=points', 'line=1e999&propType=3pm', 'line=-1&propType=3pm', 'line=NaN&propType=blocks']) { const x = await call('GET', `/api/prop-context?${q}&opponent=Heat`); ok(`prop-context ${q} does not crash`, x.s < 500 || x.s === 503, x.s); }
  ok('server alive after prop fuzzing', await alive());

  console.log('--- 8. passwords and sessions');
  const P = person(); await P.up('pw@example.com'); const P2 = person(); await P2.call('POST', '/api/auth/login', { body: { email: 'pw@example.com', password: PW } });
  for (let i = 0; i < 7; i++) r = await P.call('POST', '/api/account/password', { body: { current: 'wrong-' + i + '-xxxxxx', password: 'green-harbor-lantern-77' } });
  ok('guessing the current password locks', r.s === 429, JSON.stringify(r.j));
  r = await P.call('POST', '/api/account/password', { body: { current: PW, password: 'green-harbor-lantern-77' } }); ok('even the right one is paused while locked', r.s === 429);
  ok('the other session is still valid (nothing changed)', (await P2.call('GET', '/api/auth/me')).j.user?.email === 'pw@example.com');
  r = await P.call('POST', '/api/account/sign-out-others', { body: {} }); ok('sign-out-others works', r.s === 200 && (await P2.call('GET', '/api/auth/me')).j.user === null);
  r = await P.call('POST', '/api/account/password', { body: { current: [PW], password: ['x'] } }); ok('array passwords refused, not crashed', r.s >= 400 && r.s < 500 && await alive(), r.s);

  console.log(`\n${pass} defended, ${fail} problems${fail ? ': ' + bad.join(' | ') : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
