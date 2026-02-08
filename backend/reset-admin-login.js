const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data/sensehub.db'));
const newHash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(newHash, 'admin@sensehub.local');
console.log('Password reset to admin123');
console.log('Verification:', bcrypt.compareSync('admin123', newHash));
