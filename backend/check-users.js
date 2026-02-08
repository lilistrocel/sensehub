const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('/home/noobcity/Code/SenseHub/backend/data/sensehub.db');

// List users
const users = db.prepare('SELECT id, email, name, role FROM users').all();
console.log('Users:', users);

// Reset admin password to 'admin123'
const hash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Admin password reset to: admin123');

db.close();
