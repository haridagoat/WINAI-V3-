// Product analytics through PostHog's public capture API (https://posthog.com/docs/api/capture).
// Events that measure the beta (sign-ups, opens, paywall hits, subscribe intent) are sent from the server,
// so an ad blocker in the browser can't drop them. Without POSTHOG_KEY every call is a no-op.
// Sending never throws and never delays a response: callers fire and forget.

const DEFAULT_HOST = 'https://us.i.posthog.com';

// Only https hosts, or a local stand-in for the tests. The key is PostHog's public project key.
function cleanHost(v) {
  const h = String(v || '').trim().replace(/\/+$/, '');
  if (!h) return DEFAULT_HOST;
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(h) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(h) ? h : null;
}
const cleanKey = v => (/^[A-Za-z0-9_-]{8,100}$/.test(String(v || '').trim()) ? String(v).trim() : '');

// One stable id per account, shared with the browser snippet so both sides land on the same person.
const distinctIdFor = userId => `u_${userId}`;

function createAnalytics({ key, host, post, log = () => {}, now = () => new Date() }) {
  const apiKey = cleanKey(key), base = cleanHost(host);
  const enabled = !!(apiKey && base);
  const opened = new Map();   // userId -> day of the last 'app_opened', so it fires once a day per person

  function capture(userId, event, properties = {}) {
    if (!enabled || userId == null) return Promise.resolve(false);
    const body = {
      api_key: apiKey, event, distinct_id: distinctIdFor(userId),
      properties: { ...properties, $lib: 'winai-server' }, timestamp: now().toISOString(),
    };
    return Promise.resolve()
      .then(() => post(`${base}/capture/`, body))
      .then(() => true, err => { log(`[PostHog] ${event} not sent: ${err.message}`); return false; });
  }

  // 'How often they come back': one event per person per day, whatever the session length.
  function appOpened(userId, day) {
    if (!enabled || userId == null || opened.get(userId) === day) return Promise.resolve(false);
    opened.set(userId, day);
    if (opened.size > 5000) opened.delete(opened.keys().next().value);
    return capture(userId, 'app_opened', { day });
  }

  // What the browser needs to load the snippet. The project key is public by design.
  const clientConfig = () => (enabled ? { key: apiKey, host: base } : null);

  return { enabled, capture, appOpened, clientConfig };
}

module.exports = { createAnalytics, distinctIdFor, cleanHost, cleanKey, DEFAULT_HOST };
