// The columns each nba.com stat file must have for the projection to work. The files come from Python scripts that read nba.com, whose column names
// can change without warning; a renamed column would otherwise reach the projection as undefined and quietly change numbers. Pure functions.
//
// `cols` are the columns the projection reads from that file (kept to those it genuinely depends on, not every column in the file), `minRows` the fewest
// rows a healthy file has, and a column counts as present when at least `minFill` of the rows have a value for it.
const NBA = {
  player_stats: { cols: ['PLAYER_NAME', 'TEAM_ABBREVIATION', 'GP', 'MIN', 'PTS', 'REB', 'AST', 'FG3M', 'STL', 'BLK', 'FGM', 'FGA'], minRows: 250 },
  player_advanced: { cols: ['PLAYER_NAME', 'GP', 'MIN', 'USG_PCT', 'OFF_RATING', 'DEF_RATING'], minRows: 250 },
  team_advanced: { cols: ['TEAM_NAME', 'GP', 'OFF_RATING', 'DEF_RATING', 'PACE'], minRows: 30 },
  team_four_factors: { cols: ['TEAM_NAME', 'OPP_EFG_PCT', 'OPP_FTA_RATE', 'OPP_TOV_PCT', 'OPP_OREB_PCT'], minRows: 30 },
  team_opp_shooting: { cols: ['TEAM_NAME', 'OPP_FG_PCT', 'OPP_FG3_PCT'], minRows: 30 },
  team_defense: { cols: ['TEAM_NAME', 'DEF_RATING', 'STL', 'BLK'], minRows: 30 },
  team_scoring: { cols: ['TEAM_NAME', 'PCT_PTS_3PT', 'PCT_PTS_PAINT'], minRows: 30 },
};
const WNBA = {
  wnba_player_stats: { cols: ['PLAYER_NAME', 'TEAM_ABBREVIATION', 'GP', 'MIN', 'PTS', 'REB', 'AST', 'FG3M', 'STL', 'BLK', 'FGM', 'FGA'], minRows: 80 },
  wnba_team_advanced: { cols: ['TEAM_NAME', 'GP', 'OFF_RATING', 'DEF_RATING', 'PACE'], minRows: 10 },
};
const REQUIRED = { nba: NBA, wnba: WNBA };

// -> { problems: [text], rows } for one file's parsed JSON, or problems = ['not found'] / ['not a list of rows'] when it is missing or malformed.
function checkFile(data, spec, { minFill = 0.9 } = {}) {
  if (data == null) return { problems: ['not found'], rows: 0 };
  if (!Array.isArray(data)) return { problems: ['not a list of rows'], rows: 0 };
  const problems = [], n = data.length;
  if (n < spec.minRows) problems.push(`only ${n} rows (expected at least ${spec.minRows})`);
  if (n) {
    const missing = spec.cols.filter(c => data.filter(r => r && r[c] != null && r[c] !== '').length < Math.ceil(n * minFill));
    if (missing.length) problems.push(`missing or mostly empty: ${missing.join(', ')}`);
  }
  return { problems, rows: n };
}

// -> [{ file, problems }] for every file of a league that has a problem. `read(name)` returns the parsed file or null.
function checkLeague(league, read) {
  const out = [];
  for (const [file, spec] of Object.entries(REQUIRED[league] || {})) {
    const r = checkFile(read(file), spec);
    if (r.problems.length) out.push({ file: file + '.json', problems: r.problems });
  }
  return out;
}

module.exports = { REQUIRED, checkFile, checkLeague };
