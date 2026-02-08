const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const hash = bcrypt.hashSync('admin123', 10);
console.log('New hash:', hash);

const dbPath = path.join(__dirname, 'data', 'sensehub.db');
console.log('DB path:', dbPath);
const db = new Database(dbPath);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Password updated for admin@sensehub.local');
db.close();
