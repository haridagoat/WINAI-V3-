// The daily grading report: what it sends, to whom, and that it never sends twice a day or leaks people's own props.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const { createStore } = require('../lib/db');
const { buildGradingReport } = require('../lib/report');
const { createMailer } = require('../lib/mailer');

const NOW = Date.parse('2026-11-04T11:00:00Z');                 // 6 AM Eastern on the 4th: the day being reported is the 3rd
function setup({ webhook = false, mail = false, adminEmail = '', picks = [] } = {}) {
  const store = createStore({ dbPath: ':memory:', log: () => {} });
  const sent = { webhook: [], mail: [] }; let mailFails = false;
  const alerts = { configured: webhook, notify: async m => { sent.webhook.push(m); return webhook ? { sent: true } : { sent: false, reason: 'no webhook configured' }; } };
  const mailer = { configured: mail, sendPlain: async m => { if (mailFails) throw new Error('Resend refused it: 403 domain not verified'); sent.mail.push(m); return { sent: true }; } };
  const env = { ADMIN_EMAIL: adminEmail };
  const f = extract({
    functions: ['collectReportInputs', 'sendGradingReport', 'parseMeta'],
    globals: { store, biasTable: {}, loadCLV: () => picks, gradeDateOf: e => e.date, currentCreditBudget: () => ({ known: true, remaining: 231 }), get calibrationModel() { return { active: false, reason: 'Needs 60.' }; },
      buildGradingReport, toLocalDateStr: d => new Date(d).toISOString().slice(0, 10), Date: Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(NOW); }, { now: () => NOW, UTC: Date.UTC, parse: Date.parse }), alerts, mailer, process: { env }, console },
  });
  return { f, store, sent, failMail: () => { mailFails = true; } };
}
const pick = (over = {}) => ({ id: Math.random(), source: 'auto', league: 'nba', date: '2026-11-03', result: 'WIN', player: 'Jalen Brunson', propType: 'points', verdict: 'OVER', line: 20.5, actualStat: 25, ...over });

test('builds yesterday\'s report, saves it, logs it, and says where it went', async () => {
  const { f, store } = setup({ picks: [pick(), pick({ result: 'LOSS', player: 'Karl-Anthony Towns' })] });
  const out = await f.sendGradingReport();
  assert.match(out, /2 picks graded, 1-1/); assert.match(out, /the admin page only/);
  const last = JSON.parse(store.getMeta('grading-report:last')); assert.equal(last.date, '2026-11-03'); assert.match(last.text, /Jalen Brunson OVER 20.5 pts/);
  assert.equal(JSON.parse(store.getMeta('grading-report:history')).length, 1);
  assert.ok(store.recentEvents(5).some(e => e.kind === 'grading-report' && /2 picks graded/.test(e.message)));
  assert.equal(store.getMeta('grading-report:date'), '2026-11-03');
});

test('it goes out once a day: a second run the same day does nothing, a forced one sends again', async () => {
  const { f, store, sent } = setup({ webhook: true, picks: [pick()] });
  await f.sendGradingReport(); assert.match(await f.sendGradingReport(), /already sent for 2026-11-03/); assert.equal(sent.webhook.length, 1);
  await f.sendGradingReport({ force: true }); assert.equal(sent.webhook.length, 2);
  assert.equal(JSON.parse(store.getMeta('grading-report:history')).length, 1, 'a rebuilt report replaces that day\'s earlier one');
  assert.ok(JSON.parse(store.getMeta('grading-report:history'))[0].data.picks, 'the saved report keeps its figures so the admin page can draw them');
});

test('with a webhook and an email address both get it; with only one, only that one', async () => {
  const both = setup({ webhook: true, mail: true, adminEmail: 'owner@example.com', picks: [pick()] });
  assert.match(await both.f.sendGradingReport(), /sent to: webhook \+ email/);
  assert.equal(both.sent.mail[0].to, 'owner@example.com'); assert.match(both.sent.mail[0].subject, /grading report: .*1 picks graded/); assert.match(both.sent.mail[0].text, /PICKS GRADED/);
  const noAddress = setup({ mail: true, adminEmail: '', picks: [pick()] }); await noAddress.f.sendGradingReport(); assert.equal(noAddress.sent.mail.length, 0, 'no address, no email');
  const noMailer = setup({ mail: false, adminEmail: 'owner@example.com', picks: [pick()] }); await noMailer.f.sendGradingReport(); assert.equal(noMailer.sent.mail.length, 0, 'email not configured, nothing sent');
});

test('a failing email is reported to the admin and does not lose the report or stop the day being recorded', async () => {
  const { f, store, failMail } = setup({ mail: true, adminEmail: 'owner@example.com', picks: [pick()] }); failMail();
  const spy = console.error; console.error = () => {};
  try { const out = await f.sendGradingReport(); assert.match(out, /1 picks graded/); } finally { console.error = spy; }
  assert.ok(store.recentEvents(5).some(e => e.level === 'warn' && /could not be sent/.test(e.message)));
  assert.ok(store.getMeta('grading-report:last')); assert.equal(store.getMeta('grading-report:date'), '2026-11-03');
});

test('only the system\'s own picks are in it, never people\'s saved props', async () => {
  const { f, store } = setup({ picks: [pick({ player: 'System Pick' }), pick({ source: undefined, player: 'Private Saved Prop', userId: 7 }), pick({ source: 'user', player: 'Another Private One' })] });
  await f.sendGradingReport(); const text = JSON.parse(store.getMeta('grading-report:last')).text;
  assert.match(text, /System Pick/); assert.ok(!/Private Saved Prop|Another Private One/.test(text));
});

test('a long report is shortened for Discord but kept whole on the admin page', async () => {
  const picks = Array.from({ length: 80 }, (_, i) => pick({ player: 'A very long player name '.repeat(7) + i, result: i % 2 ? 'WIN' : 'LOSS' }));
  const { f, sent, store } = setup({ webhook: true, picks }); await f.sendGradingReport();
  assert.ok(sent.webhook[0].message.length <= 1900, String(sent.webhook[0].message.length)); assert.match(sent.webhook[0].message, /full report on the admin page/);
  assert.ok(JSON.parse(store.getMeta('grading-report:last')).text.length > 1900, 'the saved copy is not shortened');
  assert.equal(sent.webhook[0].record, false, 'the report is not also logged as an alert');
});

test('a day with nothing graded still produces a report', async () => {
  const { f, store } = setup({ picks: [] }); assert.match(await f.sendGradingReport(), /no picks were graded/);
  assert.match(JSON.parse(store.getMeta('grading-report:last')).text, /PICKS GRADED: none/);
});

test('the mailer sends a plain message through Resend, and refuses when email is not set up', async () => {
  const posts = [];
  const m = createMailer({ apiKey: 'key', from: 'WIN AI <a@b.co>', post: async (url, body, cfg) => { posts.push({ url, body, cfg }); } });
  await m.sendPlain({ to: 'me@x.co', subject: 'Hello', text: 'Body' });
  assert.equal(posts[0].url, 'https://api.resend.com/emails'); assert.deepEqual(posts[0].body.to, ['me@x.co']); assert.equal(posts[0].body.text, 'Body'); assert.equal(posts[0].body.from, 'WIN AI <a@b.co>'); assert.match(posts[0].cfg.headers.Authorization, /^Bearer key$/);
  await assert.rejects(m.sendPlain({ to: 'me@x.co', subject: '', text: 'x' }), /required/);
  const off = createMailer({ post: async () => {}, devLinks: true }); await assert.rejects(off.sendPlain({ to: 'a@b.co', subject: 's', text: 't' }), /not configured/);
});

test('a manual send does not use up the day\'s automatic report', async () => {
  const { f, store, sent } = setup({ webhook: true, picks: [pick()] });
  await f.sendGradingReport({ force: true });
  assert.equal(store.getMeta('grading-report:date'), null, 'no automatic-send marker was set');
  assert.match(await f.sendGradingReport(), /1 picks graded/); assert.equal(sent.webhook.length, 2, 'the automatic one still went out');
  assert.match(await f.sendGradingReport(), /already sent/);
});
