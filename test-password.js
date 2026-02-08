const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');
const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@sensehub.local');
const result = bcrypt.compareSync('admin123', user.password_hash);
process.stdout.write('Password match: ' + result + '\n');
db.close();
