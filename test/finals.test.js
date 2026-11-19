const test = require('node:test');
const assert = require('node:assert/strict');
const { finalTeams, anyFinal } = require('../lib/finals');

const ev = (status, a, b, completed) => ({ competitions: [{ status: { type: { name: status, completed } }, competitors: [{ team: { abbreviation: a } }, { team: { abbreviation: b } }] }] });

test('only teams in a finished game count as final', () => {
  const f = finalTeams([ev('STATUS_FINAL', 'PHI', 'ORL'), ev('STATUS_IN_PROGRESS', 'LAL', 'DEN'), ev('STATUS_SCHEDULED', 'BOS', 'NYK')]);
  assert.deepEqual([...f].sort(), ['orl', 'phi']);
});
test('a game flagged completed counts even if the status name differs', () => {
  assert.ok(finalTeams([ev('STATUS_FULL_TIME', 'LV', 'SEA', true)]).has('lv'));
});
test('missing or odd events are ignored, not thrown on', () => {
  assert.equal(finalTeams(undefined).size, 0);
  assert.equal(finalTeams([null, {}, { competitions: [] }]).size, 0);
});
test('anyFinal matches either team of the pick, case-insensitively, and ignores blanks', () => {
  const f = finalTeams([ev('STATUS_FINAL', 'PHI', 'ORL')]);
  assert.equal(anyFinal(f, [undefined, 'ORL']), true);
  assert.equal(anyFinal(f, ['LAL', null]), false);
  assert.equal(anyFinal(f, []), false);
});

test('names from the two feeds match through accents, Jr. and punctuation', () => {
  const { normName } = require('../lib/finals');
  assert.equal(normName('Luka Dončić'), normName('Luka Doncic'));
  assert.equal(normName('Jaren Jackson Jr.'), normName('Jaren Jackson'));
  assert.equal(normName("De'Aaron Fox"), normName('De Aaron Fox'));
});
test('the box score says did-not-play, played, or not listed', () => {
  const { playerDidNotPlay } = require('../lib/finals');
  const box = [{ statistics: [{ athletes: [{ athlete: { displayName: 'Tyrese Maxey' }, didNotPlay: true }, { athlete: { displayName: 'Paul George' }, didNotPlay: false }] }] }];
  assert.equal(playerDidNotPlay(box, 'Tyrese Maxey'), true);
  assert.equal(playerDidNotPlay(box, 'Paul George'), false);
  assert.equal(playerDidNotPlay(box, 'Nobody'), null);
  assert.equal(playerDidNotPlay(undefined, 'Nobody'), null);
});
