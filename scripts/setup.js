'use strict';

/** Makes the first office account. Run once with `npm run setup`. */

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { open } = require('../src/db');
const auth = require('../src/auth');

async function main() {
  const db = open();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const existing = db.prepare("SELECT name, username FROM employees WHERE role = 'office'").all();
    if (existing.length > 0) {
      console.log('Office accounts already set up:');
      for (const a of existing) console.log(`  - ${a.name} (${a.username})`);
      const again = (await rl.question('Add another one? [y/N] ')).trim().toLowerCase();
      if (again !== 'y') return;
    }

    const name = (await rl.question('Your name: ')).trim();
    const username = (await rl.question('Name to sign in with: ')).trim().toLowerCase();
    const pin = (await rl.question('Sign-in number (4-10 digits): ')).trim();

    if (!name) throw new Error('A name is needed');
    if (!/^[a-z0-9._-]+$/.test(username)) {
      throw new Error('Sign-in name: letters, numbers, . _ - only');
    }
    if (!/^\d{4,10}$/.test(pin)) throw new Error('The number has to be 4 to 10 digits');

    if (db.prepare('SELECT id FROM employees WHERE username = ? COLLATE NOCASE').get(username)) {
      throw new Error(`Somebody already signs in as "${username}"`);
    }

    db.prepare(`
      INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'office')
    `).run(name, username, auth.hashPin(pin));

    console.log(`\nOffice account made. Sign in as "${username}" and add the crew.`);
    console.log('Start it with: npm start');
  } finally {
    rl.close();
    db.close();
  }
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exitCode = 1;
});
