/**
 * TelegramService - Send notifications via Telegram Bot API.
 *
 * Configuration is stored in the system_settings table:
 *   - telegram_bot_token: Bot token from @BotFather
 *   - telegram_chat_id: Chat/group ID to send messages to
 *   - telegram_enabled: Whether Telegram notifications are active
 */

const https = require('https');
const http = require('http');
const { db } = require('../utils/database');

class TelegramService {
  constructor() {
    this._configCache = null;
    this._configCacheTime = 0;
    this._cacheTtlMs = 30000; // Refresh config every 30s
  }

  /**
   * Get Telegram config from system_settings.
   */
  getConfig() {
    const now = Date.now();
    if (this._configCache && (now - this._configCacheTime) < this._cacheTtlMs) {
      return this._configCache;
    }

    try {
      const rows = db.prepare(
        "SELECT key, value FROM system_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'telegram_enabled')"
      ).all();

      const config = {};
      for (const row of rows) {
        try {
          config[row.key] = JSON.parse(row.value);
        } catch {
          config[row.key] = row.value;
        }
      }

      this._configCache = {
        botToken: config.telegram_bot_token || '',
        chatId: config.telegram_chat_id || '',
        enabled: config.telegram_enabled === true || config.telegram_enabled === 'true'
      };
      this._configCacheTime = now;
      return this._configCache;
    } catch (err) {
      console.error('[Telegram] Error reading config:', err.message);
      return { botToken: '', chatId: '', enabled: false };
    }
  }

  /**
   * Check if Telegram is configured and enabled.
   */
  isConfigured() {
    const config = this.getConfig();
    return config.enabled && config.botToken && config.chatId;
  }

  /**
   * Send a text message via Telegram.
   * @param {string} text - Message text (supports Markdown)
   * @param {object} opts - Options: { parse_mode: 'Markdown'|'HTML', disable_notification: bool }
   * @returns {Promise<object>} Telegram API response
   */
  async sendMessage(text, opts = {}) {
    const config = this.getConfig();
    if (!config.enabled || !config.botToken || !config.chatId) {
      throw new Error('Telegram is not configured or not enabled');
    }

    const payload = {
      chat_id: config.chatId,
      text,
      parse_mode: opts.parse_mode || 'Markdown',
      disable_notification: opts.disable_notification || false
    };

    return this._apiCall(config.botToken, 'sendMessage', payload);
  }

  /**
   * Send an alert notification with standard formatting.
   */
  async sendAlert(title, details, severity = 'warning') {
    const severityEmoji = {
      info: 'ℹ️',
      warning: '⚠️',
      critical: '🚨',
      error: '❌'
    };

    const emoji = severityEmoji[severity] || '⚠️';
    const timestamp = new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'UTC' });

    const message = `${emoji} *${title}*\n\n${details}\n\n🕐 ${timestamp}`;

    try {
      return await this.sendMessage(message);
    } catch (err) {
      console.error(`[Telegram] Failed to send alert "${title}":`, err.message);
      throw err;
    }
  }

  /**
   * Test the connection by sending a test message.
   */
  async testConnection(botToken, chatId) {
    const payload = {
      chat_id: chatId,
      text: '✅ *SenseHub Connected*\n\nTelegram notifications are working correctly.',
      parse_mode: 'Markdown'
    };

    return this._apiCall(botToken, 'sendMessage', payload);
  }

  /**
   * Make a Telegram Bot API call.
   */
  _apiCall(botToken, method, payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const url = `https://api.telegram.org/bot${botToken}/${method}`;

      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.ok) {
              resolve(result);
            } else {
              reject(new Error(`Telegram API error: ${result.description || 'Unknown error'}`));
            }
          } catch (e) {
            reject(new Error(`Invalid Telegram response: ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Telegram request failed: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram request timed out')); });
      req.write(data);
      req.end();
    });
  }

  /**
   * Clear cached config (call after settings change).
   */
  clearCache() {
    this._configCache = null;
    this._configCacheTime = 0;
  }
}

const telegramService = new TelegramService();

module.exports = { telegramService };
