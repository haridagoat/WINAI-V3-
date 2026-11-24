// A player's previous games with nba.com's tracking numbers, from gametrack_nba.json (scripts/build-gametrack.py, built on the owner's computer
// and uploaded because nba.com refuses the live host). Pure apart from reading that one file.
// Shape of the file: { builtAt, season, games: { "<gameId>": { date: "2026-11-19", tracked: true, players: { "<id>": { n, t, m, min, pts, reb, ast, ..., rc, orc, drc, pas, sast, fast, tch } } } } }
const fs = require('fs');
const path = require('path');

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’-]/g, '').replace(/\s+/g, ' ').trim();
const fileFor = dir => path.join(dir, 'gametrack_nba.json');

// Reads the file again only when it changes, and keeps a per-player index (normalised name -> that player's games, newest first).
function createReader(dir) {
  let cache = null;
  return function read() {
    const file = fileFor(dir);
    let st; try { st = fs.statSync(file); } catch (_) { return null; }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;
    let data = null;
    try { data = index(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) {}
    cache = { mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  };
}

function index(bundle) {
  if (!bundle || !bundle.games || typeof bundle.games !== 'object') return null;
  const byName = new Map();
  for (const [gid, g] of Object.entries(bundle.games)) {
    for (const [pid, p] of Object.entries(g.players || {})) {
      const k = norm(p.n); if (!k) continue;
      let a = byName.get(k); if (!a) byName.set(k, a = []);
      a.push({ gameId: gid, playerId: pid, date: g.date, tracked: !!g.tracked, ...p });
    }
  }
  for (const a of byName.values()) a.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { builtAt: bundle.builtAt || null, season: bundle.season || null, byName };
}

// The last `n` games (newest first) for a player, or null when the file is missing or has no such player.
function lookup(data, name, n = 20) {
  if (!data) return null;
  const rows = data.byName.get(norm(name));
  if (!rows || !rows.length) return null;
  const cap = Math.max(1, Math.min(40, parseInt(n, 10) || 20));
  const games = rows.slice(0, cap).map(r => {
    const m = String(r.m || ''); const away = m.includes('@'); const opp = m.split(/ @ | vs\. /)[1] || '';
    const g = { date: r.date, opp, home: !away, wl: r.wl || '', min: r.min, pts: r.pts, reb: r.reb, ast: r.ast, fg3m: r.fg3m, stl: r.stl, blk: r.blk };
    if (r.pot != null) g.potentialAst = r.pot;                 // nba.com's potential assists for that game (passes that would have been assists if the shot went in)
    if (r.tracked && r.rc != null) Object.assign(g, { rebChances: r.rc, orebChances: r.orc, drebChances: r.drc, passes: r.pas, secondaryAst: r.sast, ftAst: r.fast, touches: r.tch });
    return g;
  });
  return { name: rows[0].n, team: rows[0].t, builtAt: data.builtAt, season: data.season, games };
}

module.exports = { norm, fileFor, createReader, index, lookup };
