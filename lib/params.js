// The model's tuned numbers live in model_params.json (written by `npm run lab`, or edited by hand), not in the code, so they can be
// refitted from results without touching the engine. Anything missing from the file falls back to DEFAULTS below.
const fs = require('fs'), path = require('path');

const DEFAULTS = {
  version: 1,
  market: {
    // Share of the final win chance that comes from the model (the rest is the books' fair price). Fitted on graded picks: the model's
    // chance added almost nothing once the market's price was known (best weight about 3%).
    weightModelProb: { default: 0.05, points: 0.03, assists: 0.05 },
    // Share of the displayed projection that comes from the model (the rest is the books' consensus line). On 647 graded picks the
    // best mix was about 15% model; points 10%. Assists were cut from 25% to 5% (and the win-chance weight from 12% to 5%) on 193 graded scan props:
    // the model's disagreement with the line explained essentially none of what happened (slope 0.02 +/- about 0.15), also after the bias correction.
    weightModelMean: { default: 0.15, points: 0.10, assists: 0.05 },
    minEv: 0.03,                        // a prop counts as a pick when its expected value per $1 is at least this
    modelOnlyKeep: 0.5,                 // with no market at all: how much of the model's log-odds is kept (1 = all of it)
    bookWeights: {},                    // e.g. { "Pinnacle": 2 } to count a sharper book for more
  },
  // Spread of outcomes around the number: sd = a + b * level. Measured as SD(actual - line) on graded picks.
  spread: {
    points: { a: 4.5, b: 0.13 }, assists: { a: 1.6, b: 0.25 }, rebounds: { a: 1.2, b: 0.35 },
    // count stats: variance = phi x mean (the old floors gave steals a variance of about 0.4 x mean; real outcomes run about 1.1 x)
    '3pm': { phi: 1.24 }, steals: { phi: 1.12 }, blocks: { phi: 1.18 },
  },
  decay: { halfLifeGames: {}, lambda: {} },       // filled by the lab only when decay beats the fixed windows by 1% or more; empty keeps the windows
  // Second night of a back-to-back, given that the player plays. The old model cut minutes 4% and everything else 8% on top. Measured on
  // two full seasons (games where every regular was present, versus well-rested games) there is no such penalty: minutes +1.7% (+/-0.7), points +0.2% (+/-1.4).
  rest: { minutes: 1.0, stats: 1.0 },
  minutes: {},
  // When a regular rotation player is out, the others produce more by (slope x the share of the team's production that is missing).
  // Fitted on two seasons (23,510 games with someone out; every slope within +/-0.1 of its estimate). Minutes carry part of it.
  // What a defense gives up to a player's group (guards, forwards, centers) in a stat, beyond its overall points allowed, predicts that stat
  // for rebounds, assists, threes, steals and blocks (not points). sens = change in a player's stat per 1.0 of difference, fitted on two seasons
  // (`npm run lab`, section 6; both seasons agreed). shrinkGames pulls a defense toward the league average while it has played few games; cap limits the adjustment.
  positionAllowed: { sens: { rebounds: 0.2, assists: 0.42, '3pm': 0.29, steals: 0.46, blocks: 0.51 }, shrinkGames: 10, cap: 0.06 },
  // How much more the others produce when a regular is out, per 1.0 of the team's production that is missing. The lab first fitted these on all
  // games (points .61, rebounds .48, assists .73, threes .63, steals .49, blocks .20), then found the lift too big when checked game by game on each
  // season (best size about 0.40-0.50 of it for points, rebounds, assists and threes, about 0.15 for steals, nothing for blocks; both seasons agreed),
  // so these are the fitted values times that size. minutesSlope is scaled the same way so the split between minutes and rate stays the same.
  usage: { sens: { points: 0.29, rebounds: 0.23, assists: 0.30, '3pm': 0.22, steals: 0.08, blocks: 0 }, minutesSlope: 0.18 },
};

function merge(base, over) {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null) ? merge(base[k], v) : v;
  }
  return out;
}

// A bad number in the file (a typo, NaN, a negative weight, a string) must not be able to quietly break every probability. Each value is held to a sane
// range; anything invalid or out of range is replaced by the default for that entry, and the problems are listed in info().
const isNum = v => typeof v === 'number' && isFinite(v);
const RANGES = {
  'market.minEv': [-0.5, 0.5], 'positionAllowed.shrinkGames': [0, 60], 'positionAllowed.cap': [0, 0.2], 'market.modelOnlyKeep': [0, 1], 'rest.minutes': [0.8, 1.1], 'rest.stats': [0.8, 1.1], 'usage.minutesSlope': [0, 1.5],
};
const TABLE_RANGES = {                                   // every entry of these tables
  'market.weightModelProb': [0, 1], 'market.weightModelMean': [0, 1], 'market.bookWeights': [0, 10], 'usage.sens': [0, 1.5], 'positionAllowed.sens': [0, 1.5],
  'decay.halfLifeGames': [1, 100], 'decay.lambda': [0, 1],
};
const dig = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function sanitize(cfg) {
  const problems = [];
  const setAt = (path, v) => { const ks = path.split('.'), last = ks.pop(); const parent = ks.reduce((a, k) => (a[k] = a[k] && typeof a[k] === 'object' ? a[k] : {}), cfg); if (v === undefined) delete parent[last]; else parent[last] = v; };
  const defaultAt = path => dig(DEFAULTS, path);
  for (const [path, [lo, hi]] of Object.entries(RANGES)) { const v = dig(cfg, path); if (v !== undefined && !(isNum(v) && v >= lo && v <= hi)) { problems.push(`${path}=${JSON.stringify(v)}`); setAt(path, defaultAt(path)); } }
  for (const [path, [lo, hi]] of Object.entries(TABLE_RANGES)) {
    const t = dig(cfg, path); if (t === undefined) continue;
    if (!t || typeof t !== 'object' || Array.isArray(t)) { problems.push(`${path} is not a table`); setAt(path, defaultAt(path)); continue; }
    for (const [k, v] of Object.entries(t)) if (!(isNum(v) && v >= lo && v <= hi)) { problems.push(`${path}.${k}=${JSON.stringify(v)}`); const d = defaultAt(path)?.[k]; if (d === undefined) delete t[k]; else t[k] = d; }
  }
  const sp = cfg.spread;
  if (sp && typeof sp === 'object') for (const [k, e] of Object.entries(sp)) {
    const ok = e && typeof e === 'object' && (('phi' in e) ? isNum(e.phi) && e.phi >= 0.2 && e.phi <= 6 : isNum(e.a) && isNum(e.b) && e.a >= 0 && e.a <= 30 && e.b >= 0 && e.b <= 2);
    if (!ok) { problems.push(`spread.${k}=${JSON.stringify(e)}`); if (DEFAULTS.spread[k]) sp[k] = DEFAULTS.spread[k]; else delete sp[k]; }
  }
  return problems;
}

let current = DEFAULTS, loadedFrom = null, loadProblems = [];
function load(file = path.join(__dirname, '..', 'model_params.json')) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = merge(DEFAULTS, parsed);
    loadProblems = sanitize(merged);
    if (loadProblems.length) console.warn('[Params] ignored invalid values in model_params.json, using defaults for them:', loadProblems.join(', '));
    current = merged; loadedFrom = file;
  } catch (_) { current = DEFAULTS; loadedFrom = null; loadProblems = []; }
  return current;
}
const get = () => current;
const info = () => ({ loadedFrom, version: current.version, fittedAt: current.fittedAt || null, ignored: loadProblems });

// A per-prop-type table with a "default" entry: { default: 0.1, points: 0.05 } -> 0.05 for points, 0.1 for anything else.
const forProp = (table, propType, fallback = 0) => {
  if (!table || typeof table !== 'object') return fallback;
  const v = table[propType] ?? table.default;
  return typeof v === 'number' && isFinite(v) ? v : fallback;
};
// sd of the outcome around a number `level`, or null when the lab has no fitted spread for this stat.
const spreadSd = (propType, level) => {
  const s = current.spread && current.spread[propType];
  if (!s) return null;
  if (typeof s.phi === 'number' && s.phi > 0) return Math.max(0.3, Math.sqrt(s.phi * Math.max(level, 0.1)));
  return typeof s.a === 'number' && typeof s.b === 'number' ? Math.max(0.3, s.a + s.b * Math.max(0, level)) : null;
};
// How much of a stat's teammate-out lift is carried by extra minutes (the rest is a higher rate per minute). Both channels read this one number
// so they always multiply back to the measured total. Capped: a stat whose total lift is below the minutes lift (blocks) is mostly minutes.
const usageMinutesShare = propType => {
  const u = current.usage || {}, sens = u.sens && (u.sens[propType] ?? u.sens.points), min = u.minutesSlope;
  return typeof sens === 'number' && sens > 0 && typeof min === 'number' ? Math.min(0.9, Math.max(0.1, min / sens)) : 0.35;
};

module.exports = { DEFAULTS, merge, sanitize, load, get, info, forProp, spreadSd, usageMinutesShare };
