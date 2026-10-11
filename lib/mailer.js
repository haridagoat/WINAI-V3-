// Sends the sign-in email through Resend (https://resend.com). Set RESEND_API_KEY and MAIL_FROM
// (an address on a domain you verified there, e.g. "WIN AI <login@yourdomain.com>").
//
// With no key, nothing is sent. For local testing only, AUTH_DEV_LINKS=1 prints the link in the server
// log instead (and the sign-in route returns it). Never set that on a public server: anyone could then
// sign in as any email address.
function createMailer({ apiKey, from, post, log = () => {}, devLinks = false }) {
  const configured = !!(apiKey && from && post);
  return {
    configured,
    devLinks: !configured && devLinks,
    async send({ to, link }) {
      if (!configured) {
        if (!devLinks) throw new Error('email is not configured');
        log(`[Auth] DEV sign-in link for ${to}: ${link}`);
        return { dev: true };
      }
      const text = `Use this link to sign in to WIN AI:\n\n${link}\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email.`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <h2 style="margin:0 0 12px">Sign in to WIN AI</h2>
        <p>Tap the button to sign in. The link works once and expires in 15 minutes.</p>
        <p style="margin:24px 0"><a href="${link}" style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Sign in</a></p>
        <p style="color:#666;font-size:13px">If you did not ask for this, you can ignore this email. No account is created until the link is used.</p></div>`;
      await post('https://api.resend.com/emails', { from, to: [to], subject: 'Your WIN AI sign-in link', html, text }, { headers: { Authorization: `Bearer ${apiKey}` } });
      return { dev: false };
    },
  };
}
module.exports = { createMailer };
