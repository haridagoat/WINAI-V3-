// The replay lab's analysis. Pure functions over league game logs (see scripts/lab/fetch_logs.py); no I/O, no network.
//
// "Walk forward" means every prediction for a game uses only games played before it, exactly as the live model would have. Fits are made on one
// season and checked on a different one, so a setting is adopted only if it also beats the current method on games it was not fitted on.

const STATS = ['PTS', 'REB', 'AST', 'FG3M', 'STL', 'BLK'];
const KEY = { PTS: 'points', REB: 'rebounds', AST: 'assists', FG3M: '3pm', STL: 'steals', BLK: 'blocks', MIN: 'minutes' };
const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const dayNumber = d => Math.floor(Date.parse(String(d).slice(0, 10) + 'T12:00:00Z') / 86400000);

// ── data preparation ────────────────────────────────────────────────────────────────────────────────────
// Team results by game, with the days of rest each team had and each team's recent average margin going in (a stand-in for the point spread,
// which the game logs do not have).
function prepareTeams(teamRows) {
  const byTeam = new Map(), byGame = new Map();
  for (const r of teamRows) { if (!byTeam.has(r.TEAM_ID)) byTeam.set(r.TEAM_ID, []); byTeam.get(r.TEAM_ID).push(r); if (!byGame.has(r.GAME_ID)) byGame.set(r.GAME_ID, []); byGame.get(r.GAME_ID).push(r); }
  const info = new Map();                                 // `${gameId}|${teamId}` -> features known before the game
  for (const [teamId, rows] of byTeam) {
    rows.sort((a, b) => String(a.GAME_DATE).localeCompare(String(b.GAME_DATE)) || String(a.GAME_ID).localeCompare(String(b.GAME_ID)));
    rows.forEach((r, i) => {
      const prev = i ? rows[i - 1] : null, last15 = rows.slice(Math.max(0, i - 15), i);
      info.set(`${r.GAME_ID}|${teamId}`, {
        date: String(r.GAME_DATE).slice(0, 10), home: /vs\./.test(r.MATCHUP || ''), margin: num(r.PLUS_MINUS),
        rest: prev ? dayNumber(r.GAME_DATE) - dayNumber(prev.GAME_DATE) : 7, net: last15.length >= 5 ? mean(last15.map(x => num(x.PLUS_MINUS))) : 0,
      });
    });
  }
  for (const [gameId, rows] of byGame) for (const r of rows) {
    const opp = rows.find(x => x.TEAM_ID !== r.TEAM_ID), me = info.get(`${gameId}|${r.TEAM_ID}`);
    if (me && opp) { me.oppId = opp.TEAM_ID; const o = info.get(`${gameId}|${opp.TEAM_ID}`); me.expMargin = me.net - (o ? o.net : 0) + (me.home ? 2.2 : -2.2); }
  }
  return info;
}

// One chronological array of games per player, each with the team context it was played in.
function preparePlayers(playerRows, teamInfo) {
  const byPlayer = new Map();
  for (const r of playerRows) {
    const t = teamInfo.get(`${r.GAME_ID}|${r.TEAM_ID}`);
    if (!t || !(num(r.MIN) > 0)) continue;
    if (!byPlayer.has(r.PLAYER_ID)) byPlayer.set(r.PLAYER_ID, { id: r.PLAYER_ID, name: r.PLAYER_NAME, games: [] });
    byPlayer.get(r.PLAYER_ID).games.push({ gameId: r.GAME_ID, teamId: r.TEAM_ID, date: t.date, MIN: num(r.MIN), PTS: num(r.PTS), REB: num(r.REB), AST: num(r.AST), FG3M: num(r.FG3M), STL: num(r.STL), BLK: num(r.BLK), home: t.home, rest: t.rest, expMargin: t.expMargin ?? 0, oppId: t.oppId });
  }
  for (const p of byPlayer.values()) p.games.sort((a, b) => a.date.localeCompare(b.date) || String(a.gameId).localeCompare(String(b.gameId)));
  return byPlayer;
}

// ── level predictors, walked forward ────────────────────────────────────────────────────────────────────
// Predictions for game i come from games 0..i-1 only. `prior` (last season's average, when known) stands in for the first games.
function walkLevels(games, stat, { halfLife, lambda, minPrior = 10 }) {
  const gamma = Math.pow(0.5, 1 / halfLife), out = [];
  let num_ = 0, den = 0, sum = 0;
  const hist = [];
  for (let i = 0; i < games.length; i++) {
    const x = games[i][stat];
    if (i >= minPrior) {
      const ewma = num_ / den, seasonMean = sum / i;
      const l10 = mean(hist.slice(-10));
      out.push({ i, actual: x, ewma, seasonMean, l10, pred: lambda * ewma + (1 - lambda) * seasonMean, current: (10 / 18) * l10 + (8 / 18) * seasonMean, mins: games[i].MIN });
    }
    num_ = gamma * num_ + x; den = gamma * den + 1; sum += x; hist.push(x);
  }
  return out;
}

const mae = (rows, f) => { let s = 0, n = 0; for (const r of rows) { s += Math.abs(r.actual - f(r)); n++; } return n ? s / n : null; };

// A "rotation" row is a player who was playing real minutes going in: the universe prop lines exist for.
function levelRows(players, stat, params, minRecentMin = 15) {
  const rows = [];
  for (const p of players.values()) {
    if (p.games.length < 14) continue;
    for (const r of walkLevels(p.games, stat, params)) {
      const recent = mean(p.games.slice(Math.max(0, r.i - 10), r.i).map(g => g.MIN));
      if (recent >= minRecentMin) rows.push(r);
    }
  }
  return rows;
}

// Grid over the decay half-life (in games) and the share of the answer that comes from the decayed average rather than the season mean.
const HALF_LIVES = [2.5, 4, 6, 8, 11, 15, 22, 40];
const LAMBDAS = [0.4, 0.55, 0.7, 0.85, 1.0];
function fitLevel(trainPlayers, testPlayers, stat) {
  let best = null;
  for (const h of HALF_LIVES) for (const l of LAMBDAS) {
    const m = mae(levelRows(trainPlayers, stat, { halfLife: h, lambda: l }), r => r.pred);
    if (best == null || m < best.trainMae) best = { halfLife: h, lambda: l, trainMae: m };
  }
  const trainRows = levelRows(trainPlayers, stat, best), testRows = levelRows(testPlayers, stat, best);
  return {
    stat, halfLife: best.halfLife, lambda: best.lambda,
    train: { n: trainRows.length, fitted: mae(trainRows, r => r.pred), current: mae(trainRows, r => r.current), l10: mae(trainRows, r => r.l10), season: mae(trainRows, r => r.seasonMean) },
    test: { n: testRows.length, fitted: mae(testRows, r => r.pred), current: mae(testRows, r => r.current), l10: mae(testRows, r => r.l10), season: mae(testRows, r => r.seasonMean) },
    residualSd: sdOf(testRows.map(r => r.actual - r.pred)),
  };
}
function sdOf(a) { if (a.length < 3) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }

// How outcomes spread around the prediction, by predicted level: sd = a + b * level (and for count stats, variance = phi * mean).
function fitSpread(players, stat, params) {
  const rows = levelRows(players, stat, params);
  const bins = new Map();
  for (const r of rows) { const b = Math.min(12, Math.floor(r.pred / (stat === 'PTS' ? 3 : 1))); if (!bins.has(b)) bins.set(b, []); bins.get(b).push(r); }
  const pts = [...bins.values()].filter(a => a.length >= 60).map(a => ({ level: mean(a.map(r => r.pred)), sd: sdOf(a.map(r => r.actual - r.pred)), n: a.length }));
  let a = null, b = null;
  if (pts.length >= 3) {                                  // weighted least squares of sd on level
    const W = pts.reduce((s, p) => s + p.n, 0), mx = pts.reduce((s, p) => s + p.n * p.level, 0) / W, my = pts.reduce((s, p) => s + p.n * p.sd, 0) / W;
    const sxx = pts.reduce((s, p) => s + p.n * (p.level - mx) ** 2, 0), sxy = pts.reduce((s, p) => s + p.n * (p.level - mx) * (p.sd - my), 0);
    b = sxx > 0 ? sxy / sxx : 0; a = my - b * mx;
  }
  const phi = (() => { const v = sdOf(rows.map(r => r.actual - r.pred)) ** 2, m = mean(rows.map(r => r.pred)); return m > 0 ? v / m : null; })();
  return { stat, a, b, phi, n: rows.length, points: pts };
}

// ── minutes ─────────────────────────────────────────────────────────────────────────────────────────────
// Walk minutes forward and measure how rest and the expected size of the margin move them, relative to the player's own recent level.
function minutesRows(players, { halfLife = 8, lambda = 0.8 } = {}) {
  const rows = [];
  for (const p of players.values()) {
    if (p.games.length < 14) continue;
    for (const r of walkLevels(p.games, 'MIN', { halfLife, lambda })) {
      const g = p.games[r.i], recent = mean(p.games.slice(Math.max(0, r.i - 10), r.i).map(x => x.MIN));
      if (recent < 12) continue;
      rows.push({ ...r, base: r.pred, recent, rest: g.rest, home: g.home, absSpread: Math.abs(g.expMargin), ratio: g.MIN / r.pred });
    }
  }
  return rows;
}
const STARTER_MIN = 28;
// Mean of (actual / baseline) by group. A ratio below 1 means the player got fewer minutes than his baseline.
function bucketMeans(rows, keyOf, cuts) {
  const out = cuts.map(([lo, hi]) => ({ lo, hi, n: 0, sum: 0 }));
  for (const r of rows) { const k = keyOf(r), b = out.find(x => k >= x.lo && k < x.hi); if (b) { b.n++; b.sum += r.ratio; } }
  return out.filter(b => b.n >= 40).map(b => ({ from: b.lo, to: b.hi === Infinity ? null : b.hi, n: b.n, ratio: parseFloat((b.sum / b.n).toFixed(4)) }));
}
function fitMinutes(trainRows, testRows) {
  const spreadCuts = [[0, 3], [3, 6], [6, 9], [9, 12], [12, 16], [16, 99]];
  const group = (rows, starter) => rows.filter(r => (r.recent >= STARTER_MIN) === starter);
  const curve = (rows, starter) => bucketMeans(group(rows, starter), r => r.absSpread, spreadCuts);
  const rest = rows => bucketMeans(rows, r => Math.min(3, r.rest), [[0, 2], [2, 3], [3, 4], [4, Infinity]]);   // 1 = back-to-back
  const adj = (rows, curveS, curveB, b2b) => rows.map(r => {
    const c = (r.recent >= STARTER_MIN ? curveS : curveB), hit = c.find(x => r.absSpread >= x.from && (x.to == null || r.absSpread < x.to));
    return { actual: r.actual, base: r.base * (hit ? hit.ratio : 1) * (r.rest <= 1 ? b2b : 1), plain: r.base, current: r.current };
  });
  const cs = curve(trainRows, true), cb = curve(trainRows, false);
  const b2bRatio = (() => { const x = trainRows.filter(r => r.rest <= 1); return x.length >= 60 ? mean(x.map(r => r.ratio)) / mean(trainRows.map(r => r.ratio)) : 1; })();
  const score = rows => { const a = adj(rows, cs, cb, b2bRatio); return { n: rows.length, current: mae(a, r => r.current), decayOnly: mae(a, r => r.plain), withContext: mae(a, r => r.base) }; };
  return { starterCurve: cs, benchCurve: cb, rest: rest(trainRows), b2bRatio: parseFloat(b2bRatio.toFixed(4)), train: score(trainRows), test: score(testRows), starterMin: STARTER_MIN };
}

// ── teammates out ───────────────────────────────────────────────────────────────────────────────────────
// For every team game, which regular rotation players (recent minutes, usually playing) were absent, and what share of the team's
// production they normally carry. Then: how much more do the others produce, as a share of that missing production?
function missingShares(playerRows, teamInfo) {
  const byTeamGame = new Map();                           // `${gameId}|${teamId}` -> Map(playerId -> row)
  const teamGames = new Map();                            // teamId -> chronologically ordered gameIds
  for (const r of playerRows) { if (!(num(r.MIN) > 0)) continue; const k = `${r.GAME_ID}|${r.TEAM_ID}`; if (!byTeamGame.has(k)) byTeamGame.set(k, new Map()); byTeamGame.get(k).set(r.PLAYER_ID, r); }
  for (const k of teamInfo.keys()) { const [g, t] = k.split('|'); const id = Number(t); if (!teamGames.has(id)) teamGames.set(id, []); teamGames.get(id).push({ gameId: g, date: teamInfo.get(k).date }); }
  const out = new Map();                                  // `${gameId}|${teamId}` -> { missing: Set(ids), frac: {PTS, REB, AST, FG3M, STL, BLK, MIN} }
  for (const [teamId, list] of teamGames) {
    list.sort((a, b) => a.date.localeCompare(b.date) || String(a.gameId).localeCompare(String(b.gameId)));
    const trail = new Map();                              // playerId -> last 10 appearances (before the current game)
    const recentGames = [];                               // last 10 team games, each a Set of players who played
    for (const { gameId } of list) {
      const key = `${gameId}|${teamId}`, played = byTeamGame.get(key) || new Map();
      const rotation = [];
      for (const [pid, apps] of trail) {
        const inLast10 = recentGames.filter(s => s.has(pid)).length;
        if (inLast10 >= 5 && mean(apps.map(a => a.MIN)) >= 20) rotation.push(pid);
      }
      const missing = rotation.filter(pid => !played.has(pid));
      if (recentGames.length >= 8 && missing.length) {
        const frac = {};
        for (const s of [...STATS, 'MIN']) {
          const mu = pid => mean((trail.get(pid) || []).map(a => num(a[s])));
          const total = rotation.reduce((t, pid) => t + (mu(pid) || 0), 0);
          frac[s] = total > 0 ? Math.min(0.6, missing.reduce((t, pid) => t + (mu(pid) || 0), 0) / total) : 0;
        }
        out.set(key, { missing: new Set(missing), frac });
      } else out.set(key, { missing: new Set(), frac: null });
      for (const [pid, row] of played) { if (!trail.has(pid)) trail.set(pid, []); const a = trail.get(pid); a.push(row); if (a.length > 10) a.shift(); }
      recentGames.push(new Set(played.keys())); if (recentGames.length > 10) recentGames.shift();
    }
  }
  return out;
}

// Slope (through the origin) of "how much above his own baseline", on "share of the team's production that is missing".
function fitTeammateOut(players, shares, params = {}) {
  const res = {};
  for (const stat of [...STATS, 'MIN']) {
    const rows = [];
    const h = params[stat]?.halfLife || 8, l = params[stat]?.lambda ?? 0.8;
    for (const p of players.values()) {
      if (p.games.length < 14) continue;
      for (const r of walkLevels(p.games, stat, { halfLife: h, lambda: l })) {
        const g = p.games[r.i], sh = shares.get(`${g.gameId}|${g.teamId}`);
        const recent = mean(p.games.slice(Math.max(0, r.i - 10), r.i).map(x => x.MIN));
        if (!sh || recent < 12 || !(r.pred > 0.3)) continue;
        rows.push({ x: sh.frac ? sh.frac[stat] : 0, y: r.actual / r.pred - 1 });
      }
    }
    const withOut = rows.filter(r => r.x > 0), sxx = withOut.reduce((s, r) => s + r.x * r.x, 0), sxy = withOut.reduce((s, r) => s + r.x * r.y, 0);
    const base = mean(rows.filter(r => r.x === 0).map(r => r.y)) ?? 0;
    const slope = sxx > 0 ? sxy / sxx : null;
    // 95% range for the slope by splitting the games into 10 groups
    const group = (i, n) => withOut.filter((_, k) => k % n === i), slopes = [];
    for (let i = 0; i < 10; i++) { const g = group(i, 10), a = g.reduce((s, r) => s + r.x * r.x, 0), b = g.reduce((s, r) => s + r.x * r.y, 0); if (a > 0) slopes.push(b / a); }
    const sd = sdOf(slopes), se = sd != null ? sd / Math.sqrt(slopes.length) : null;
    const buckets = [[0.001, 0.05], [0.05, 0.12], [0.12, 0.25], [0.25, 0.61]].map(([lo, hi]) => { const g = withOut.filter(r => r.x >= lo && r.x < hi); return { from: lo, to: hi, n: g.length, avgMissingShare: g.length ? parseFloat(mean(g.map(r => r.x)).toFixed(3)) : null, lift: g.length ? parseFloat((mean(g.map(r => r.y)) - base).toFixed(4)) : null }; });
    res[stat] = { n: rows.length, nWithMissing: withOut.length, slope: slope != null ? parseFloat(slope.toFixed(3)) : null, stderr: se != null ? parseFloat(se.toFixed(3)) : null, baselineLift: parseFloat(base.toFixed(4)), buckets };
  }
  return res;
}


// Rest: how players did on the second night of a back-to-back, or after longer rest, compared with their own baseline. Only games the player
// actually played are in the logs, so this is "given that he played".
function fitRest(players, params = {}, shares = null) {
  const res = {};
  for (const stat of [...STATS, 'MIN']) {
    const h = params[stat]?.halfLife || 8, l = params[stat]?.lambda ?? 0.8;
    const groups = { b2b: [], one: [], rested: [] };
    for (const p of players.values()) {
      if (p.games.length < 14) continue;
      for (const r of walkLevels(p.games, stat, { halfLife: h, lambda: l })) {
        const g = p.games[r.i], recent = mean(p.games.slice(Math.max(0, r.i - 10), r.i).map(x => x.MIN));
        if (recent < 15 || !(r.pred > 0.3)) continue;
        if (shares) { const sh = shares.get(`${g.gameId}|${g.teamId}`); if (!sh || sh.missing.size) continue; }   // only games with every regular present
        const y = r.actual / r.pred - 1;
        (g.rest <= 1 ? groups.b2b : g.rest === 2 ? groups.one : groups.rested).push(y);
      }
    }
    const row = a => ({ n: a.length, lift: a.length ? parseFloat(mean(a).toFixed(4)) : null, stderr: a.length > 30 ? parseFloat((sdOf(a) / Math.sqrt(a.length)).toFixed(4)) : null });
    res[stat] = { b2b: row(groups.b2b), oneDay: row(groups.one), rested: row(groups.rested) };
  }
  return res;
}

// Guards, forwards or centers, from a listed position such as "G", "F-C" or "C-F" (the first letter is the main one).
const groupOfPosition = pos => { const c = typeof pos === 'string' ? pos.trim()[0] : ''; return c === 'G' || c === 'F' || c === 'C' ? c : null; };

// What each defense has given up to guards, forwards and centers, known before every game. For each game and defending team: the team's
// per-game average allowed to each group so far this season (`team`), the average over all teams (`league`) and the number of games behind it (`n`).
function allowedByGroup(playerRows, teamInfo, groupOf) {
  const perGame = new Map();                              // `${gameId}|${offenseTeamId}` -> { G: {PTS..}, F: {...}, C: {...} }
  for (const r of playerRows) {
    if (!(num(r.MIN) > 0)) continue;
    const g = groupOf(r.PLAYER_ID); if (!g) continue;
    const k = `${r.GAME_ID}|${r.TEAM_ID}`;
    if (!perGame.has(k)) perGame.set(k, { G: {}, F: {}, C: {} });
    const slot = perGame.get(k)[g];
    for (const s of STATS) slot[s] = (slot[s] || 0) + num(r[s]);
  }
  const games = [...teamInfo.entries()].map(([k, v]) => ({ key: k, gameId: k.split('|')[0], date: v.date, def: v.oppId })).filter(g => g.def != null && perGame.has(g.key));
  games.sort((a, b) => a.date.localeCompare(b.date) || String(a.gameId).localeCompare(String(b.gameId)));
  const zero = () => ({ G: Object.fromEntries(STATS.map(s => [s, 0])), F: Object.fromEntries(STATS.map(s => [s, 0])), C: Object.fromEntries(STATS.map(s => [s, 0])) });
  const avg = (tot, n) => Object.fromEntries(['G', 'F', 'C'].map(g => [g, Object.fromEntries(STATS.map(s => [s, n ? tot[g][s] / n : 0]))]));
  // Walk the season in order; every snapshot is taken before any part of that game is added.
  const sums = new Map(), counts = new Map(), league = zero(); let leagueN = 0;
  const snap = new Map();                                 // `${gameId}|${defenseTeamId}` -> { n, team, league }
  for (let i = 0; i < games.length;) {
    let j = i; while (j < games.length && games[j].gameId === games[i].gameId) j++;
    const same = games.slice(i, j);
    for (const g of same) { const n = counts.get(g.def) || 0; snap.set(`${g.gameId}|${g.def}`, { n, team: n ? avg(sums.get(g.def), n) : null, league: leagueN ? avg(league, leagueN) : null }); }
    for (const g of same) {
      const got = perGame.get(g.key);
      if (!sums.has(g.def)) sums.set(g.def, zero());
      for (const grp of ['G', 'F', 'C']) for (const s of STATS) { sums.get(g.def)[grp][s] += got[grp][s] || 0; league[grp][s] += got[grp][s] || 0; }
      counts.set(g.def, (counts.get(g.def) || 0) + 1); leagueN += 1;
    }
    i = j;
  }
  return snap;
}

// Does "this defense gives up more than most to this player's group" predict a player doing better than his own baseline?
// x is how far the (shrunk) allowed figure is above the league's. `mix` keeps only how a defense's output is split between guards, forwards and
// centers; `net` is the group's figure for the stat minus the defense's overall points allowed (both as ratios to the league). Slope is of (actual / expected - 1) on x.
function fitPositionAllowed(players, allowed, groupOf, params = {}, { shrinkGames = 10, minGames = 10 } = {}) {
  const res = {};
  for (const stat of STATS) {
    const h = params[stat]?.halfLife || 8, l = params[stat]?.lambda ?? 0.8;
    const level = [], mix = [], net = [];
    for (const p of players.values()) {
      const grp = groupOf(p.id); if (!grp || p.games.length < 14) continue;
      for (const r of walkLevels(p.games, stat, { halfLife: h, lambda: l })) {
        const g = p.games[r.i], a = allowed.get(`${g.gameId}|${g.oppId}`);
        const recent = mean(p.games.slice(Math.max(0, r.i - 10), r.i).map(x => x.MIN));
        if (!a || !a.team || a.n < minGames || recent < 15 || !(r.pred > 0.3)) continue;
        const sh = x => (a.n * a.team[x.g][stat] + shrinkGames * a.league[x.g][stat]) / (a.n + shrinkGames);
        const mine = sh({ g: grp }), lg = a.league[grp][stat];
        const tot = ['G', 'F', 'C'].reduce((t, k) => t + sh({ g: k }), 0), lgTot = ['G', 'F', 'C'].reduce((t, k) => t + a.league[k][stat], 0);
        if (!(lg > 0) || !(tot > 0) || !(lgTot > 0)) continue;
        const y = r.actual / r.pred - 1;
        // `net`: the group's figure for this stat relative to the defense's overall points allowed (the model's defensive-rating step already carries the overall level)
        const ptsAll = ['G', 'F', 'C'].reduce((t, k) => t + (a.n * a.team[k].PTS + shrinkGames * a.league[k].PTS) / (a.n + shrinkGames), 0), ptsLg = ['G', 'F', 'C'].reduce((t, k) => t + a.league[k].PTS, 0);
        level.push({ x: mine / lg - 1, y }); mix.push({ x: (mine / tot) / (lg / lgTot) - 1, y }); net.push({ x: (mine / lg) - (ptsAll / ptsLg), y });
      }
    }
    res[stat] = { n: level.length, level: slopeOf(level), mix: slopeOf(mix), net: slopeOf(net) };
  }
  return res;
}
// Least-squares slope (with intercept) of y on x; standard error from ten interleaved groups.
function slopeOf(rows) {
  if (rows.length < 200) return { slope: null, stderr: null, sdX: null };
  const fit = a => { const mx = mean(a.map(r => r.x)), my = mean(a.map(r => r.y)); let sxx = 0, sxy = 0; for (const r of a) { sxx += (r.x - mx) ** 2; sxy += (r.x - mx) * (r.y - my); } return sxx > 0 ? sxy / sxx : null; };
  const slope = fit(rows), parts = [];
  for (let i = 0; i < 10; i++) { const s = fit(rows.filter((_, k) => k % 10 === i)); if (s != null) parts.push(s); }
  const sd = sdOf(parts);
  return { slope: slope != null ? parseFloat(slope.toFixed(3)) : null, stderr: sd != null ? parseFloat((sd / Math.sqrt(parts.length)).toFixed(3)) : null, sdX: parseFloat(sdOf(rows.map(r => r.x)).toFixed(3)) };
}


// ── a player's own record without a particular teammate ────────────────────────────────────────────────
// The league-wide teammate-out lift says how much a typical player gains when a regular is out. Some players gain much more (or nothing) when a
// specific teammate sits. For every game where a regular teammate was absent, this compares three predictions of the player's stat, using only his
// games before it (this season and the earlier ones): his baseline alone, the baseline plus the league-wide lift, and the baseline plus his own lift
// in earlier games where the same teammate(s) were out, pulled toward the league-wide figure by `k` games' worth of weight.
// `seasons` is oldest first: [{ players, season }]; `shares` is missingShares() over all of them; `slopes` the league-wide lifts by stat.
function fitPairWithout(seasons, shares, slopes, levelParams = {}, { ks = [3, 8, 15, 30, 60], minRecentMin = 12 } = {}) {
  const hist = new Map();                                    // playerId -> chronological rows { season, key, date, missing, y: {stat: actual/pred-1}, pred, actual, recent }
  for (const s of seasons) {
    for (const [id, p] of s.players) {
      if (p.games.length < 14) continue;
      const pid = p.id ?? id;
      if (!hist.has(pid)) hist.set(pid, []);
      const rows = new Map();                                // game index -> row
      for (const stat of STATS) {
        const h = levelParams[stat]?.halfLife || 8, l = levelParams[stat]?.lambda ?? 0.8;
        for (const r of walkLevels(p.games, stat, { halfLife: h, lambda: l })) {
          const g = p.games[r.i];
          if (!rows.has(r.i)) { const key = `${g.gameId}|${g.teamId}`, sh = shares.get(key); rows.set(r.i, { season: s.season, key, date: g.date, missing: sh ? sh.missing : new Set(), frac: sh ? sh.frac : null, recent: mean(p.games.slice(Math.max(0, r.i - 10), r.i).map(x => x.MIN)), pred: {}, actual: {} }); }
          const row = rows.get(r.i); row.pred[stat] = r.pred; row.actual[stat] = r.actual;
        }
      }
      for (const row of [...rows.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1])) hist.get(pid).push(row);
    }
  }
  for (const list of hist.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const res = {};
  for (const stat of STATS) {
    const slope = slopes?.[stat] ?? 0;
    const per = {};                                          // season -> { n, base, league, pair: {k: sum abs err} }
    for (const list of hist.values()) {
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row.missing.size || !row.frac || !(row.pred[stat] > 0.3) || !(row.recent >= minRecentMin)) continue;
        const L = slope * row.frac[stat];
        let n = 0, sum = 0;
        for (let j = 0; j < i; j++) {
          const o = list[j]; if (o.y === undefined) { /* computed lazily below */ }
          if (!o.missing.size || !(o.pred[stat] > 0.3)) continue;
          let overlap = 0; for (const m of row.missing) if (o.missing.has(m)) overlap++;
          if (!overlap) continue;
          const w = overlap / row.missing.size;
          n += w; sum += w * (o.actual[stat] / o.pred[stat] - 1);
        }
        const P = n > 0 ? sum / n : 0, a = row.actual[stat], pr = row.pred[stat];
        const e = per[row.season] || (per[row.season] = { n: 0, base: 0, league: 0, sqBase: 0, sqLeague: 0, sxy: 0, sxx: 0, biasBase: 0, biasLeague: 0, pair: Object.fromEntries(ks.map(k => [k, 0])), pairN: 0 });
        e.n++; e.base += Math.abs(a - pr); e.league += Math.abs(a - pr * (1 + L)); e.sxy += (a - pr) * (pr * L); e.sxx += (pr * L) ** 2; e.sqBase += (a - pr) ** 2; e.sqLeague += (a - pr * (1 + L)) ** 2; e.biasBase += a - pr; e.biasLeague += a - pr * (1 + L); if (n >= 1) e.pairN++;
        for (const k of ks) e.pair[k] += Math.abs(a - pr * (1 + (n * P + k * L) / (n + k)));
      }
    }
    res[stat] = per;
  }
  return res;
}

module.exports = { fitPairWithout, allowedByGroup, fitPositionAllowed, groupOfPosition, fitRest, STATS, KEY, prepareTeams, preparePlayers, walkLevels, fitLevel, fitSpread, minutesRows, fitMinutes, missingShares, fitTeammateOut, levelRows, mae, mean, sdOf, HALF_LIVES, LAMBDAS };
