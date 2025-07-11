// apiAuth.js - API Key Authentication Middleware
import { pool } from '../db/init.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const billingService = require('../services/billing.js');

// Smart caching for API tokens
const tokenCache = new Map(); // { apiKey: { userInfo, expiresAt } }
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Clean expired cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokenCache.entries()) {
    if (value.expiresAt <= now) {
      tokenCache.delete(key);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

/**
 * Authenticate API key from X-API-Key header
 * Checks against existing premium_settings table
 */
export const authenticateApiKey = async (req, res, next) => {
  // Check both header and query parameter for API key (CORS compatibility)
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey) {
    return res.status(401).json({ 
      error: 'API key required',
      message: 'Please provide your API key in the X-API-Key header or api_key query parameter'
    });
  }

  // Validate API key format
  if (!apiKey.startsWith('api_') || apiKey.length < 20) {
    return res.status(401).json({ 
      error: 'Invalid API key format',
      message: 'API key must start with "api_" and be at least 20 characters long'
    });
  }

  try {
    // Check cache first for instant response
    const cached = tokenCache.get(apiKey);
    if (cached && cached.expiresAt > Date.now()) {
      req.apiUser = cached.userInfo;
      console.log(`API request from user ${req.apiUser.email} (${req.apiUser.id}) - ${req.method} ${req.path} [CACHED]`);
      return next();
    }

    // Cache miss - check database
    const [settings] = await pool.query(`
      SELECT 
        ps.*, 
        u.id as user_id, 
        u.email as user_email,
        u.premium_tier,
        u.created_at as user_created_at
      FROM premium_settings ps 
      JOIN users u ON ps.user_id = u.id 
      WHERE ps.api_key = ? AND u.id IS NOT NULL
    `, [apiKey]);
    
    if (settings.length === 0) {
      return res.status(401).json({ 
        error: 'Invalid API key',
        message: 'The provided API key is not valid or has been revoked'
      });
    }

    const userSettings = settings[0];

    // Check if user account is active (basic validation)
    if (!userSettings.user_email || userSettings.user_email.trim() === '') {
      return res.status(401).json({ 
        error: 'User account inactive',
        message: 'The user account associated with this API key is inactive'
      });
    }
    
    // Get credit information for premium users
    let creditInfo = null;
    if (userSettings.premium_tier && userSettings.premium_tier !== 'free') {
      try {
        creditInfo = await billingService.getUserCreditInfo(userSettings.user_id);
      } catch (error) {
        console.error(`Failed to get credit info for user ${userSettings.user_id}:`, error);
        // Continue without credit info - don't block API access
      }
    }

    // Attach user info to request object
    const userInfo = {
      id: userSettings.user_id,
      email: userSettings.user_email,
      tier: userSettings.premium_tier || 'free', // Default to free tier
      apiKey: apiKey,
      userCreatedAt: userSettings.user_created_at,
      settingsId: userSettings.id,
      // Credit and subscription information
      creditBalance: creditInfo?.creditBalance || 0,
      subscription: creditInfo?.subscription || null,
      monthlyUsage: creditInfo?.monthlyUsage || null
    };
    
    req.apiUser = userInfo;

    // Cache the result for future requests
    tokenCache.set(apiKey, {
      userInfo: userInfo,
      expiresAt: Date.now() + CACHE_TTL
    });

    // Log API usage (optional - for monitoring)
    console.log(`API request from user ${req.apiUser.email} (${req.apiUser.id}) - ${req.method} ${req.path} [DB]`);
    
    next();
  } catch (error) {
    console.error('API authentication failed:', error);
    res.status(500).json({ 
      error: 'Authentication failed',
      message: 'Internal server error during authentication'
    });
  }
};

/**
 * Tier-based rate limiting constants
 */
const RATE_LIMITS = {
  'free': 60,          // 60 requests per minute
  'premium': 120,      // 120 requests per minute  
  'premium_plus': 1000 // 1000 requests per minute (soft limit)
};

/**
 * Optional: Rate limiting middleware for API endpoints
 * Adjusts rate limits based on user tier
 */
export const apiRateLimit = (baseRequestsPerMinute = 60) => {
  const requestCounts = new Map();
  
  return (req, res, next) => {
    const userId = req.apiUser?.id;
    const userTier = req.apiUser?.tier || 'free';

    // Get tier-specific rate limit
    const requestsPerMinute = RATE_LIMITS[userTier] || baseRequestsPerMinute;

    if (!userId) {
      return next(); // Should not happen after auth
    }

    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000; // 1-minute window
    const key = `${userId}-${windowStart}`;

    const currentCount = requestCounts.get(key) || 0;

    if (currentCount >= requestsPerMinute) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Maximum ${requestsPerMinute} requests per minute allowed`,
        retryAfter: 60 - Math.floor((now - windowStart) / 1000)
      });
    }

    requestCounts.set(key, currentCount + 1);
    
    // Clean up old entries every 5 minutes
    if (Math.random() < 0.01) { // 1% chance to trigger cleanup
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      for (const [mapKey] of requestCounts.entries()) {
        const [, timestamp] = mapKey.split('-');
        if (parseInt(timestamp) < fiveMinutesAgo) {
          requestCounts.delete(mapKey);
        }
      }
    }
    
    next();
  };
};

/**
 * Middleware to add CORS headers for API endpoints
 */
export const apiCorsHeaders = (req, res, next) => {
  // Set CORS headers for API endpoints
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.header('Access-Control-Expose-Headers', 'X-RateLimit-Remaining, X-RateLimit-Reset');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
};

/**
 * Add rate limit and billing headers to response
 */
export const addRateLimitHeaders = (req, res, next) => {
  const userId = req.apiUser?.id;
  const userTier = req.apiUser?.tier || 'free';
  
  if (userId) {
    // Add tier-specific rate limit headers
    const rateLimit = RATE_LIMITS[userTier] || 60;
    res.header('X-RateLimit-Limit', rateLimit.toString());
    res.header('X-RateLimit-Window', '60');
    
    // Add billing information headers for premium users
    if (userTier !== 'free') {
      res.header('X-Credit-Balance', req.apiUser.creditBalance?.toString() || '0');
      
      if (req.apiUser.monthlyUsage) {
        res.header('X-Monthly-Allowance', req.apiUser.monthlyUsage.monthlyAllowance?.toString() || '0');
        res.header('X-Allowance-Remaining', req.apiUser.monthlyUsage.allowanceRemaining?.toString() || '0');
      }
    }
    
    // Add user tier header
    res.header('X-User-Tier', userTier);
  }
  next();
};

/**
 * Middleware to check if user has sufficient credits before API operations
 * Use this before credit-consuming endpoints
 */
export const checkCreditsAvailable = (requiredCredits = 1) => {
  return async (req, res, next) => {
    const userId = req.apiUser?.id;
    const userTier = req.apiUser?.tier || 'free';
    
    // Free users don't use credits - they use daily limits
    if (userTier === 'free') {
      return next();
    }
    
    try {
      // Check if user can afford the operation
      const affordabilityCheck = await billingService.canAffordCredits(userId, requiredCredits);
      
      if (!affordabilityCheck.canAfford) {
        return res.status(402).json({
          error: 'Insufficient credits',
          message: `This operation requires ${requiredCredits} credits but you only have ${affordabilityCheck.paymentBreakdown.totalAvailable} available`,
          required: requiredCredits,
          available: affordabilityCheck.paymentBreakdown.totalAvailable,
          creditBalance: affordabilityCheck.creditInfo.creditBalance,
          allowanceRemaining: affordabilityCheck.creditInfo.monthlyUsage.allowanceRemaining,
          upgradeUrl: '/billing' // Frontend can use this to redirect to billing page
        });
      }
      
      // Store affordability info for the actual charge later
      req.creditCheck = affordabilityCheck;
      next();
      
    } catch (error) {
      console.error('Credit check failed:', error);
      res.status(500).json({
        error: 'Credit check failed',
        message: 'Unable to verify credit balance'
      });
    }
  };
}; 
