const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db = new Database('backend/data/sensehub.db');

// Hash the password 'viewer123'
const hash = bcrypt.hashSync('viewer123', 10);

// Update the viewer user
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'operator@sensehub.local');

console.log('Password for operator@sensehub.local set to: viewer123');
db.close();
