const http = require('http');

class SenseHubAPIClient {
  constructor(baseUrl, email, password) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.email = email;
    this.password = password;
    this.token = null;
  }

  async login() {
    const res = await this._rawRequest('POST', '/api/auth/login', {
      email: this.email,
      password: this.password,
    });
    if (!res.token) {
      throw new Error(`Login failed: ${res.message || 'no token returned'}`);
    }
    this.token = res.token;
    console.log('[api-client] Authenticated with SenseHub backend');
    return res;
  }

  async get(path) {
    return this._authenticatedRequest('GET', path);
  }

  async post(path, body) {
    return this._authenticatedRequest('POST', path, body);
  }

  async _authenticatedRequest(method, path, body) {
    try {
      return await this._rawRequest(method, path, body, true);
    } catch (err) {
      if (err.statusCode === 401) {
        console.log('[api-client] Token expired, re-authenticating...');
        await this.login();
        return this._rawRequest(method, path, body, true);
      }
      throw err;
    }
  }

  _rawRequest(method, path, body, useAuth = false) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (useAuth && this.token) {
        options.headers['Authorization'] = `Bearer ${this.token}`;
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { raw: data };
          }
          if (res.statusCode >= 400) {
            const err = new Error(parsed.message || `HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.response = parsed;
            reject(err);
          } else {
            resolve(parsed);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}

module.exports = SenseHubAPIClient;
