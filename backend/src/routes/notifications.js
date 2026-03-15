const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { telegramService } = require('../services/TelegramService');

const router = express.Router();

// GET /api/notifications/telegram - Get Telegram configuration
router.get('/telegram', requireRole('admin'), (req, res) => {
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

    res.json({
      bot_token: config.telegram_bot_token ? '***configured***' : '',
      chat_id: config.telegram_chat_id || '',
      enabled: config.telegram_enabled === true || config.telegram_enabled === 'true',
      has_token: !!config.telegram_bot_token
    });
  } catch (err) {
    console.error('Error fetching Telegram config:', err);
    res.status(500).json({ error: 'Failed to fetch Telegram configuration' });
  }
});

// PUT /api/notifications/telegram - Update Telegram configuration
router.put('/telegram', requireRole('admin'), (req, res) => {
  try {
    const { bot_token, chat_id, enabled } = req.body;

    const upsert = db.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `);

    if (bot_token !== undefined && bot_token !== '***configured***') {
      upsert.run('telegram_bot_token', JSON.stringify(bot_token), JSON.stringify(bot_token));
    }
    if (chat_id !== undefined) {
      upsert.run('telegram_chat_id', JSON.stringify(chat_id), JSON.stringify(chat_id));
    }
    if (enabled !== undefined) {
      upsert.run('telegram_enabled', JSON.stringify(enabled), JSON.stringify(enabled));
    }

    // Clear cached config
    telegramService.clearCache();

    res.json({ message: 'Telegram configuration updated' });
  } catch (err) {
    console.error('Error updating Telegram config:', err);
    res.status(500).json({ error: 'Failed to update Telegram configuration' });
  }
});

// POST /api/notifications/telegram/test - Send a test message
router.post('/telegram/test', requireRole('admin'), async (req, res) => {
  try {
    const { bot_token, chat_id } = req.body;

    // Use provided values or fall back to stored config
    let token = bot_token;
    let chatId = chat_id;

    if (!token || token === '***configured***') {
      const stored = db.prepare("SELECT value FROM system_settings WHERE key = 'telegram_bot_token'").get();
      token = stored ? JSON.parse(stored.value) : '';
    }
    if (!chatId) {
      const stored = db.prepare("SELECT value FROM system_settings WHERE key = 'telegram_chat_id'").get();
      chatId = stored ? JSON.parse(stored.value) : '';
    }

    if (!token || !chatId) {
      return res.status(400).json({ error: 'Bot token and chat ID are required' });
    }

    const result = await telegramService.testConnection(token, chatId);
    res.json({ success: true, message: 'Test message sent successfully', result });
  } catch (err) {
    console.error('Telegram test failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/notifications/watchdog - Get watchdog status
router.get('/watchdog', requireRole('admin'), (req, res) => {
  try {
    // Get count of monitored automations (all enabled non-manual)
    const monitored = db.prepare(
      "SELECT COUNT(*) as count FROM automations WHERE enabled = 1 AND trigger_config NOT LIKE '%\"type\":\"manual\"%'"
    ).get();

    // Get recent watchdog alerts
    const recentAlerts = db.prepare(
      "SELECT * FROM alerts WHERE message LIKE 'Watchdog:%' ORDER BY created_at DESC LIMIT 20"
    ).all();

    // Get equipment health summary
    const offlineCount = db.prepare("SELECT COUNT(*) as count FROM equipment WHERE status = 'offline'").get();
    const errorCount = db.prepare("SELECT COUNT(*) as count FROM equipment WHERE status = 'error'").get();

    res.json({
      monitored_automations: monitored.count,
      offline_equipment: offlineCount.count,
      error_equipment: errorCount.count,
      recent_alerts: recentAlerts,
      telegram_configured: telegramService.isConfigured()
    });
  } catch (err) {
    console.error('Error fetching watchdog status:', err);
    res.status(500).json({ error: 'Failed to fetch watchdog status' });
  }
});

module.exports = router;
