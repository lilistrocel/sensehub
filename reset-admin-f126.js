const Database = require('./backend/node_modules/better-sqlite3');
const bcrypt = require('./backend/node_modules/bcryptjs');
const db = new Database('./backend/data/sensehub.db');

const hash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Admin password reset to admin123');
db.close();
