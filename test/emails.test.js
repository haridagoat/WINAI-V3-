const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/emails');

const LINK = 'https://winai.example/auth/confirm?t=' + 'A'.repeat(43);
for (const [name, fn, subject, mins] of [['confirmation', E.confirmEmail, /^Confirm your email/, '24 hours'], ['reset', E.resetEmail, /^Reset your WIN AI password/, '30 minutes']]) {
  test(`${name} email: link, expiry, ignore line and the plain-text twin`, () => {
    const m = fn({ link: LINK, email: 'maya@example.com' });
    assert.match(m.subject, subject);
    for (const part of [m.html, m.text]) { assert.ok(part.includes(LINK)); assert.ok(part.includes('maya@example.com')); assert.ok(part.includes(mins)); assert.ok(part.includes('1-800-GAMBLER')); }
    assert.ok(m.html.includes(m.preheader));
    assert.match(m.text, /ignore/i);
    assert.ok(/<a href="https:\/\/winai\.example\/auth\/confirm\?t=A{43}"/.test(m.html));      // the button is a plain link
    assert.ok(m.html.includes('prefers-color-scheme:dark') && m.html.includes('max-width:480px'));
  });
  test(`${name} email: nothing from the address can break out of the page`, () => {
    const m = fn({ link: LINK, email: '"><script>alert(1)</script>@x.com' });
    assert.ok(!m.html.includes('<script>'));
    assert.ok(!m.html.includes('"><script'));                       // the raw payload never appears
    assert.ok(m.html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@x.com'));   // it is shown as harmless text
  });
}
test('the reset email never says the account exists or shows a password', () => {
  const m = E.resetEmail({ link: LINK, email: 'maya@example.com' });
  assert.ok(!/password is /i.test(m.text));
  assert.match(m.text, /Your password has not changed/);
});
