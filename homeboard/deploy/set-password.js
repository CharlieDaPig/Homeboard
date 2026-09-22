#!/usr/bin/env node
'use strict';
// The dashboard (http://<pi-address>:3000/admin) has no password unless you add one. This is optional;
// you can also do it from the dashboard's System tab.
//   node deploy/set-password.js            set or change the password
//   node deploy/set-password.js --remove   go back to no password
// Works while the server is running.
const path = require('path');
const { AdminAuth, MIN_LENGTH } = require(path.join(__dirname, '..', 'lib', 'auth'));

// Ask for text without showing it on screen. Falls back to plain lines when input is piped in.
function askHidden(prompt, lines) {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt + '\n');
    return Promise.resolve(lines.length ? lines.shift() : '');
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let text = '';
    const finish = (value) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      if (chunk[0] === '\u001b') return; // arrow keys and other escape sequences are not part of the password
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(text);
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ') text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const auth = new AdminAuth();
  if (process.argv.includes('--remove')) {
    auth.clearPassword();
    console.log('Password removed. Anyone on your home network can open the dashboard.');
    return;
  }
  let lines = [];
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  console.log(auth.isSet() ? 'Change the dashboard password.' : 'Choose a password for the Homeboard dashboard.');
  console.log(`At least ${MIN_LENGTH} characters. Leave it empty to cancel. (To remove the password: node deploy/set-password.js --remove)\n`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await askHidden('New password: ', lines);
    if (!first) {
      console.log('Nothing changed.');
      return;
    }
    if (first.length < MIN_LENGTH) {
      console.log(`That is too short (needs ${MIN_LENGTH} or more characters). Try again.\n`);
      continue;
    }
    const second = await askHidden('Type it again: ', lines);
    if (first !== second) {
      console.log('The two did not match. Try again.\n');
      continue;
    }
    await auth.setPassword(first);
    console.log('\nPassword saved. Devices on your network enter it once at  /admin.');
    return;
  }
  console.log('Too many tries. Run this again when you are ready.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`Could not save the password: ${err.message}`);
  process.exit(1);
});
