const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');

// Update operator password too
const hash = bcrypt.hashSync('operator123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'operator@sensehub.local');
console.log('Operator password reset to operator123');

// Verify
const operator = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get('operator@sensehub.local');
console.log('Operator:', operator);

db.close();
