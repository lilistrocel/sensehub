const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');

const hash = bcrypt.hashSync('admin123', 10);
console.log('New hash:', hash);

const db = new Database('backend/data/sensehub.db');
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Password updated for admin@sensehub.local');
db.close();
