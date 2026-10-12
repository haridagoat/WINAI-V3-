// The emails WIN AI sends. Each returns { subject, preheader, text, html }.
// Mail apps ignore most modern CSS, so these are built the old, safe way: tables, inline styles, a button that is
// a plain link, and a plain-text twin. Light by default; Apple Mail and the Outlook app switch to a dark version.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FOOTER_TEXT = 'WIN AI is analytics, not betting advice, and is for people 21 and older. If gambling is a problem for you or someone you know, call 1-800-GAMBLER.';

function layout({ preheader, heading, intro, button, buttonLabel, note, ignore, email }) {
  const b = esc(button);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(heading)}</title>
<style>
  body{margin:0;padding:0;background:#f4f4f5}
  .wrap{padding:28px 12px}
  .card{background:#ffffff;border-radius:14px;overflow:hidden}
  .pad{padding:32px}
  .h{font-family:'Barlow Condensed','Arial Narrow',Impact,Arial,sans-serif}
  a{color:#111}
  @media (max-width:480px){ .wrap{padding:0 !important} .card{border-radius:0 !important} .pad{padding:24px 20px !important} .h1{font-size:26px !important} .btn a{display:block !important} }
  @media (prefers-color-scheme:dark){
    body,.wrap{background:#0a0a0b !important}
    .card{background:#111113 !important}
    .t1{color:#ececee !important} .t2{color:#c4c4cb !important} .t3{color:#9a9aa3 !important}
    .btn a{background:#ececee !important;color:#0a0a0b !important}
    .box{background:#18181b !important;border-color:#2b2b30 !important}
    .rule{border-color:#2b2b30 !important}
    a.plain{color:#c4c4cb !important}
  }
</style></head>
<body>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${esc(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5"><tr><td align="center" class="wrap">
 <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px" class="card" bgcolor="#ffffff">
  <tr><td style="background:#0a0a0b;padding:22px 32px" bgcolor="#0a0a0b">
    <div class="h" style="font-family:'Barlow Condensed','Arial Narrow',Impact,Arial,sans-serif;font-weight:800;font-size:28px;letter-spacing:2px;color:#ffffff;line-height:1">WIN AI</div>
    <div style="font-family:Arial,sans-serif;font-size:10px;letter-spacing:3px;color:#9a9aa3;margin-top:4px">NBA + WNBA PROPS ENGINE</div>
  </td></tr>
  <tr><td class="pad" style="padding:32px;font-family:Arial,Helvetica,sans-serif">
    <h1 class="h h1 t1" style="margin:0 0 14px;font-family:'Barlow Condensed','Arial Narrow',Impact,Arial,sans-serif;font-weight:800;font-size:30px;line-height:1.1;letter-spacing:1px;text-transform:uppercase;color:#0a0a0b">${esc(heading)}</h1>
    <p class="t2" style="margin:0 0 24px;font-size:16px;line-height:1.55;color:#3f3f46">${intro}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn"><tr><td bgcolor="#0a0a0b" style="border-radius:9px">
      <a href="${b}" style="display:inline-block;padding:15px 30px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;background:#0a0a0b;border-radius:9px;text-align:center">${esc(buttonLabel)}</a>
    </td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr><td class="box" style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#3f3f46">
      <span class="t2">${note}</span>
    </td></tr></table>
    <p class="t3" style="margin:22px 0 6px;font-size:13px;line-height:1.5;color:#71717a">Button not working? Paste this link into your browser:</p>
    <p style="margin:0;font-size:12.5px;line-height:1.5;word-break:break-all"><a class="plain" href="${b}" style="color:#52525b">${b}</a></p>
    <p class="t2" style="margin:24px 0 0;font-size:14px;line-height:1.55;color:#3f3f46">${ignore}</p>
  </td></tr>
  <tr><td class="rule" style="border-top:1px solid #e4e4e7;padding:20px 32px 26px;font-family:Arial,Helvetica,sans-serif">
    <p class="t3" style="margin:0 0 8px;font-size:12px;line-height:1.55;color:#71717a">Sent to ${esc(email)} by WIN AI.</p>
    <p class="t3" style="margin:0;font-size:12px;line-height:1.55;color:#71717a">${esc(FOOTER_TEXT)}</p>
  </td></tr>
 </table>
</td></tr></table>
</body></html>`;
}

// First name for the greeting: plain text only, trimmed, one line, at most 40 characters. Empty means no greeting by name.
function firstName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n;
}

// Sent right after someone signs up. Not before.
function confirmEmail({ link, email, name }) {
  const first = firstName(name);
  const heading = first ? `Welcome, ${first}` : 'Welcome to WIN AI';
  const preheader = 'Tap to confirm your email. The link works once and expires in 24 hours.';
  return {
    subject: 'Welcome to WIN AI. Tap to confirm your email',
    preheader,
    text: `${heading}.\n\nTap to confirm that ${email} is your email address:\n${link}\n\nThis unlocks subscribing and password resets. The link works once and expires in 24 hours. If it has expired, sign in and we will send a new one.\n\nDid not create an account? You can ignore this email. Nothing happens unless someone taps the link.\n\n${FOOTER_TEXT}`,
    html: layout({
      preheader, heading, email, button: link, buttonLabel: 'Confirm email',
      intro: `Tap to confirm that <b>${esc(email)}</b> is your email address. This unlocks subscribing and password resets.`,
      note: 'The link works once and expires in <b>24 hours</b>. If it has expired, sign in and we will send you a new one.',
      ignore: 'Did not create an account? You can ignore this email. Nothing happens unless someone taps the link.',
    }),
  };
}

// Sent only when someone asks to reset a password.
function resetEmail({ link, email }) {
  const preheader = 'Choose a new password. The link works once and expires in 30 minutes.';
  return {
    subject: 'Reset your WIN AI password',
    preheader,
    text: `We got a request to reset the password for ${email}.\n\nChoose a new password:\n${link}\n\nThe link works once and expires in 30 minutes. When you change your password you will be signed out on your other devices.\n\nDid not ask for this? Ignore this email. Your password has not changed. If you keep getting these, someone may be typing your address by mistake. Your account is safe.\n\n${FOOTER_TEXT}`,
    html: layout({
      preheader, heading: 'Reset your password', email, button: link, buttonLabel: 'Choose a new password',
      intro: `We got a request to reset the password for <b>${esc(email)}</b>. Tap the button to choose a new one.`,
      note: 'The link works once and expires in <b>30 minutes</b>. When you change your password you will be signed out on your other devices.',
      ignore: 'Did not ask for this? Ignore this email. <b>Your password has not changed.</b> If you keep getting these, someone may be typing your address by mistake. Your account is safe.',
    }),
  };
}

module.exports = { confirmEmail, resetEmail, firstName, esc, FOOTER_TEXT };
