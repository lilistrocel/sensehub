const bcrypt = require('/home/noobcity/Code/SenseHub/backend/node_modules/bcryptjs');
const Database = require('/home/noobcity/Code/SenseHub/backend/node_modules/better-sqlite3');
const db = new Database('/home/noobcity/Code/SenseHub/backend/data/sensehub.db');

const hash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@sensehub.local');
console.log('Password reset to admin123');
db.close();
