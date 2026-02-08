const bcrypt = require('./backend/node_modules/bcryptjs');
const db = require('./backend/node_modules/better-sqlite3')('./backend/data/sensehub.db');
const hash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Admin password reset to admin123');
