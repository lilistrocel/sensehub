const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');
const hash = bcrypt.hashSync('admin123', 10);
const result = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Password reset result:', result);
const user = db.prepare('SELECT id, email, name, role FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('User:', user);
db.close();
