const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db = new Database('backend/data/sensehub.db');

// Reset password to admin123
const newHash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(newHash, 'admin@sensehub.local');
console.log('Password reset to admin123');

// Verify
const verify = bcrypt.compareSync('admin123', newHash);
console.log('Password verification:', verify);
