const path = require('path');
const Database = require(path.join(__dirname, 'backend/node_modules/better-sqlite3'));
const bcrypt = require(path.join(__dirname, 'backend/node_modules/bcryptjs'));

const dbPath = path.join(__dirname, 'backend/data/sensehub.db');
const db = new Database(dbPath);

const hash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Password reset to admin123 for admin@sensehub.local');
db.close();
