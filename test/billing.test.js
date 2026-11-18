const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/db');
const B = require('../lib/billing');

const SECRET = 'whsec_test_secret';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const sec = ms => Math.floor(ms / 1000);
const body = o => Buffer.from(JSON.stringify(o));

// ── webhook signature ──
test('a correctly signed webhook is accepted and parsed', () => {
  const raw = body({ id: 'evt_1', type: 'x' });
  const ev = B.verifyWebhook(raw, B.signWebhook(raw, SECRET, sec(NOW)), SECRET, { now: NOW });
  assert.equal(ev.id, 'evt_1');
});
test('a tampered body, wrong secret, or missing signature is refused', () => {
  const raw = body({ id: 'evt_1', amount: 100 }), good = B.signWebhook(raw, SECRET, sec(NOW));
  const bad = fn => assert.throws(fn);
  bad(() => B.verifyWebhook(body({ id: 'evt_1', amount: 1 }), good, SECRET, { now: NOW }));       // changed after signing
  bad(() => B.verifyWebhook(raw, B.signWebhook(raw, 'whsec_other', sec(NOW)), SECRET, { now: NOW }));
  bad(() => B.verifyWebhook(raw, '', SECRET, { now: NOW }));
  bad(() => B.verifyWebhook(raw, undefined, SECRET, { now: NOW }));
  bad(() => B.verifyWebhook(raw, 't=abc,v1=zz', SECRET, { now: NOW }));
  bad(() => B.verifyWebhook(raw, `t=${sec(NOW)},v1=`, SECRET, { now: NOW }));
  bad(() => B.verifyWebhook(raw, `t=${sec(NOW)},v1=${'0'.repeat(64)}`, SECRET, { now: NOW }));
  bad(() => B.verifyWebhook(raw, good, '', { now: NOW }));                                        // no secret configured: never accept
  bad(() => B.verifyWebhook(JSON.stringify({ id: 1 }), good, SECRET, { now: NOW }));              // must be the raw bytes
});
test('an old signed request cannot be replayed', () => {
  const raw = body({ id: 'evt_1' });
  const old = B.signWebhook(raw, SECRET, sec(NOW) - 10 * 60);
  assert.throws(() => B.verifyWebhook(raw, old, SECRET, { now: NOW }), /window/);
  assert.ok(B.verifyWebhook(raw, B.signWebhook(raw, SECRET, sec(NOW) - 4 * 60), SECRET, { now: NOW }));   // within 5 minutes is fine
});
test('Stripe may send several signatures; any valid one is enough', () => {
  const raw = body({ id: 'e' }), good = B.signWebhook(raw, SECRET, sec(NOW)).split(',')[1];
  assert.ok(B.verifyWebhook(raw, `t=${sec(NOW)},v1=${'a'.repeat(64)},${good}`, SECRET, { now: NOW }));
});

// ── who is Pro ──
const day = 86400e3, iso = ms => new Date(ms).toISOString();
test('pro means comped, active, or trialing; past_due keeps a short grace; everything else is free', () => {
  const u = { comped: 0 }, sub = (status, endOffset = 5 * day) => ({ status, current_period_end: iso(NOW + endOffset) });
  assert.equal(B.isPro(null, null, NOW), false);
  assert.equal(B.isPro(u, null, NOW), false);
  assert.equal(B.isPro({ comped: 1 }, null, NOW), true);
  assert.equal(B.isPro(u, sub('active'), NOW), true);
  assert.equal(B.isPro(u, sub('trialing'), NOW), true);
  assert.equal(B.isPro(u, sub('past_due', -1 * day), NOW), true);          // payment failing, 1 day past the period: still in grace
  assert.equal(B.isPro(u, sub('past_due', -4 * day), NOW), false);         // grace is over
  for (const st of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', null, 'hacked']) assert.equal(B.isPro(u, sub(st), NOW), false, String(st));
});
test('planInfo reports the plan and the renewal details', () => {
  const info = B.planInfo({ comped: 0 }, { status: 'active', current_period_end: iso(NOW + day), cancel_at_period_end: 1, customer_id: 'cus_1' }, NOW);
  assert.deepEqual(info, { plan: 'pro', comped: false, status: 'active', renewsAt: iso(NOW + day), cancelAtPeriodEnd: true, hasCustomer: true });
  assert.equal(B.planInfo({ comped: 0 }, null, NOW).plan, 'free');
});

// ── events ──
function world() {
  const store = createStore({ dbPath: ':memory:' });
  const id = store.createUser('a@x.com'); store.setCustomer(id, 'cus_1');
  const sub = (o = {}) => ({ id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: sec(NOW + 30 * day), cancel_at_period_end: false, items: { data: [{ price: { id: 'price_1' } }] }, ...o });
  const ev = (type, object, created) => ({ id: 'evt_' + created + type, type, created, data: { object } });
  const apply = e => B.handleEvent({ store, event: e });
  return { store, id, sub, ev, apply, plan: () => B.planInfo(store.userById(id), store.getBilling(id), NOW).plan };
}
test('a new subscription makes the account Pro; deleting it makes it free', () => {
  const w = world();
  assert.equal(w.plan(), 'free');
  const r = w.apply(w.ev('customer.subscription.created', w.sub(), 100));
  assert.equal(r.handled, true); assert.equal(w.plan(), 'pro');
  assert.equal(w.store.getBilling(w.id).price_id, 'price_1');
  w.apply(w.ev('customer.subscription.deleted', w.sub({ status: 'active' }), 200));
  assert.equal(w.plan(), 'free'); assert.equal(w.store.getBilling(w.id).status, 'canceled');
});
test('cancelling at period end keeps Pro until it actually ends', () => {
  const w = world();
  w.apply(w.ev('customer.subscription.created', w.sub(), 100));
  w.apply(w.ev('customer.subscription.updated', w.sub({ cancel_at_period_end: true }), 150));
  assert.equal(w.plan(), 'pro'); assert.equal(B.planInfo(w.store.userById(w.id), w.store.getBilling(w.id), NOW).cancelAtPeriodEnd, true);
});
test('events that arrive out of order cannot undo a newer state', () => {
  const w = world();
  w.apply(w.ev('customer.subscription.deleted', w.sub(), 300));
  const late = w.apply(w.ev('customer.subscription.updated', w.sub({ status: 'active' }), 200));   // an old "active" arriving after the cancellation
  assert.equal(late.applied, false); assert.equal(w.plan(), 'free');
});
test('the period end is read from the item on newer API versions', () => {
  const w = world(); const s = w.sub(); delete s.current_period_end; s.items.data[0].current_period_end = sec(NOW + 9 * day);
  w.apply(w.ev('customer.subscription.created', s, 1));
  assert.equal(w.store.getBilling(w.id).current_period_end, iso(sec(NOW + 9 * day) * 1000));
});
test('an unknown customer is ignored; the metadata user id is a fallback only for real users', () => {
  const w = world();
  assert.equal(w.apply(w.ev('customer.subscription.created', w.sub({ customer: 'cus_ghost' }), 1)).handled, false);
  assert.equal(w.apply(w.ev('customer.subscription.created', w.sub({ customer: 'cus_new', metadata: { user_id: String(w.id) } }), 2)).handled, true);
  assert.equal(w.apply(w.ev('customer.subscription.created', w.sub({ customer: 'cus_x', metadata: { user_id: '9999' } }), 3)).handled, false);
});
test('checkout completion links the customer to the account that started it', () => {
  const w = world();
  const r = w.apply(w.ev('checkout.session.completed', { client_reference_id: String(w.id), customer: 'cus_77' }, 1));
  assert.equal(r.handled, true); assert.equal(w.store.getBilling(w.id).customer_id, 'cus_77');
  assert.equal(w.apply(w.ev('checkout.session.completed', { client_reference_id: '4242', customer: 'cus_1' }, 2)).handled, false);
});
test('a failed payment is logged for the admin and other events are ignored', () => {
  const w = world();
  assert.equal(w.apply(w.ev('invoice.payment_failed', { customer: 'cus_1' }, 1)).handled, true);
  assert.match(w.store.recentEvents(5)[0].message, /payment failed/);
  assert.equal(w.apply(w.ev('charge.refunded', { customer: 'cus_1' }, 2)).handled, false);
  assert.equal(B.handleEvent({ store: w.store, event: { type: 'x' } }).handled, false);
});
test('a replayed event id is recognised once', () => {
  const { store } = world();
  assert.equal(store.recordStripeEvent('evt_9', 't'), true);
  assert.equal(store.recordStripeEvent('evt_9', 't'), false);
  store.forgetStripeEvent('evt_9');
  assert.equal(store.recordStripeEvent('evt_9', 't'), true);   // a failed handler releases it so Stripe's retry works
});

// ── Stripe requests ──
test('nested values and lists are form-encoded the way Stripe expects', () => {
  const f = B.formString({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { user_id: '7' }, skip: undefined, nothing: null });
  assert.equal(decodeURIComponent(f), 'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[user_id]=7');
});
test('the client sends the right requests with the secret key', async () => {
  const calls = [];
  const c = B.createStripeClient({ secretKey: 'sk_test_x', base: 'http://stripe.local', http: async (m, url, form, h) => { calls.push({ m, url, form: decodeURIComponent(form || ''), h }); return { id: 'x', url: 'https://checkout.stripe.com/c/1' }; } });
  await c.createCheckoutSession({ customer: 'cus_1', priceId: 'price_1', userId: 5, successUrl: 'https://s/ok', cancelUrl: 'https://s/no' });
  assert.equal(calls[0].m, 'POST'); assert.equal(calls[0].url, 'http://stripe.local/v1/checkout/sessions');
  assert.equal(calls[0].h.Authorization, 'Bearer sk_test_x');
  for (const frag of ['mode=subscription', 'customer=cus_1', 'client_reference_id=5', 'line_items[0][price]=price_1', 'success_url=https://s/ok', 'subscription_data[metadata][user_id]=5', 'allow_promotion_codes=true']) assert.ok(calls[0].form.includes(frag), frag);
  assert.ok(!calls[0].form.includes('automatic_tax'));
  await c.createCheckoutSession({ customer: 'c', priceId: 'p', userId: 1, successUrl: 'a', cancelUrl: 'b', automaticTax: true });
  assert.ok(calls[1].form.includes('automatic_tax[enabled]=true'));
  await c.cancelSubscription('sub_1'); assert.equal(calls[2].m, 'DELETE'); assert.equal(calls[2].url, 'http://stripe.local/v1/subscriptions/sub_1');
});
test('price labels read like a price', () => {
  assert.equal(B.priceLabel({ unit_amount: 1200, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }), '$12.00 / month');
  assert.equal(B.priceLabel({ unit_amount: 9900, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } }), '$99.00 / year');
  assert.equal(B.priceLabel({ unit_amount: 3000, currency: 'usd', recurring: { interval: 'month', interval_count: 3 } }), '$30.00 / 3 month');
  assert.equal(B.priceLabel(null), null);
});

// ── analysis tickets and the daily limit ──
function tickets() {
  const store = createStore({ dbPath: ':memory:' }), uid = store.createUser('a@x.com'), day = '2026-10-10';
  const exp = ms => new Date(Date.now() + ms).toISOString();
  return { store, uid, day, exp };
}
test('an analysis counts only once it has finished', () => {
  const { store, uid, day, exp } = tickets();
  store.startTicket({ hash: 'h1', userId: uid, day, expiresAt: exp(60000) });
  assert.equal(store.analysesDone(uid, day), 0);                    // started, not finished: no charge against the limit
  assert.equal(store.finishTicket('h1'), true);
  assert.equal(store.analysesDone(uid, day), 1);
  assert.equal(store.finishTicket('h1'), false);                    // cannot be counted, or used, twice
  assert.equal(store.getTicket('h1'), null);
});
test('a ticket allows a few data calls and two AI calls, then stops', () => {
  const { store, uid, day, exp } = tickets();
  store.startTicket({ hash: 'h1', userId: uid, day, expiresAt: exp(60000) });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => store.useTicket('h1', 'ctx', 4)), [true, true, true, true, false]);
  assert.deepEqual([1, 2, 3].map(() => store.useTicket('h1', 'ai', 2)), [true, true, false]);
});
test('an expired ticket is dead, and starting a new analysis closes the old one', () => {
  const { store, uid, day, exp } = tickets();
  store.startTicket({ hash: 'old', userId: uid, day, expiresAt: new Date(Date.now() - 1000).toISOString(), now: new Date(Date.now() - 5000).toISOString() });
  assert.equal(store.getTicket('old'), null);
  store.startTicket({ hash: 'a', userId: uid, day, expiresAt: exp(60000) });
  store.startTicket({ hash: 'b', userId: uid, day, expiresAt: exp(60000) });
  assert.equal(store.getTicket('a'), null); assert.ok(store.getTicket('b'));
  assert.equal(store.ticketsStarted(uid, day), 3);
});
test('tickets are per person and per day', () => {
  const { store, uid, day, exp } = tickets(), other = store.createUser('b@x.com');
  store.startTicket({ hash: 'a', userId: uid, day, expiresAt: exp(60000) }); store.finishTicket('a');
  assert.equal(store.analysesDone(other, day), 0);
  assert.equal(store.analysesDone(uid, '2026-10-11'), 0);
});
test('deleting an account removes its billing record and tickets', () => {
  const { store, uid, day, exp } = tickets();
  store.setCustomer(uid, 'cus_1'); store.startTicket({ hash: 'a', userId: uid, day, expiresAt: exp(60000) });
  store.deleteUser(uid);
  assert.equal(store.getBilling(uid), null); assert.equal(store.ticketsStarted(uid, day), 0);
});

test('a real-shaped, deeply nested subscription event is not what the input guard is for', () => {
  const sec = require('../lib/security');
  const event = { id: 'evt', data: { object: { items: { data: [{ price: { recurring: { interval: 'month' } } }] } } } };
  assert.match(sec.bodyProblem(event), /deeply nested/);        // the ordinary guard would refuse it, so the webhook route skips that guard
});
