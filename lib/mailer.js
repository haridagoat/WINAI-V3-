// Sends the account emails through Resend (https://resend.com): the confirmation email right after sign-up and the
// password reset email when someone asks for it. Set RESEND_API_KEY and MAIL_FROM (an address on a domain you verified
// there, e.g. "WIN AI <login@yourdomain.com>").
//
// With no key, nothing is sent. For local testing only, AUTH_DEV_LINKS=1 prints each link in the server log instead
// (and the sign-up and reset routes return it to this machine). Never set that on a public server: anyone could then
// confirm or reset any address.
const { confirmEmail, resetEmail } = require('./emails');

function createMailer({ apiKey, from, post, log = () => {}, devLinks = false }) {
  const configured = !!(apiKey && from && post);
  return {
    configured,
    devLinks: !configured && devLinks,
    // purpose: 'confirm' | 'reset'
    async send({ to, purpose, link, name }) {
      const m = (purpose === 'reset' ? resetEmail : confirmEmail)({ link, email: to, name });
      if (!configured) {
        if (!devLinks) throw new Error('email is not configured');
        log(`[Auth] DEV ${purpose} link for ${to}: ${link}`);
        return { dev: true };
      }
      await post('https://api.resend.com/emails', { from, to: [to], subject: m.subject, html: m.html, text: m.text }, { headers: { Authorization: `Bearer ${apiKey}` } });
      return { dev: false };
    },
    // A plain message to the admin (the daily grading report). Never sent with dev links: there is no link to print, so it simply refuses.
    async sendPlain({ to, subject, text }) {
      if (!configured) throw new Error('email is not configured');
      if (!to || !subject || !text) throw new Error('to, subject and text are required');
      await post('https://api.resend.com/emails', { from, to: [to], subject: String(subject).slice(0, 200), text: String(text) }, { headers: { Authorization: `Bearer ${apiKey}` } });
      return { sent: true };
    },
  };
}
module.exports = { createMailer };
