const bcrypt = require('bcryptjs');
const hash = '$2a$10$dBpumq7ThNvVVj1rIxcK.uW0YlRVMcjLX5Sb6aI4wtIEGWuunQtpK';
console.log('Password viewer123 matches:', bcrypt.compareSync('viewer123', hash));
