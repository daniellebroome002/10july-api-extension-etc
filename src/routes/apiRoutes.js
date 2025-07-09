// apiRoutes.js - Main API Endpoints (No Encryption)
import express from 'express';
import { 
  authenticateApiKey, 
  apiRateLimit, 
  apiCorsHeaders, 
  addRateLimitHeaders 
} from '../middleware/apiAuth.js';
import { 
  createApiEmail, 
  getUserApiEmails, 
  getApiEmail, 
  getUserUsageStats,
  getTomorrowMidnight,
  deleteApiEmail
} from '../services/apiMemoryStore.js';

const router = express.Router();

// Apply CORS headers to all API routes
router.use(apiCorsHeaders);

// Apply rate limiting to all API routes (60 requests per minute)
router.use(authenticateApiKey, apiRateLimit(60), addRateLimitHeaders);

/**
 * POST /api/v1/emails/create
 * Create a new temporary email
 * Query params:
 * - time: '10min', '1hour', '1day' (default: '10min')
 * - domain: custom domain name (optional, must be verified)
 */
router.post('/emails/create', async (req, res) => {
  try {
    const { time = '10min', domain } = req.query;
    const userId = req.apiUser.id;

    // Validate time parameter
    const validTimes = ['10min', '1hour', '1day'];
    if (!validTimes.includes(time)) {
      return res.status(400).json({ 
        error: 'Invalid time parameter',
        message: 'Time must be one of: 10min, 1hour, 1day',
        validOptions: validTimes
      });
    }

    // Validate domain parameter if provided
    if (domain && (typeof domain !== 'string' || domain.trim() === '')) {
      return res.status(400).json({ 
        error: 'Invalid domain parameter',
        message: 'Domain must be a non-empty string'
      });
    }

    // Create the API email
    const email = await createApiEmail(userId, time, domain?.trim(), req.apiUser.tier);
    
    // Calculate time remaining for response
    const now = new Date();
    const timeRemaining = Math.max(0, email.expiresAt.getTime() - now.getTime());
    const timeRemainingMinutes = Math.floor(timeRemaining / (1000 * 60));
    const timeRemainingSeconds = Math.floor((timeRemaining % (1000 * 60)) / 1000);

    res.status(201).json({
      success: true,
      email: {
        id: email.id,
        address: email.email,
        domain: email.domain,
        time_tier: email.timeTier,
        expires_at: email.expiresAt.toISOString(),
        created_at: email.createdAt.toISOString(),
        is_custom_domain: email.isCustomDomain,
        time_remaining: {
          total_ms: timeRemaining,
          minutes: timeRemainingMinutes,
          seconds: timeRemainingSeconds,
          human_readable: timeRemainingMinutes > 0 
            ? `${timeRemainingMinutes} minutes ${timeRemainingSeconds} seconds`
            : `${timeRemainingSeconds} seconds`
        }
      },
      meta: {
        user_id: userId,
        tier: req.apiUser.tier,
        request_time: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API email creation failed:', error);
    
    // Handle specific error types
    if (error.message.includes('Daily limit exceeded')) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        message: error.message,
        code: 'DAILY_LIMIT_EXCEEDED',
        retry_after: getTomorrowMidnight()
      });
    }
    
    if (error.message.includes('Custom domain')) {
      return res.status(400).json({ 
        error: 'Domain validation failed',
        message: error.message,
        code: 'INVALID_DOMAIN'
      });
    }

    res.status(500).json({ 
      error: 'Email creation failed',
      message: 'An internal error occurred while creating the email',
      code: 'CREATION_FAILED'
    });
  }
});

/**
 * GET /api/v1/emails
 * Get user's API emails
 * Query params:
 * - include_expired: 'true' to include expired emails (default: 'false')
 * - limit: number of emails to return (default: 50, max: 100)
 */
router.get('/emails', async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const includeExpired = req.query.include_expired === 'true';
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    // Get user's API emails
    let apiEmails = getUserApiEmails(userId);

    // Filter expired emails if not requested
    if (!includeExpired) {
      const now = new Date();
      apiEmails = apiEmails.filter(email => email.expiresAt > now);
    }

    // Apply limit
    apiEmails = apiEmails.slice(0, limit);

    // Format emails for response
    const formattedEmails = apiEmails.map(email => {
      const now = new Date();
      const timeRemaining = Math.max(0, email.expiresAt.getTime() - now.getTime());
      const isExpired = email.expiresAt <= now;

      return {
        id: email.id,
        address: email.email,
        domain: email.domain,
        time_tier: email.timeTier,
        expires_at: email.expiresAt.toISOString(),
        created_at: email.createdAt.toISOString(),
        is_custom_domain: email.isCustomDomain,
        message_count: email.messages.length,
        is_expired: isExpired,
        time_remaining: isExpired ? null : {
          total_ms: timeRemaining,
          minutes: Math.floor(timeRemaining / (1000 * 60)),
          seconds: Math.floor((timeRemaining % (1000 * 60)) / 1000)
        }
      };
    });

    res.json({
      success: true,
      emails: formattedEmails,
      meta: {
        total_count: formattedEmails.length,
        user_id: userId,
        tier: req.apiUser.tier,
        include_expired: includeExpired,
        limit: limit,
        request_time: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API emails fetch failed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch emails',
      message: 'An internal error occurred while fetching emails'
    });
  }
});

/**
 * GET /api/v1/emails/:id
 * Get specific API email details
 */
router.get('/emails/:id', async (req, res) => {
  try {
    const emailId = req.params.id;
    const userId = req.apiUser.id;

    // Validate email ID format
    if (!emailId || typeof emailId !== 'string') {
      return res.status(400).json({ 
        error: 'Invalid email ID',
        message: 'Email ID must be a valid string'
      });
    }

    const email = getApiEmail(emailId, userId);
    
    if (!email) {
      return res.status(404).json({ 
        error: 'Email not found',
        message: 'The requested email was not found or has expired'
      });
    }

    // Calculate time remaining
    const now = new Date();
    const timeRemaining = Math.max(0, email.expiresAt.getTime() - now.getTime());
    const isExpired = email.expiresAt <= now;

    res.json({
      success: true,
      email: {
        id: email.id,
        address: email.email,
        domain: email.domain,
        time_tier: email.timeTier,
        expires_at: email.expiresAt.toISOString(),
        created_at: email.createdAt.toISOString(),
        is_custom_domain: email.isCustomDomain,
        message_count: email.messages.length,
        is_expired: isExpired,
        time_remaining: isExpired ? null : {
          total_ms: timeRemaining,
          minutes: Math.floor(timeRemaining / (1000 * 60)),
          seconds: Math.floor((timeRemaining % (1000 * 60)) / 1000)
        }
      },
      meta: {
        user_id: userId,
        tier: req.apiUser.tier,
        request_time: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API email fetch failed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch email',
      message: 'An internal error occurred while fetching the email'
    });
  }
});

/**
 * GET /api/v1/emails/:id/messages
 * Get messages for a specific API email
 * Query params:
 * - limit: number of messages to return (default: 50, max: 100)
 * - offset: number of messages to skip (default: 0)
 */
router.get('/emails/:id/messages', async (req, res) => {
  try {
    const emailId = req.params.id;
    const userId = req.apiUser.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const email = getApiEmail(emailId, userId);
    
    if (!email) {
      return res.status(404).json({ 
        error: 'Email not found',
        message: 'The requested email was not found or has expired'
      });
    }

    // Get messages with pagination
    const allMessages = email.messages || [];
    const paginatedMessages = allMessages.slice(offset, offset + limit);

    // Format messages for response
    const formattedMessages = paginatedMessages.map(message => ({
      id: message.id,
      from_email: message.from_email,
      from_name: message.from_name,
      subject: message.subject,
      body_text: message.body_text,
      body_html: message.body_html,
      received_at: message.received_at,
      is_read: message.is_read || false,
      is_spam: message.is_spam || false
    }));

    res.json({
      success: true,
      messages: formattedMessages,
      email: {
        id: email.id,
        address: email.email,
        message_count: allMessages.length
      },
      pagination: {
        limit: limit,
        offset: offset,
        total: allMessages.length,
        has_more: (offset + limit) < allMessages.length
      },
      meta: {
        user_id: userId,
        tier: req.apiUser.tier,
        request_time: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API messages fetch failed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch messages',
      message: 'An internal error occurred while fetching messages'
    });
  }
});

/**
 * DELETE /api/v1/emails/:id
 * Delete a specific API email
 */
router.delete('/emails/:id', async (req, res) => {
  try {
    const emailId = req.params.id;
    const userId = req.apiUser.id;

    // Validate email ID format
    if (!emailId || typeof emailId !== 'string') {
      return res.status(400).json({ 
        error: 'Invalid email ID',
        message: 'Email ID must be a valid string'
      });
    }

    // Attempt to delete the email
    const deleted = deleteApiEmail(emailId, userId);
    
    if (!deleted) {
      return res.status(404).json({ 
        error: 'Email not found',
        message: 'The requested email was not found or has already expired'
      });
    }

    res.json({
      success: true,
      message: 'Email deleted successfully',
      meta: {
        user_id: userId,
        email_id: emailId,
        deleted_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API email deletion failed:', error);
    res.status(500).json({ 
      error: 'Failed to delete email',
      message: 'An internal error occurred while deleting the email'
    });
  }
});

/**
 * GET /api/v1/account/usage
 * Get user's API usage statistics
 */
router.get('/account/usage', async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const usage = getUserUsageStats(userId);

    // Calculate remaining limits
    const limits = {
      '10min': { daily: 20 },
      '1hour': { daily: 10 },
      '1day': { daily: 5 }
    };

    const usageStats = {
      daily_limits: {
        '10min': {
          used: usage['10min'],
          limit: limits['10min'].daily,
          remaining: Math.max(0, limits['10min'].daily - usage['10min'])
        },
        '1hour': {
          used: usage['1hour'],
          limit: limits['1hour'].daily,
          remaining: Math.max(0, limits['1hour'].daily - usage['1hour'])
        },
        '1day': {
          used: usage['1day'],
          limit: limits['1day'].daily,
          remaining: Math.max(0, limits['1day'].daily - usage['1day'])
        }
      },
      tier: req.apiUser.tier,
      reset_time: getTomorrowMidnight(),
      total_used_today: usage['10min'] + usage['1hour'] + usage['1day']
    };

    res.json({
      success: true,
      usage: usageStats,
      account: {
        user_id: userId,
        email: req.apiUser.email,
        tier: req.apiUser.tier,
        member_since: req.apiUser.userCreatedAt
      },
      meta: {
        request_time: new Date().toISOString(),
        date: new Date().toISOString().split('T')[0]
      }
    });

  } catch (error) {
    console.error('API usage fetch failed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch usage statistics',
      message: 'An internal error occurred while fetching usage data'
    });
  }
});

/**
 * GET /api/v1/account/info
 * Get basic account information
 */
router.get('/account/info', async (req, res) => {
  try {
    res.json({
      success: true,
      account: {
        user_id: req.apiUser.id,
        email: req.apiUser.email,
        tier: req.apiUser.tier,
        member_since: req.apiUser.userCreatedAt,
        api_key_prefix: req.apiUser.apiKey.substring(0, 8) + '...'
      },
      features: {
        daily_limits: {
          '10min_emails': 20,
          '1hour_emails': 10,
          '1day_emails': 5
        },
        custom_domains: true,
        webhook_support: false, // Future feature
        bulk_operations: false  // Future feature
      },
      meta: {
        request_time: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API account info fetch failed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch account information',
      message: 'An internal error occurred while fetching account data'
    });
  }
});

export default router; 