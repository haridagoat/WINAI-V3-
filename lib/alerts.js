// Admin-only alerts. Every alert is written to the events log (visible on the admin
// page). If ADMIN_ALERT_WEBHOOK is set (a Discord or Slack incoming-webhook URL) it is
// also pushed there, at most once per key per cooldown so a problem that persists
// doesn't ping all day. Nothing is ever sent to site visitors.
function createAlerts({ store, webhookUrl, post, cooldownMs = 12 * 3600 * 1000, now = () => Date.now(), log = () => {} }) {
  const lastSentKey = k => `alert_sent:${k}`;
  return {
    configured: !!webhookUrl,
    async notify({ key, level = 'warn', kind = 'alert', message }) {
      store.addEvent(kind, level, message);
      if (!webhookUrl || !post) return { sent: false, reason: 'no webhook configured' };
      const last = Number(store.getMeta(lastSentKey(key)) || 0);
      if (now() - last < cooldownMs) return { sent: false, reason: 'cooldown' };
      const text = `${level === 'critical' ? '🔴' : level === 'warn' ? '🟠' : 'ℹ️'} WIN AI: ${message}`;
      try {
        await post(webhookUrl, { content: text, text });   // content = Discord, text = Slack
        store.setMeta(lastSentKey(key), String(now()));
        return { sent: true };
      } catch (err) { log(`[Alerts] webhook failed: ${err.message}`); return { sent: false, reason: err.message }; }
    },
    // clears the cooldown when a problem goes away, so it can alert again if it returns
    resolve(key) { store.setMeta(lastSentKey(key), '0'); },
  };
}
module.exports = { createAlerts };
