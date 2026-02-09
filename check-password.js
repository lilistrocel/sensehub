const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');

const user = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('admin@sensehub.local');
process.stdout.write('Hash from DB: ' + user.password_hash + '\n');

const result = bcrypt.compareSync('admin123', user.password_hash);
process.stdout.write('Password check result: ' + result + '\n');

// Reset password
const newHash = bcrypt.hashSync('admin123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(newHash, 'admin@sensehub.local');
process.stdout.write('Password reset to admin123\n');

db.close();
