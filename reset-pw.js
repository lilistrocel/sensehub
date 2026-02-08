const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('./data/sensehub.db');
const hash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Admin password reset to admin123');
db.close();
