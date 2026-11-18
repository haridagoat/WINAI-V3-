// Subscriptions through Stripe. Card details never touch this server: checkout and the billing portal are
// Stripe's own hosted pages. This file only
//   - checks that a webhook really came from Stripe (verifyWebhook),
//   - turns a subscription into "pro or free" (isPro / planInfo),
//   - applies subscription events to the database (handleEvent), and
//   - makes the few Stripe API calls the app needs (createStripeClient).
// The plan is never taken from the browser. It only changes from a verified webhook or an admin grant.
const crypto = require('crypto');

const GRACE_MS = 3 * 24 * 3600 * 1000;      // a payment that failed keeps access this long past the period end
const ACTIVE = new Set(['active', 'trialing']);

// ── webhook signature (https://docs.stripe.com/webhooks#verify-manually) ──
// Stripe signs "<timestamp>.<raw body>" with the endpoint secret (HMAC-SHA256). The header carries the
// timestamp and one or more v1 signatures. Old timestamps are refused so a captured request can't be replayed.
function verifyWebhook(rawBody, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (!secret) throw new Error('webhook secret is not configured');
  if (!Buffer.isBuffer(rawBody)) throw new Error('raw body is required');
  const parts = String(header || '').split(',').map(p => p.trim().split('='));
  const t = parts.find(p => p[0] === 't')?.[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]).filter(Boolean);
  if (!t || !/^\d+$/.test(t) || !sigs.length) throw new Error('missing or malformed signature header');
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) throw new Error('signature timestamp is outside the allowed window');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  const ok = sigs.some(s => s.length === expected.length && /^[0-9a-f]+$/i.test(s) && crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex')));
  if (!ok) throw new Error('signature does not match');
  try { return JSON.parse(rawBody.toString('utf8')); } catch (_) { throw new Error('body is not valid JSON'); }
}
// Used by tests (and handy for a local Stripe stand-in): sign a body the way Stripe does.
function signWebhook(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex')}`;
}

// ── who is Pro ──
// pro = comped by the admin, or a subscription that is active/trialing. A subscription whose payment is
// failing (past_due) keeps access for a short grace window after the period end. Cancelled or unpaid does not.
function isPro(user, billing, now = Date.now()) {
  if (!user) return false;
  if (user.comped) return true;
  if (!billing) return false;
  if (ACTIVE.has(billing.status)) return true;
  if (billing.status === 'past_due') {
    const end = billing.current_period_end ? new Date(billing.current_period_end).getTime() : 0;
    return now < end + GRACE_MS;
  }
  return false;
}
function planInfo(user, billing, now = Date.now()) {
  const pro = isPro(user, billing, now);
  return {
    plan: pro ? 'pro' : 'free',
    comped: !!user?.comped,
    status: billing?.status ?? null,
    renewsAt: billing?.current_period_end ?? null,
    cancelAtPeriodEnd: !!billing?.cancel_at_period_end,
    hasCustomer: !!billing?.customer_id,
  };
}

// ── applying events ──
const periodEnd = sub => {
  const s = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;   // newer API versions keep it on the item
  return s ? new Date(Number(s) * 1000).toISOString() : null;
};

// Applies one verified event. Returns what happened, for logs and tests. Subscription events carry the whole
// subscription, so each one fully replaces the stored state (the newest event wins).
function handleEvent({ store, event, log = () => {} }) {
  const obj = event?.data?.object;
  if (!event?.type || !obj) return { handled: false, reason: 'no object' };
  switch (event.type) {
    case 'checkout.session.completed': {
      const uid = Number(obj.client_reference_id);
      if (Number.isFinite(uid) && obj.customer && store.userById(uid)) { store.setCustomer(uid, obj.customer); return { handled: true, userId: uid, note: 'customer linked' }; }
      return { handled: false, reason: 'unknown user' };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      let uid = store.userIdByCustomer(obj.customer);
      if (uid == null && /^\d+$/.test(String(obj.metadata?.user_id ?? '')) && store.userById(Number(obj.metadata.user_id))) uid = Number(obj.metadata.user_id);
      if (uid == null) { log(`[Billing] ${event.type} for an unknown customer, ignored`); return { handled: false, reason: 'unknown customer' }; }
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
      const applied = store.applySubscription(uid, {
        customerId: obj.customer, subscriptionId: obj.id, status, priceId: obj.items?.data?.[0]?.price?.id ?? null,
        currentPeriodEnd: periodEnd(obj), cancelAtPeriodEnd: !!obj.cancel_at_period_end, eventCreated: event.created,
      });
      return { handled: true, userId: uid, applied, status };
    }
    case 'invoice.payment_failed': {
      const uid = store.userIdByCustomer(obj.customer);
      if (uid != null) store.addEvent('billing', 'warn', `A payment failed for account #${uid}. Stripe will retry; access continues for a short grace period.`);
      return { handled: uid != null, userId: uid };
    }
    default: return { handled: false, reason: 'ignored type' };
  }
}

// ── Stripe API (form-encoded, no SDK) ──
function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object' ? encodeForm(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, x])));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.push([key, v]);
  }
  return out;
}
const formString = obj => encodeForm(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

// `http(method, url, formString|null, headers)` returns the parsed JSON body or throws.
function createStripeClient({ secretKey, base = 'https://api.stripe.com', http }) {
  const call = (method, path, body) => http(method, `${base}${path}`, body ? formString(body) : null, { Authorization: `Bearer ${secretKey}` });
  return {
    createCustomer: ({ email, userId }) => call('POST', '/v1/customers', { email, metadata: { user_id: String(userId) } }),
    createCheckoutSession: ({ customer, priceId, successUrl, cancelUrl, userId, automaticTax = false, allowPromo = true }) => call('POST', '/v1/checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: String(userId),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl, cancel_url: cancelUrl,
      allow_promotion_codes: allowPromo ? 'true' : undefined,
      automatic_tax: automaticTax ? { enabled: 'true' } : undefined,
      customer_update: automaticTax ? { address: 'auto' } : undefined,
      subscription_data: { metadata: { user_id: String(userId) } },
    }),
    createPortalSession: ({ customer, returnUrl }) => call('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl }),
    getPrice: id => call('GET', `/v1/prices/${encodeURIComponent(id)}`),
    cancelSubscription: id => call('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`),
  };
}

// "$12.00 / month" from a Stripe price object.
function priceLabel(price) {
  if (!price || price.unit_amount == null) return null;
  const amt = new Intl.NumberFormat('en-US', { style: 'currency', currency: String(price.currency || 'usd').toUpperCase() }).format(price.unit_amount / 100);
  const iv = price.recurring?.interval;
  return iv ? `${amt} / ${price.recurring.interval_count > 1 ? price.recurring.interval_count + ' ' : ''}${iv}` : amt;
}

module.exports = { verifyWebhook, signWebhook, isPro, planInfo, handleEvent, createStripeClient, encodeForm, formString, priceLabel, GRACE_MS };
