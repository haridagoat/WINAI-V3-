// The projection engine (lib/projection.js) built with plain fakes for what the server would pass in, so tests can call the real math directly.
const { create } = require('../../lib/projection');

// An absence cache that knows every player and says "not in his recent games, not in his season": a teammate's absence counts in full.
const everyAbsenceIsNew = () => new Proxy({}, { get: () => ({ lastPlayed: null, gamesThisSeason: 0 }) });

function makeProjection(over = {}) {
  return create({
    getBiasTable: () => ({}), gameDateISO: g => (g && g.date) || null, getLeagueBaselines: () => null, getLeagueFourFactors: () => null,
    injuryAbsenceCache: everyAbsenceIsNew(), loadDvp: () => null, loadNBAStats: () => null, ...over,
  });
}
module.exports = { makeProjection };
