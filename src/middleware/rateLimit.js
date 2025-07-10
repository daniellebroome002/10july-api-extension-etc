import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

// In-memory store for rate limiting
const rateLimitStore = {
  // Structure: { [ip]: { count: number, resetAt: timestamp, captchaRequired: boolean } }
  limits: {},
  // Structure: { [userId]: { count: number, resetAt: timestamp, captchaRequired: boolean } }
  userLimits: {},
  
  // Rotating CAPTCHA keys
  captchaKeys: [
    { 
      siteKey: process.env.CAPTCHA_SITE_KEY_1, 
      secretKey: process.env.CAPTCHA_SECRET_KEY_1,
      useCount: 0,
      active: true
    },
    { 
      siteKey: process.env.CAPTCHA_SITE_KEY_2, 
      secretKey: process.env.CAPTCHA_SECRET_KEY_2,
      useCount: 0,
      active: false
    },
    { 
      siteKey: process.env.CAPTCHA_SITE_KEY_3, 
      secretKey: process.env.CAPTCHA_SECRET_KEY_3,
      useCount: 0,
      active: false
    }
  ].filter(key => key.siteKey && key.secretKey), // Filter out undefined keys
  
  // Get current active CAPTCHA keys
  getActiveCaptchaKey() {
    const activeKey = this.captchaKeys.find(key => key.active);
    if (activeKey) {
      activeKey.useCount++;
      
      // Rotate keys if current key exceeds 9,500 uses (close to Google's 10k limit)
      if (activeKey.useCount > 9500) {
        this.rotateCaptchaKeys();
      }
      
      return { siteKey: activeKey.siteKey, secretKey: activeKey.secretKey };
    }
    
    // Fallback if no active key (shouldn't happen normally)
    if (this.captchaKeys.length > 0) {
      this.captchaKeys[0].active = true;
      return { siteKey: this.captchaKeys[0].siteKey, secretKey: this.captchaKeys[0].secretKey };
    }
    
    // Emergency fallback to default key
    return { 
      siteKey: '6LeJJ-UgAAAAAPGWWrhpHGCwwV-1ogC2kjOa_NKm', 
      secretKey: '6LeJJ-UgAAAAAHPkW-3XK2qv2HTCHn-q6lbOt-gL' 
    };
  },
  
  // Rotate to next CAPTCHA key
  rotateCaptchaKeys() {
    if (this.captchaKeys.length <= 1) return;
    
    const currentActiveIndex = this.captchaKeys.findIndex(key => key.active);
    if (currentActiveIndex >= 0) {
      this.captchaKeys[currentActiveIndex].active = false;
      
      // Move to next key
      const nextIndex = (currentActiveIndex + 1) % this.captchaKeys.length;
      this.captchaKeys[nextIndex].active = true;
      this.captchaKeys[nextIndex].useCount = 0;
      
      console.log(`Rotated CAPTCHA key to index ${nextIndex}`);
    }
  },
  
  // Clean up old rate limits periodically
  cleanup() {
    const now = Date.now();
    Object.keys(this.limits).forEach(ip => {
      if (this.limits[ip].resetAt < now) {
        delete this.limits[ip];
      }
    });
    
    Object.keys(this.userLimits).forEach(userId => {
      if (this.userLimits[userId].resetAt < now) {
        delete this.userLimits[userId];
      }
    });
  }
};

// Clean up every hour
setInterval(() => rateLimitStore.cleanup(), 60 * 60 * 1000);

// Configuration
const RATE_LIMIT = {
  MAX_EMAILS_PER_HOUR: 15,
  WINDOW_MS: 60 * 60 * 1000, // 1 hour in milliseconds
  // Additional limits for authenticated users
  AUTH_MAX_EMAILS_PER_HOUR: 15, // Higher limit for authenticated users
};

// Rate limit middleware
export function rateLimitMiddleware(req, res, next) {
  // Get client IP with better detection
  const clientIp = getClientIP(req);
  console.log(`Rate limit check for IP: ${clientIp}`); // Debug log
  
  const now = Date.now();
  
  // HYBRID APPROACH: Use IP for guests, userID for authenticated users
  const isGuestUser = !req.user || req.user.isGuest;
  const rateLimitKey = isGuestUser ? clientIp : req.user.id;
  const rateLimitStore_target = isGuestUser ? rateLimitStore.limits : rateLimitStore.userLimits;
  const maxEmails = isGuestUser ? RATE_LIMIT.MAX_EMAILS_PER_HOUR : RATE_LIMIT.AUTH_MAX_EMAILS_PER_HOUR;
  
  console.log(`Rate limiting by ${isGuestUser ? 'IP' : 'UserID'}: ${rateLimitKey}`);
  
  // Initialize or reset expired limit for this key
  if (!rateLimitStore_target[rateLimitKey] || rateLimitStore_target[rateLimitKey].resetAt < now) {
    rateLimitStore_target[rateLimitKey] = {
      count: 0,
      resetAt: now + RATE_LIMIT.WINDOW_MS,
      captchaRequired: false
    };
  }
  
  // Increment count for this key
  rateLimitStore_target[rateLimitKey].count++;
  
  // Check if rate limit is exceeded
  if (rateLimitStore_target[rateLimitKey].count > maxEmails) {
    rateLimitStore_target[rateLimitKey].captchaRequired = true;
  }
  
  console.log(`${isGuestUser ? 'IP' : 'User'} ${rateLimitKey} - Count: ${rateLimitStore_target[rateLimitKey].count}/${maxEmails}, CAPTCHA required: ${rateLimitStore_target[rateLimitKey].captchaRequired}`);
  
  // Add rateLimitInfo to request for use in route handlers
  req.rateLimitInfo = {
    current: rateLimitStore_target[rateLimitKey].count,
    limit: maxEmails,
    captchaRequired: rateLimitStore_target[rateLimitKey].captchaRequired,
    resetAt: rateLimitStore_target[rateLimitKey].resetAt,
    isGuestUser,
    rateLimitKey
  };
  
  next();
}

// Helper function to get client IP reliably
function getClientIP(req) {
  // Check various headers in order of priority
  const xForwardedFor = req.headers['x-forwarded-for'];
  const xRealIp = req.headers['x-real-ip'];
  const cfConnectingIp = req.headers['cf-connecting-ip']; // Cloudflare
  
  // Handle x-forwarded-for (can contain multiple IPs)
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(ip => ip.trim());
    return ips[0]; // First IP is the original client
  }
  
  // Handle other headers
  if (xRealIp) return xRealIp;
  if (cfConnectingIp) return cfConnectingIp;
  
  // Fallback to connection remote address
  return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

// Verify captcha middleware
export async function verifyCaptcha(req, res, next) {
  const clientIp = getClientIP(req);
  
  // HYBRID APPROACH: Use IP for guests, userID for authenticated users
  const isGuestUser = !req.user || req.user.isGuest;
  const rateLimitKey = isGuestUser ? clientIp : req.user.id;
  const rateLimitStore_target = isGuestUser ? rateLimitStore.limits : rateLimitStore.userLimits;
  
  // Check if captcha is required
  const isCaptchaRequired = rateLimitStore_target[rateLimitKey]?.captchaRequired || false;
  
  console.log(`CAPTCHA verification for ${isGuestUser ? 'IP' : 'User'} ${rateLimitKey}: required=${isCaptchaRequired}, has response=${!!req.body.captchaResponse}`);
  
  if (!isCaptchaRequired) {
    return next();
  }
  
  // Get captcha response from request
  const captchaResponse = req.body.captchaResponse;
  
  // If CAPTCHA is required but client hasn't supplied a response yet, let the
  // request continue to the route handler. The handler will return the full
  // payload (including captchaSiteKey) so the client can render the widget.
  if (!captchaResponse) {
    return next();
  }
  
  try {
    // Get active CAPTCHA key for verification
    const { secretKey } = rateLimitStore.getActiveCaptchaKey();
    
    // Verify with Google reCAPTCHA
    const verificationURL = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${captchaResponse}`;
    
    const response = await axios.post(verificationURL);
    const data = response.data;
    
    if (data.success) {
      console.log(`CAPTCHA verification successful for ${isGuestUser ? 'IP' : 'User'} ${rateLimitKey}`);
      // Reset BOTH buckets (IP + user) so captcha isn't requested again immediately
      if (rateLimitStore.limits[clientIp]) {
        rateLimitStore.limits[clientIp].count = 0;
        rateLimitStore.limits[clientIp].captchaRequired = false;
      }
      if (req.user && rateLimitStore.userLimits[req.user.id]) {
        rateLimitStore.userLimits[req.user.id].count = 0;
        rateLimitStore.userLimits[req.user.id].captchaRequired = false;
      }
      
      // Proceed with request
      next();
    } else {
      console.log(`CAPTCHA verification failed for ${isGuestUser ? 'IP' : 'User'} ${rateLimitKey}:`, data);
      return res.status(400).json({ error: 'INVALID_CAPTCHA', message: 'CAPTCHA verification failed' });
    }
  } catch (error) {
    console.error('CAPTCHA verification error:', error);
    return res.status(500).json({ error: 'CAPTCHA_ERROR', message: 'Error verifying CAPTCHA' });
  }
}

// Utility function to get the current CAPTCHA site key
export function getCurrentCaptchaSiteKey() {
  const { siteKey } = rateLimitStore.getActiveCaptchaKey();
  return siteKey;
}

// Middleware to check if CAPTCHA is required and provide site key
export function checkCaptchaRequired(req, res, next) {
  const clientIp = getClientIP(req);
  
  // Check BOTH buckets – IP and (if present) user – so siteKey is sent whenever ANY bucket is blocked
  const isGuestUser = !req.user || req.user.isGuest;
  const rateLimitKey = isGuestUser ? clientIp : req.user.id;
  const ipInfo = rateLimitStore.limits[clientIp] || {};
  const userInfo = req.user ? (rateLimitStore.userLimits[req.user.id] || {}) : {};
  const isCaptchaRequired = ipInfo.captchaRequired || userInfo.captchaRequired || false;
  
  console.log(`CAPTCHA check for ${isGuestUser ? 'IP' : 'User'} ${rateLimitKey}: required=${isCaptchaRequired}`);
  
  // Add CAPTCHA info to the response
  res.locals.captchaRequired = isCaptchaRequired;
  if (isCaptchaRequired) {
    res.locals.captchaSiteKey = getCurrentCaptchaSiteKey();
  }
  
  next();
}

// Export the rate limit store for testing/monitoring
export { rateLimitStore };
