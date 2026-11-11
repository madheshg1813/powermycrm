// Loads apps/api/.env.test into process.env for the test run (and never the development database).
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env.test');
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('Refusing to run tests: DATABASE_URL in .env.test must point at a *_test database');
}
