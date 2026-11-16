// Error monitoring without a third party: every server error, crash and browser error is written to the events log
// with private details removed, grouped so one bug is one line, and announced through the alert webhook once per
// problem (never a flood). Nothing here ever stores a request body, a cookie, or a person's address.
const KIND = 'error';
const SOURCES = { server: 'Server', client: 'Browser', process: 'Crash' };

// Takes personal and secret-looking pieces out of text that is about to be stored or sent.
function scrub(text, max = 200) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [token]')
    .replace(/\bsk-[\w-]{8,}/g, '[key]')
    .replace(/\b(?:whsec|sk|rk|pk)_(?:test_|live_)?[A-Za-z0-9]{8,}/g, '[key]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[token]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
// "/api/prop-context?player=Jokic" -> "/api/prop-context", "/api/clv/123/result" -> "/api/clv/:id/result"
function routeOf(method, url) {
  const p = String(url || '').split('?')[0].split('#')[0].split('/').map(seg => (/^\d+$/.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg) ? ':id' : seg)).join('/');
  return `${method ? String(method).toUpperCase() + ' ' : ''}${scrub(p, 80)}`.trim();
}

// What a failed call to the AI service means for the visitor, and which status the page should see. The provider's own message stays in the server log:
// it can mention billing or keys, which visitors should not see, and "busy, try again" and "not working" need different handling by the page.
//   503: busy, slow or unreachable (trying again is the right answer)    502: refused or misconfigured (trying again will not help)
const AI_NETWORK_CODES = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_STREAM_PREMATURE_CLOSE'];
function aiFailure(err, providerMessage) {
  const up = err && err.response && err.response.status, code = err && err.code;
  const text = String(providerMessage || (err && err.message) || '');
  if (up === 429 || /rate.?limit/i.test(text)) return { status: 503, message: 'The AI service is busy. Try again in a minute.' };
  if ([500, 502, 503, 504, 529].includes(up) || /overloaded/i.test(text) || AI_NETWORK_CODES.includes(code) || /timeout|timed out|went quiet|no text/i.test(text)) return { status: 503, message: 'The AI service is not answering. Try again in a moment.' };
  return { status: 502, message: 'The AI service is unavailable right now. The numbers are still good; the write-up will be back soon.' };
}

function createErrorLog({ store, alerts, now = () => Date.now(), maxAlertsPerHour = 5, cooldownMs }) {
  let alertTimes = [];
  const seenSig = new Map();     // signature -> last alert time, so a repeating bug alerts once per cooldown
  const COOL = cooldownMs ?? 12 * 3600 * 1000;
  return {
    // Writes the error down; returns whether an alert was raised.
    record({ source = 'server', route = '', message = '' }) {
      const src = SOURCES[source] ? source : 'server';
      const msg = scrub(message, 160), where = scrub(route, 90);
      store.addEvent(KIND, 'error', `${src}|${where}|${msg}`);
      const sig = `${src}|${where}|${msg.slice(0, 60)}`, t = now();
      if (t - (seenSig.get(sig) || 0) < COOL) return false;
      alertTimes = alertTimes.filter(x => t - x < 3600e3);
      if (alertTimes.length >= maxAlertsPerHour) return false;          // a burst of different errors is one alert storm, not twenty pings
      seenSig.set(sig, t); alertTimes.push(t);
      if (seenSig.size > 500) seenSig.delete(seenSig.keys().next().value);
      alerts?.notify?.({ key: 'error:' + sig, level: 'warn', kind: KIND, record: false, message: `${SOURCES[src]} error${where ? ` on ${where}` : ''}: ${msg}` })?.catch?.(() => {});
      return true;
    },
    // Recent errors grouped by what they are: { source, route, message, count, first, last }, newest first.
    groups({ sinceMs = 24 * 3600e3, limit = 200 } = {}) {
      const since = now() - sinceMs, by = new Map();
      for (const e of store.recentEvents(limit * 5)) {
        if (e.kind !== KIND || Date.parse(e.ts) < since) continue;
        const [source, route, ...rest] = String(e.message).split('|'), message = rest.join('|');
        const k = `${source}|${route}|${message}`, g = by.get(k) || { source, route, message, count: 0, first: e.ts, last: e.ts };
        g.count++; if (e.ts < g.first) g.first = e.ts; if (e.ts > g.last) g.last = e.ts; by.set(k, g);
      }
      return [...by.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, limit);
    },
  };
}

module.exports = { createErrorLog, scrub, routeOf, aiFailure, KIND };
