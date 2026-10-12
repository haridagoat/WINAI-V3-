const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/freshness');
const H = 3600e3, D = 24 * H, NOW = Date.parse('2026-10-12T15:00:00Z');
const base = over => ({ now: NOW, oddsConfigured: true, odds: { checkedAt: new Date(NOW - 8 * 60e3).toISOString() }, statMtimes: { nba: NOW - 3 * H, wnba: NOW - 3 * H }, inSeason: () => true, ...over });

test('ages are written in plain words', () => {
  assert.equal(F.ago(10e3), 'just now'); assert.equal(F.ago(8 * 60e3), '8 min ago'); assert.equal(F.ago(H), '1 hour ago');
  assert.equal(F.ago(5 * H), '5 hours ago'); assert.equal(F.ago(20 * H), '20 hours ago'); assert.equal(F.ago(3 * D), '3 days ago'); assert.equal(F.ago(40 * H), '2 days ago');
});
test('everything fresh: labels say so and there is no banner', () => {
  const r = F.describe(base());
  assert.equal(r.odds.label, 'Odds updated 8 min ago'); assert.equal(r.odds.state, 'ok');
  assert.equal(r.stats.nba.label, 'NBA stats updated 3 hours ago'); assert.equal(r.stats.nba.state, 'ok');
  assert.equal(r.banner, null);
});
test('out of odds credits: a banner, and the label says paused', () => {
  const r = F.describe(base({ odds: { exhausted: true, checkedAt: new Date(NOW).toISOString() } }));
  assert.equal(r.odds.state, 'down'); assert.match(r.banner.text, /Live odds are paused/);
});
test('odds not connected: a banner', () => {
  const r = F.describe(base({ oddsConfigured: false }));
  assert.equal(r.odds.state, 'off'); assert.match(r.banner.text, /not connected/);
});
test('old odds with nothing wrong is only a label, never a banner', () => {
  const r = F.describe(base({ odds: { checkedAt: new Date(NOW - 3 * D).toISOString() } }));
  assert.equal(r.odds.state, 'old'); assert.equal(r.odds.label, 'Odds updated 3 days ago'); assert.equal(r.banner, null);
  assert.equal(F.describe(base({ odds: {} })).odds.state, 'idle');
});
test('stale stats in season warn; the same age out of season is just noted', () => {
  const inS = F.describe(base({ statMtimes: { nba: NOW - 18 * D, wnba: NOW - H } }));
  assert.equal(inS.stats.nba.state, 'old'); assert.match(inS.banner.text, /NBA stats are 18 days old/); assert.doesNotMatch(inS.banner.text, /WNBA/);
  const off = F.describe(base({ statMtimes: { nba: NOW - 18 * D, wnba: NOW - H }, inSeason: lg => lg === 'wnba' }));
  assert.equal(off.stats.nba.state, 'offseason'); assert.match(off.stats.nba.label, /^NBA stats from Sep 24 \(off season\)$/); assert.equal(off.banner, null);
});
test('a missing stat file warns only while the league is in season', () => {
  const inS = F.describe(base({ statMtimes: { nba: null, wnba: NOW } }));
  assert.equal(inS.stats.nba.state, 'missing'); assert.match(inS.banner.text, /NBA stats could not be found/);
  const off = F.describe(base({ statMtimes: { nba: null, wnba: NOW }, inSeason: lg => lg === 'wnba' }));
  assert.equal(off.stats.nba.state, 'offseason'); assert.equal(off.banner, null);
});
test('several problems share one banner; a clock slightly ahead never gives a negative age', () => {
  const r = F.describe(base({ oddsConfigured: false, statMtimes: { nba: NOW - 5 * D, wnba: NOW + 5 * 60e3 } }));
  assert.match(r.banner.text, /not connected/); assert.match(r.banner.text, /NBA stats are 5 days old/);
  assert.equal(r.stats.wnba.label, 'WNBA stats updated just now');
});
