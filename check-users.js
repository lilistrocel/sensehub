const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');

// List all users
const users = db.prepare('SELECT id, email, name, role FROM users').all();
console.log('Users:', JSON.stringify(users, null, 2));

// Reset admin password
const hash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Admin password reset to admin123');

db.close();
