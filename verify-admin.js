const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');

// Get the current hash
const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('User found:', user ? 'yes' : 'no');
console.log('Password hash:', user?.password_hash?.substring(0, 20) + '...');

// Test password
const testPassword = 'admin123';
const matches = bcrypt.compareSync(testPassword, user.password_hash);
console.log('Password matches:', matches);

// If not matching, update it
if (!matches) {
  const newHash = bcrypt.hashSync(testPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(newHash, 'admin@sensehub.local');
  console.log('Password updated!');

  // Verify again
  const updated = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('admin@sensehub.local');
  const nowMatches = bcrypt.compareSync(testPassword, updated.password_hash);
  console.log('Password now matches:', nowMatches);
}

db.close();
