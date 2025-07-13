// apiKeyRoutes.js - API Key Management Routes for Dashboard
import express from 'express';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth.js';
import { pool } from '../db/init.js';
import { v4 as uuidv4 } from 'uuid';
import { getUserUsageStats, getTomorrowMidnight } from '../services/apiMemoryStore.js';

const router = express.Router();

/**
 * GET /auth/api-key
 * Get user's current API key (for dashboard display)
 */
router.get('/api-key', authenticateToken, async (req, res) => {
  try {
    const [settings] = await pool.query(
      'SELECT api_key, created_at, updated_at FROM premium_settings WHERE user_id = ?',
      [req.user.id]
    );
    
    if (settings.length === 0 || !settings[0].api_key) {
      return res.json({ 
        api_key: null,
        has_key: false,
        message: 'No API key generated yet'
      });
    }

    res.json({ 
      api_key: settings[0].api_key,
      has_key: true,
      created_at: settings[0].created_at,
      updated_at: settings[0].updated_at,
      key_prefix: settings[0].api_key.substring(0, 8) + '...'
    });
  } catch (error) {
    console.error('Failed to fetch API key:', error);
    res.status(500).json({ 
      error: 'Failed to fetch API key',
      message: 'An internal error occurred while fetching your API key'
    });
  }
});

/**
 * POST /auth/generate-api-key
 * Generate new API key for user
 */
router.post('/generate-api-key', authenticateToken, async (req, res) => {
  try {
    // Generate secure API key
    const apiKey = 'api_' + crypto.randomBytes(32).toString('hex');
    
    // Check if user already has premium_settings record
    const [existingSettings] = await pool.query(
      'SELECT id FROM premium_settings WHERE user_id = ?',
      [req.user.id]
    );

    if (existingSettings.length > 0) {
      // Update existing record
      await pool.query(
        'UPDATE premium_settings SET api_key = ?, updated_at = NOW() WHERE user_id = ?',
        [apiKey, req.user.id]
      );
    } else {
      // Create new record
      const settingsId = uuidv4();
      await pool.query(`
        INSERT INTO premium_settings (id, user_id, api_key, created_at, updated_at) 
        VALUES (?, ?, ?, NOW(), NOW())
      `, [settingsId, req.user.id, apiKey]);
    }

    // Log the API key generation
    console.log(`Generated new API key for user ${req.user.email} (${req.user.id})`);

    res.json({ 
      success: true,
      api_key: apiKey,
      message: 'API key generated successfully',
      key_prefix: apiKey.substring(0, 8) + '...',
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Failed to generate API key:', error);
    res.status(500).json({ 
      error: 'Failed to generate API key',
      message: 'An internal error occurred while generating your API key'
    });
  }
});

/**
 * DELETE /auth/revoke-api-key
 * Revoke (delete) user's API key
 */
router.delete('/revoke-api-key', authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE premium_settings SET api_key = NULL, updated_at = NOW() WHERE user_id = ?',
      [req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        error: 'No API key found',
        message: 'You do not have an API key to revoke'
      });
    }

    // Log the API key revocation
    console.log(`Revoked API key for user ${req.user.email} (${req.user.id})`);

    res.json({ 
      success: true,
      message: 'API key revoked successfully',
      revoked_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Failed to revoke API key:', error);
    res.status(500).json({ 
      error: 'Failed to revoke API key',
      message: 'An internal error occurred while revoking your API key'
    });
  }
});

/**
 * GET /auth/api-usage-history
 * Get user's API usage history (last 30 days)
 */
router.get('/api-usage-history', authenticateToken, async (req, res) => {
  try {
    const [usageHistory] = await pool.query(`
      SELECT 
        date,
        tier_10min,
        tier_1hour,
        tier_1day,
        (tier_10min + tier_1hour + tier_1day) as total_daily,
        created_at,
        updated_at
      FROM api_usage_daily 
      WHERE user_id = ? 
      AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      ORDER BY date DESC
    `, [req.user.id]);

    // Calculate totals
    const totals = usageHistory.reduce((acc, day) => {
      acc.total_10min += day.tier_10min || 0;
      acc.total_1hour += day.tier_1hour || 0;
      acc.total_1day += day.tier_1day || 0;
      acc.total_emails += day.total_daily || 0;
      return acc;
    }, {
      total_10min: 0,
      total_1hour: 0,
      total_1day: 0,
      total_emails: 0
    });

    res.json({
      success: true,
      usage_history: usageHistory,
      summary: {
        period_days: Math.min(30, usageHistory.length),
        totals: totals,
        average_daily: usageHistory.length > 0 ? 
          Math.round(totals.total_emails / usageHistory.length * 100) / 100 : 0
      },
      meta: {
        user_id: req.user.id,
        request_time: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Failed to fetch API usage history:', error);
    res.status(500).json({ 
      error: 'Failed to fetch usage history',
      message: 'An internal error occurred while fetching your usage history'
    });
  }
});

/**
 * GET /auth/api-status
 * Get API service status and user's API access status
 */
router.get('/api-status', authenticateToken, async (req, res) => {
  try {
    // Check if user has an API key
    const [settings] = await pool.query(
      'SELECT api_key FROM premium_settings WHERE user_id = ?',
      [req.user.id]
    );

    const hasApiKey = settings.length > 0 && settings[0].api_key;

    // Get today's usage from memory store (real-time data)
    let todayUsage = null;
    if (hasApiKey) {
      todayUsage = getUserUsageStats(req.user.id);
    }

    res.json({
      success: true,
      api_access: {
        has_api_key: hasApiKey,
        tier: req.user.premium_tier || 'free',
        status: hasApiKey ? 'active' : 'inactive'
      },
      service_status: {
        api_available: true,
        version: 'v1',
        base_url: `${req.protocol}://${req.get('host')}/api/v1`
      },
      today_usage: todayUsage,
      limits: {
        '10min': { daily: 20 },
        '1hour': { daily: 10 },
        '1day': { daily: 5 }
      },
      reset_time: getTomorrowMidnight(),
      meta: {
        user_id: req.user.id,
        request_time: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Failed to fetch API status:', error);
    res.status(500).json({ 
      error: 'Failed to fetch API status',
      message: 'An internal error occurred while fetching API status'
    });
  }
});

export default router; 