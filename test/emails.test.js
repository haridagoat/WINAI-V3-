const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/emails');

const LINK = 'https://winai.example/auth/confirm?t=' + 'A'.repeat(43);
for (const [name, fn, subject, mins] of [['confirmation', E.confirmEmail, /^Welcome to WIN AI/, '24 hours'], ['reset', E.resetEmail, /^Reset your WIN AI password/, '30 minutes']]) {
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

test('the confirmation email greets the person by first name and opens with "Tap to confirm"', () => {
  const m = E.confirmEmail({ link: LINK, email: 'maya@example.com', name: 'Maya' });
  assert.ok(m.html.includes('Welcome, Maya'));
  assert.ok(m.text.startsWith('Welcome, Maya.'));
  assert.ok(m.html.includes('Tap to confirm that <b>maya@example.com</b> is your email address.'));
  assert.ok(m.text.includes('Tap to confirm that maya@example.com is your email address:'));
  assert.ok(!m.html.includes('Confirm your email</h1>'));
});
test('without a name the greeting still reads naturally', () => {
  for (const name of [undefined, null, '', '   ', '\u0000<>']) {
    const m = E.confirmEmail({ link: LINK, email: 'maya@example.com', name });
    assert.ok(m.html.includes('Welcome to WIN AI</h1>'), JSON.stringify(name));
    assert.ok(m.text.startsWith('Welcome to WIN AI.'));
  }
});
test('a name cannot inject markup and is kept short', () => {
  const m = E.confirmEmail({ link: LINK, email: 'a@b.com', name: '<img src=x onerror=alert(1)>Maya' });
  assert.ok(!m.html.includes('<img'));
  assert.equal(E.firstName('x'.repeat(100)).length, 40);
  assert.equal(E.firstName('  Mary   Ann \n Lee '), 'Mary Ann Lee');
});

test('a name that is not text is ignored, not turned into "[object Object]"', () => {
  for (const bad of [{ a: 1 }, ['Maya'], 42, true]) assert.equal(E.firstName(bad), '');
  assert.ok(E.confirmEmail({ link: LINK, email: 'a@b.com', name: { a: 1 } }).html.includes('Welcome to WIN AI</h1>'));
});
