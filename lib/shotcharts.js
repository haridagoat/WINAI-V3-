// Shot charts built on the owner's computer and uploaded (scripts/build-shotcharts.js), for hosts where nba.com refuses the live fetch.
// One file per league, "shotcharts_nba.json": { builtAt, season, charts: { "player|nikola jokic": <what shotchart.py printed>, "defense|denver nuggets": ... } }.
// Keys ignore accents, dots, hyphens and case, so "Nikola Jokic" finds "Nikola Jokić". Pure except for reading the one file.
const fs = require('fs');
const path = require('path');

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’-]/g, '').replace(/\s+/g, ' ').trim();
const keyOf = (mode, name) => `${mode === 'defense' ? 'defense' : 'player'}|${norm(name)}`;
const fileFor = (dir, league) => path.join(dir, `shotcharts_${league === 'wnba' ? 'wnba' : 'nba'}.json`);

// Reads the bundle again only when the file changes.
function createBundleReader(dir) {
  const cache = {};
  return function read(league) {
    const file = fileFor(dir, league);
    let st; try { st = fs.statSync(file); } catch (_) { return null; }
    const c = cache[file];
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.bundle;
    let bundle = null;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.charts && typeof j.charts === 'object') bundle = j; } catch (_) {}
    cache[file] = { mtimeMs: st.mtimeMs, size: st.size, bundle };
    return bundle;
  };
}

// The chart as the live script would have printed it, marked with where it came from, or null when the bundle has no such player/team.
function lookup(bundle, mode, name) {
  if (!bundle || !bundle.charts) return null;
  const c = bundle.charts[keyOf(mode, name)];
  if (!c || c.error) return null;
  return { ...c, source: 'uploaded', builtAt: bundle.builtAt || null };
}

module.exports = { norm, keyOf, fileFor, createBundleReader, lookup };
