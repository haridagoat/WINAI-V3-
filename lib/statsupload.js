// Stat files pushed from the owner's own computer.
// nba.com refuses requests from most cloud hosts, so on a host like Railway the Python scripts cannot fetch.
// The owner's own computer can, so it fetches and uploads the finished files instead (scripts/push-stats.js).
// Only names that look like the files the fetch scripts produce are accepted, so an upload can never write the
// app's own files (server.js, package.json, .env, the database...) or leave the folder.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^\.?(player_|team_|wnba_|playtype_|tracking_|hustle_|shotdash_|opp_shotdash_|defense_|dvp_|season_meta\.|shotchart_benchmark_)[A-Za-z0-9_.\-]*$/;
const MAX_FILES = 120;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const isStatsFileName = n => typeof n === 'string' && n.length <= 100 && n.endsWith('.json') && !n.includes('..') && NAME_RE.test(n);

// The request body is JSON: { files: { "player_stats.json": "<the file's text>", ... }, mtimes: { "player_stats.json": <ms since 1970>, ... } }.
// Returns { files, mtimes }, or throws a plain message.
function parseUpload(raw) {
  let body;
  try { body = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch (_) { throw new Error('The upload is not valid JSON.'); }
  const files = body && body.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Send { "files": { "name.json": "text" } }.');
  const names = Object.keys(files);
  if (!names.length) throw new Error('No files were sent.');
  if (names.length > MAX_FILES) throw new Error(`Too many files (${names.length}); the limit is ${MAX_FILES}.`);
  for (const n of names) {
    if (!isStatsFileName(n)) throw new Error(`"${String(n).slice(0, 60)}" is not a stats file name.`);
    const text = files[n];
    if (typeof text !== 'string' || !text.length) throw new Error(`${n} is empty.`);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(`${n} is too large.`);
    try { JSON.parse(text); } catch (_) { throw new Error(`${n} is not valid JSON, so it was not saved.`); }
  }
  // When each file was really fetched. Without it every upload would look brand new, and a day-old file would pass the freshness checks.
  const mtimes = {};
  const given = body.mtimes && typeof body.mtimes === 'object' && !Array.isArray(body.mtimes) ? body.mtimes : {};
  const now = Date.now();
  for (const n of names) { const t = Number(given[n]); if (Number.isFinite(t) && t > Date.parse('2020-01-01')) mtimes[n] = Math.min(t, now); }
  return { files, mtimes };
}

// Writes every file into each folder, through a temporary name so a reader never sees half a file.
function saveFiles(files, dirs, mtimes = {}) {
  const saved = [];
  for (const dir of dirs.filter(Boolean)) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const tmp = path.join(dir, `.${process.pid}.${name}.tmp`);
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path.join(dir, name));
      if (mtimes[name]) { const t = new Date(mtimes[name]); try { fs.utimesSync(path.join(dir, name), t, t); } catch (_) {} }
    }
  }
  for (const name of Object.keys(files)) saved.push(name);
  return saved;
}

// On start: bring back the files kept on the persistent volume if they are newer than what the app folder has (a fresh deploy has none).
function restoreFromKeep(keepDir, appDir) {
  let n = 0;
  let names;
  try { names = fs.readdirSync(keepDir); } catch (_) { return 0; }
  for (const name of names) {
    if (!isStatsFileName(name)) continue;
    try {
      const src = path.join(keepDir, name), dest = path.join(appDir, name);
      const s = fs.statSync(src);
      let d = null; try { d = fs.statSync(dest); } catch (_) {}
      if (d && d.mtimeMs >= s.mtimeMs) continue;
      fs.copyFileSync(src, dest);
      fs.utimesSync(dest, s.atime, s.mtime);
      n++;
    } catch (_) { /* one unreadable file must not stop the rest */ }
  }
  return n;
}

module.exports = { isStatsFileName, parseUpload, saveFiles, restoreFromKeep, MAX_FILES, MAX_FILE_BYTES };
