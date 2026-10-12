#!/usr/bin/env node
// Makes a new second-factor secret for the admin page. Run it once on your own computer:
//   node scripts/make-admin-2fa.js [your-email]
// Then add the secret to the server as ADMIN_TOTP_SECRET and add it to an authenticator app (Google Authenticator,
// 1Password, Authy...) by choosing "enter a setup key". Keep a copy of the secret in your password manager: it is the
// way back in if you lose your phone.
const totp = require('../lib/totp');
const secret = totp.newSecret();
console.log('\nADMIN_TOTP_SECRET=' + secret + '\n');
console.log('Setup key for the app (type it in):  ' + secret.match(/.{1,4}/g).join(' '));
console.log('Or open this on your phone:          ' + totp.otpauthUri(secret, process.argv[2] || 'admin') + '\n');
console.log('1. Add the line ADMIN_TOTP_SECRET=... to your server settings (Railway variables, or .env).');
console.log('2. Restart the app. The admin page will ask for the 6-digit code after the token.');
console.log('3. Lost your phone? Use the saved secret in a new app, or remove ADMIN_TOTP_SECRET from the server.\n');
