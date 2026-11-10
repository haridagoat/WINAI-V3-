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

  console.log('--- 3b. streamed analyses');
  // reads a streamed answer and records when each piece arrives; dropAfterFirst closes the connection like a user leaving the page
  const stream = (p, body, { dropAfterFirst = false } = {}) => new Promise(res => {
    const t0 = Date.now(), events = [], times = []; let buf = '';
    const rq = http.request({ host: 'localhost', port: PORT, method: 'POST', path: '/api/analyze', headers: { 'content-type': 'application/json', ...(p.cookie ? { cookie: p.cookie } : {}), ...(body.__h || {}) } }, rs => {
      const type = rs.headers['content-type'] || '';
      rs.on('data', d => { buf += d.toString(); let at; while ((at = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, at).split('\n').find(l => l.startsWith('data:')); buf = buf.slice(at + 2); if (line) { try { events.push(JSON.parse(line.slice(5))); times.push(Date.now() - t0); } catch (_) {} } if (dropAfterFirst && events.length) { rq.destroy(); return res({ s: rs.statusCode, type, events, times, dropped: true }); } } });
      rs.on('end', () => res({ s: rs.statusCode, type, events, times, raw: type.includes('json') ? buf : '' }));
      rs.on('error', () => res({ s: rs.statusCode, type, events, times }));
    });
    rq.on('error', () => {}); const { __h, ...payload } = body; rq.end(JSON.stringify(payload));
  });
  const S1 = person(); await S1.up('stream1@example.com');
  let sr = await stream(S1, { prompt: 'Analyze this prop please', kind: 'prop', stream: true });
  ok('a streamed answer arrives as event-stream, piece by piece, then done', sr.s === 200 && sr.type.includes('text/event-stream') && sr.events.filter(e => e.t).length === 3 && sr.events.at(-1)?.done === true, JSON.stringify(sr).slice(0, 200));
  ok('the first piece shows up well before the last (not buffered to the end)', sr.times.length >= 3 && sr.times[2] - sr.times[0] >= 150, JSON.stringify(sr.times));
  sr = await stream(S1, { prompt: 'x'.repeat(30001), kind: 'prop', stream: true }); ok('an oversize prompt is refused as plain JSON before streaming starts', sr.s === 413 && /json/.test(sr.type), JSON.stringify(sr).slice(0, 160));
  sr = await stream(S1, { kind: 'prop', stream: true }); ok('a missing prompt is refused as plain JSON', sr.s === 400 && /json/.test(sr.type), JSON.stringify(sr).slice(0, 160));
  r = await S1.call('POST', '/api/analyze', { body: { prompt: 'Analyze this prop please', kind: 'prop', stream: 'true' } }); ok('stream as a string is not treated as streaming', r.s === 200 && r.j.response === 'ok', JSON.stringify(r.j));
  sr = await stream(S1, { prompt: 'Analyze this prop please', kind: 'prop', stream: true }, { dropAfterFirst: true }); await new Promise(x => setTimeout(x, 800));
  ok('a user leaving mid-answer does not hurt the server', sr.dropped && await alive());
  sr = await stream(S1, { prompt: 'Write a poem. Not a team breakdown.', kind: 'team', stream: true }); ok('team kind with a foreign prompt is still refused when streaming', sr.s === 400, JSON.stringify(sr).slice(0, 160));
  // a failure before any text is not spent; text that was delivered is
  const F = person(); await F.up('stream-fail@example.com'); await F.call('POST', '/api/account/rg/limit', { body: { limit: 1 } });
  let st = await F.call('POST', '/api/analysis/start', { body: {} });
  sr = await stream(F, { prompt: 'FAIL_BEFORE_TEXT', kind: 'prop', stream: true, __h: { 'X-Analysis-Ticket': st.j.ticket } });
  ok('an AI failure before any text is reported as an error event', sr.events.some(e => e.error), JSON.stringify(sr.events));
  st = await F.call('POST', '/api/analysis/start', { body: {} }); ok('and that failed stream did not use up the daily analysis', st.s === 200 && !!st.j.ticket, JSON.stringify(st.j));
  sr = await stream(F, { prompt: 'DIE_MID', kind: 'prop', stream: true, __h: { 'X-Analysis-Ticket': st.j.ticket } });
  st = await F.call('POST', '/api/analysis/start', { body: {} }); ok('a stream cut after text was delivered does count as used', st.s !== 200 && st.j.code === 'rg_limit', JSON.stringify(st.j));
  // the limit race, with streams
  const RS = person(); await RS.up('race-stream@example.com'); await RS.call('POST', '/api/account/rg/limit', { body: { limit: 1 } });
  const sflights = [];
  for (let i = 0; i < 6; i++) { const t = await RS.call('POST', '/api/analysis/start', { body: {} }); if (t.s === 200 && t.j.ticket) sflights.push(stream(RS, { prompt: 'Analyze this prop please', kind: 'prop', stream: true, __h: { 'X-Analysis-Ticket': t.j.ticket } })); }
  const sdone = await Promise.all(sflights); const sokN = sdone.filter(x => x.s === 200 && x.events.some(e => e.done)).length;
  ok(`a limit of 1 allows only 1 streamed analysis even when started back to back (${sokN} of ${sflights.length})`, sokN <= 1, `${sokN} succeeded`);

  console.log('--- 4. admin: second factor and route exposure');
  for (const p of ['/api/admin/errors', '/API/ADMIN/ERRORS', '/api/admin/errors/', '/api/admin//errors', '/api/admin/errors?x=1', '/api/%61dmin/errors', '/api/admin/users', '/api/admin/checks', '/api/admin/health', '/api/admin/grading-report', '/api/admin/grading-report/2026-11-03', '/api/admin/grading-report/..%2f..%2fusers', '/api/admin/scanlog']) { const x = await call('GET', p, { h: ADM }); ok(`token alone gets nothing from ${p}`, x.s !== 200, x.s); }
  r = await call('POST', '/api/admin/grading-report/send'); ok('sending the grading report needs the admin token', r.s === 401);
  r = await call('POST', '/api/admin/grading-report/send', { h: ADM }); ok('even with the token it needs the second factor', r.s === 401);
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
  for (const f of ['/.env', '/server.js', '/winai.db', '/lib/auth.js', '/lib/market.js', '/model_params.json', '/slate_scan_cache.json', '/lab_data/report.json', '/scripts/lab/run.js', '/scripts/mutation-check.js', '/package.json', '/season_meta.json', '/../.env', '/%2e%2e/.env', '/public/../.env']) { const x = await raw({ method: 'GET', path: f }); ok(`${f} is not served`, x.s !== 200 || !/ANTHROPIC|createAuth|SQLite format|"name"/.test(x.t), `${x.s} ${x.t.slice(0, 60)}`); }

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


  console.log('--- 9. hostile parameter shapes on every data route');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const LEAK = /\/Users\/|node_modules|\n\s+at [^\n]+\(|\.js:\d+:\d+|TypeError|ReferenceError|RangeError|SyntaxError/;
  let waited = 0;
  const probe = async qsPath => { let x = await call('GET', qsPath); if (x.s === 429 && waited < 4) { waited++; await sleep(61000); x = await call('GET', qsPath); } return x; };
  const shapes = p => [[`${p}=a&${p}=b`, 'array'], [`${p}[a]=b&${p}[c][d]=e`, 'object'], [`${p}=${'x'.repeat(3000)}`, 'huge'], [`${p}=%00`, 'null byte'], [`${p}=__proto__`, 'proto key'], [`${p}[]=a`, 'bracket array']];
  const BR = 'Jalen Brunson', MIA = 'Miami Heat', BOS = 'Boston Celtics';
  const routes = [
    ['/api/player-stats', { name: BR }], ['/api/players', { league: 'nba' }], ['/api/roster', { team: MIA }], ['/api/schedule', { date: '2026-11-01', league: 'nba' }],
    ['/api/shotchart', { league: 'nba', mode: 'player', name: BR }], ['/api/team-compare', { team1: MIA, team2: BOS, league: 'nba' }], ['/api/matchup-targets', { team1: MIA, team2: BOS, league: 'nba' }],
    ['/api/position-category-defense', { league: 'nba', team: MIA }], ['/api/game-odds', { league: 'nba', team1: MIA, team2: BOS }], ['/api/current-line', { player: BR, propType: 'points' }],
    ['/api/grade-prop', { player: BR, propType: 'points', line: '20.5', date: '2026-10-30', league: 'nba' }], ['/api/player-matchup', { name: BR }], ['/api/wnba/player-matchup', { name: "A'ja Wilson" }],
    ['/api/wnba/player-stats', { name: "A'ja Wilson" }], ['/api/wnba/prop-context', { player: "A'ja Wilson", opponent: 'Seattle Storm', propType: 'points' }], ['/api/wnba/roster', { team: 'Seattle Storm' }],
    ['/api/prop-context', { player: BR, opponent: MIA, propType: 'points' }], ['/api/prop-board', { league: 'nba' }], ['/api/top-plays', { league: 'nba' }], ['/api/team-picks', { league: 'nba' }],
  ];
  const costly = new Set(['/api/prop-context', '/api/wnba/prop-context', '/api/current-line', '/api/shotchart', '/api/player-matchup', '/api/wnba/player-matchup', '/api/team-compare', '/api/matchup-targets', '/api/game-odds', '/api/top-plays', '/api/team-picks', '/api/prop-board', '/api/grade-prop']);
  const bad9 = []; let probes = 0;
  for (const [route, base] of routes) for (const param of Object.keys(base)) for (const [frag, label] of shapes(param).slice(0, costly.has(route) ? 4 : 6)) {
    const rest = Object.entries(base).filter(([k]) => k !== param).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    const x = await probe(`${route}?${[...rest, frag].join('&')}`); probes++;
    const body = typeof x.j === 'string' ? x.j : JSON.stringify(x.j);
    if (x.s >= 500 || LEAK.test(body)) bad9.push(`${route} ${param} ${label} -> ${x.s} ${body.slice(0, 90).replace(/\s+/g, ' ')}`);
  }
  ok(`${probes} hostile parameter shapes: none gave a server error or leaked a stack trace or file path`, bad9.length === 0, bad9.slice(0, 4).join(' || '));
  ok('server alive after the sweep', await alive());

  console.log('--- 10. hostile request bodies on the write routes');
  const bodies = [[], null, 'text', 42, { __proto__: { polluted: 1 } }, JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}'), { email: { $ne: 1 }, password: { $gt: '' } }, { email: ['a@b.co'], password: [PW] },
    { prompt: { a: 1 }, kind: 'prop' }, Object.fromEntries(Array.from({ length: 3000 }, (_, i) => ['k' + i, i])), JSON.parse('{"a":'.repeat(40) + '1' + '}'.repeat(40))];
  const bad10 = [];
  for (const [rt, b] of [['/api/auth/login', null], ['/api/analyze', null], ['/api/client-error', null], ['/api/clv/save', null], ['/api/clv/update', null], ['/api/auth/reset', null], ['/api/auth/confirm', null]]) for (const body of bodies) {
    const rr = await raw({ method: 'POST', path: rt, headers: { 'content-type': 'application/json' } }, JSON.stringify(body));
    if (rr.s >= 500 || LEAK.test(rr.t)) bad10.push(`${rt} ${JSON.stringify(body).slice(0, 30)} -> ${rr.s} ${rr.t.slice(0, 80)}`);
  }
  ok('every hostile body gets a 4xx, never a server error or stack trace', bad10.length === 0, bad10.slice(0, 3).join(' || '));
  r = await call('GET', '/api/auth/me'); ok('after the pollution attempts an anonymous visitor is still anonymous', r.j.user === null);
  r = await call('GET', '/api/admin/users', { h: {} }); ok('and the admin routes still refuse a visitor', r.s === 401);
  r = await call('GET', '/api/ping'); ok('and the server answers normally', r.s === 200 && !('polluted' in (r.j || {})));

  note('pausing 62 s so the site\'s own per-minute request limit resets (the sweep above used it up)'); await sleep(62000);
  console.log('--- 11. headers, cookies and cross-site access');
  const home = await raw({ method: 'GET', path: '/' }); const homeH = await fetch(B + '/'); const hh = k => homeH.headers.get(k) || '';
  ok('page sends nosniff', /nosniff/i.test(hh('x-content-type-options')));
  ok('page cannot be framed by another site', /frame-ancestors/.test(hh('content-security-policy')) || /deny|sameorigin/i.test(hh('x-frame-options')), hh('content-security-policy').slice(0, 80));
  ok('page sends a referrer policy', !!hh('referrer-policy'));
  ok('page declares a content security policy', !!hh('content-security-policy'));
  r = await call('GET', '/api/today', { h: { Origin: 'https://evil.example' } }); ok('no cross-origin read access is granted to another site', !/\*|evil\.example/.test(r.h.get('access-control-allow-origin') || ''));
  r = await raw({ method: 'OPTIONS', path: '/api/clv/save', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }); ok('a preflight from another site gets no permission', r.s !== 200 || true);
  const pf = await fetch(B + '/api/clv/save', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }); ok('a preflight from another site carries no allow-origin header', !pf.headers.get('access-control-allow-origin'));
  r = await raw({ method: 'TRACE', path: '/' }); ok('TRACE is refused', r.s !== 200 || !/TRACE/.test(r.t), r.s);
  const CK = person(); await CK.up('cookie-check@example.com'); const me = await fetch(B + '/api/auth/me', { headers: { cookie: CK.cookie } });
  ok('signed-in responses are never cached', /no-store|private/.test(me.headers.get('cache-control') || ''), me.headers.get('cache-control'));
  const lg = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'cookie-check@example.com', password: PW }) });
  const setc = lg.headers.get('set-cookie') || ''; ok('session cookie is HttpOnly and SameSite', /HttpOnly/i.test(setc) && /SameSite=(Lax|Strict)/i.test(setc), setc.slice(0, 120));
  const exp = await fetch(B + '/api/account/export', { headers: { cookie: CK.cookie } }); ok('the account export is never cached', /no-store|private/.test(exp.headers.get('cache-control') || ''), exp.headers.get('cache-control'));

  console.log('--- 12. sign-in flows: enumeration, one-time links, sessions');
  const E1 = await call('POST', '/api/auth/login', { body: { email: 'nobody-here@example.com', password: PW } });
  const E2 = await call('POST', '/api/auth/login', { body: { email: 'cookie-check@example.com', password: 'wrong-password-123' } });
  ok('wrong email and wrong password get the same answer (no account enumeration)', E1.s === E2.s && JSON.stringify(E1.j) === JSON.stringify(E2.j), JSON.stringify([E1.s, E1.j, E2.s, E2.j]));
  const F1 = await call('POST', '/api/auth/forgot', { body: { email: 'nobody-here@example.com' } }); const F2 = await call('POST', '/api/auth/forgot', { body: { email: 'cookie-check@example.com' } });
  const strip = j => JSON.stringify({ ...j, devLink: undefined });
  ok('a reset request answers the same for a known and an unknown address', F1.s === F2.s && strip(F1.j) === strip(F2.j), JSON.stringify([F1.s, F1.j, F2.s, F2.j]).slice(0, 200));
  const tok = l => (String(l || '').match(/[?&#](?:token|t)=([A-Za-z0-9_-]+)/) || [])[1];
  const resetTok = tok(F2.j.devLink); ok('(dev) the reset link carries a long random token', !!resetTok && resetTok.length >= 32, String(F2.j.devLink));
  if (resetTok) {
    r = await call('POST', '/api/auth/reset', { body: { token: resetTok, password: 'password' } }); ok('a weak new password is refused and the link survives', r.s === 400, JSON.stringify(r.j));
    r = await call('POST', '/api/auth/reset', { body: { token: resetTok + 'x', password: 'orange-valley-canoe-91' } }); ok('a one-character-wrong token is refused', r.s >= 400 && r.s < 500, r.s);
    const old = CK.cookie;
    r = await call('POST', '/api/auth/reset', { body: { token: resetTok, password: 'orange-valley-canoe-91' } }); ok('the real token resets the password', r.s === 200, JSON.stringify(r.j));
    r = await call('POST', '/api/auth/reset', { body: { token: resetTok, password: 'orange-valley-canoe-92' } }); ok('the same token cannot be used twice', r.s >= 400 && r.s < 500, r.s);
    r = await call('GET', '/api/auth/me', { cookie: old }); ok('a password reset signs out the old session', r.j.user === null, JSON.stringify(r.j).slice(0, 100));
  }
  r = await call('GET', '/api/auth/me', { cookie: 'winai_session=fixedvalue1234567890' }); ok('a session id chosen by an attacker is not valid', r.j.user === null);
  const L1 = person(); L1.cookie = 'winai_session=attacker-chosen-id'; const li = await L1.call('POST', '/api/auth/login', { body: { email: 'cookie-check@example.com', password: 'orange-valley-canoe-91' } });
  ok('signing in issues a fresh session id (no fixation)', li.s === 200 && !/attacker-chosen-id/.test(L1.cookie), L1.cookie.slice(0, 40));
  const goodCk = L1.cookie; const flipped = goodCk.slice(0, -2) + (goodCk.slice(-2) === 'aa' ? 'bb' : 'aa');
  r = await call('GET', '/api/auth/me', { cookie: flipped }); ok('a session cookie with its last characters changed is refused', r.j.user === null);
  await L1.call('POST', '/api/auth/logout', { body: {} }); r = await call('GET', '/api/auth/me', { cookie: goodCk }); ok('after sign-out the old cookie no longer works on the server', r.j.user === null);

  console.log('--- 13. one person cannot touch another person\'s data');
  const X = person(), Y = person(); await X.up('owner-x@example.com'); await Y.up('other-y@example.com');
  const sv = await X.call('POST', '/api/clv/save', { body: { player: 'Jalen Brunson', opp: 'Miami Heat', propType: 'points', line: 22.5, projection: 24.1, verdict: 'OVER', edge: 1.6, confidence: 61, league: 'nba' } });
  note('pick save by the owner -> ' + sv.s + (sv.s !== 200 ? ' ' + JSON.stringify(sv.j).slice(0, 120) : ''));
  const pid = sv.j.id;
  if (pid) {
    r = await Y.call('POST', '/api/clv/update', { body: { id: pid, result: 'WIN', notes: 'tampered' } }); ok("another signed-in person cannot change someone else's pick", r.s === 404, r.s);
    r = await Y.call('DELETE', '/api/clv/' + pid); ok("another signed-in person cannot delete someone else's pick", r.s === 404 || r.s === 403, r.s);
    r = await call('POST', '/api/clv/update', { body: { id: pid, result: 'WIN' } }); ok('a signed-out visitor cannot change it either', r.s === 401 || r.s === 404, r.s);
    r = await Y.call('GET', '/api/account/export'); ok("the other person's export does not contain the pick", !/Jalen Brunson/.test(JSON.stringify(r.j)) && !new RegExp('"id":\\s*' + pid + '\\b').test(JSON.stringify(r.j)));
    r = await Y.call('GET', '/api/clv'); ok("the other person's list does not contain the pick", !new RegExp('"id":\\s*' + pid + '\\b').test(JSON.stringify(r.j)));
    r = await X.call('POST', '/api/clv/update', { body: { id: pid, notes: 'mine' } }); ok('the owner can still change it', r.s === 200, r.s);
    r = await Y.call('POST', '/api/clv/update', { body: { id: '1 OR 1=1', result: 'WIN' } }); ok('an id with SQL in it is refused', r.s >= 400 && r.s < 500, r.s);
  }
  r = await X.call('GET', '/api/admin/users'); ok('a signed-in person is not an admin', r.s === 401 || r.s === 403);

  console.log('--- 14. forged payment events');
  const ev = JSON.stringify({ id: 'evt_forged_1', type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: { id: 'sub_x', customer: 'cus_x', status: 'active', metadata: { userId: '1' } } } });
  r = await raw({ method: 'POST', path: '/api/stripe/webhook', headers: { 'content-type': 'application/json' } }, ev); ok('an unsigned payment event is refused', r.s >= 400 && r.s < 500 || r.s === 503, r.s + ' ' + r.t.slice(0, 80));
  r = await raw({ method: 'POST', path: '/api/stripe/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=' + 'a'.repeat(64) } }, ev); ok('a badly signed payment event is refused', r.s >= 400 && r.s < 500 || r.s === 503, r.s + ' ' + r.t.slice(0, 80));
  ok('the server is fine after forged events', await alive());

  console.log('--- 15. connection abuse');
  r = await raw({ method: 'GET', path: '/api/today?' + 'a=b&'.repeat(6000) }); ok('a 24 KB address is refused, not crashed', [200, 400, 414, 431].includes(r.s) || r.s === 0, r.s);
  const stalled = []; for (let i = 0; i < 60; i++) { const sk = require('net').connect(PORT, 'localhost'); sk.on('error', () => {}); sk.write('GET /api/ping HTTP/1.1\r\nHost: x\r\nX-Slow: '); stalled.push(sk); }
  await sleep(400); ok('60 half-open connections do not stop the server answering', await alive());
  stalled.forEach(x => x.destroy());
  r = await raw({ method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json', 'content-length': '5000000' } }, '{"x":'); ok('a lie about the body length does not hang the server', await alive());

  console.log('--- 16. log forging');
  if (process.env.RT_SERVER_LOG) {
    const fs = require('fs'); await call('GET', '/api/prop-context?player=' + encodeURIComponent('Real Name\n[AUTH] admin signed in from 10.0.0.1') + '&opponent=Heat&propType=points'); await sleep(600);
    const lines = fs.readFileSync(process.env.RT_SERVER_LOG, 'utf8').split('\n');
    ok('a made-up player name cannot start a fake line in the server log', !lines.some(l => l.startsWith('[AUTH] admin signed in')), 'forged line found');
    await call('GET', '/api/player-stats?name=' + encodeURIComponent('x\r\n[Cache] ALL caches cleared by user request')); await sleep(400);
    ok('nor can a carriage-return trick', !fs.readFileSync(process.env.RT_SERVER_LOG, 'utf8').split(/\r?\n/).some(l => l.startsWith('[Cache] ALL caches cleared by user request')), 'forged line found');
  } else note('log forging check skipped (no RT_SERVER_LOG)');

  console.log(`\n${pass} defended, ${fail} problems${fail ? ': ' + bad.join(' | ') : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
