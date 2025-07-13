// apiMemoryStore.js - API Email Memory Storage System
// Similar architecture to guestSessionHandler.js but for API users
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';

// In-memory storage for API emails (similar to guest system)
export const apiEmailStore = new Map(); // { emailId: emailData }
export const userApiEmailIndex = new Map(); // { userId: Set(emailIds) }
export const usageCounters = new Map(); // { userId-date: usage }

// Email address to API user lookup (for webhook handling)
export const emailToApiUserMap = new Map(); // { email: { userId, emailId } }

// FREE tier limits
const FREE_LIMITS = {
  '10min': { daily: 20 },
  '1hour': { daily: 10 },
  '1day': { daily: 5 }
};

// Cache expiration time (same as guest system)
const CACHE_EXPIRY = 10 * 60 * 1000; // 10 minutes

// Smart caching for domains and user domains
const domainsCache = {
  domains: [],
  lastUpdate: 0,
  TTL: 30 * 60 * 1000 // 30 minutes
};

const userDomainsCache = new Map(); // { userId: { domains: [], expiresAt } }

/**
 * Generate random string for email local part
 */
const generateRandomString = (length = 8) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/**
 * Get random domain from available domains (with caching)
 */
const getRandomDomain = async () => {
  try {
    // Check cache first
    if (Date.now() - domainsCache.lastUpdate > domainsCache.TTL || domainsCache.domains.length === 0) {
      // Cache miss or expired - refresh from database
      const [domains] = await pool.query('SELECT domain FROM domains');
      domainsCache.domains = domains.map(d => d.domain);
      domainsCache.lastUpdate = Date.now();
      console.log(`Refreshed domains cache: ${domainsCache.domains.length} domains loaded`);
    }
    
    // Return random domain from cache
    if (domainsCache.domains.length > 0) {
      return domainsCache.domains[Math.floor(Math.random() * domainsCache.domains.length)];
    }
    
    return 'boomlify.com';
  } catch (error) {
    console.error('Failed to get random domain:', error);
    return 'boomlify.com';
  }
};

/**
 * Calculate expiry time based on tier
 */
const calculateExpiry = (timeTier) => {
  const now = new Date();
  switch(timeTier) {
    case '10min': return new Date(now.getTime() + 10 * 60 * 1000);
    case '1hour': return new Date(now.getTime() + 60 * 60 * 1000);
    case '1day': return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    default: return new Date(now.getTime() + 10 * 60 * 1000);
  }
};

/**
 * Check if user has reached daily limit for specific tier
 */
const checkDailyLimit = (userId, timeTier) => {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}-${today}`;
  const usage = usageCounters.get(key) || { '10min': 0, '1hour': 0, '1day': 0 };
  const limit = FREE_LIMITS[timeTier].daily;
  
  return usage[timeTier] < limit;
};

/**
 * Update usage counter in memory
 */
const updateUsageCounter = (userId, timeTier) => {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}-${today}`;
  const usage = usageCounters.get(key) || { '10min': 0, '1hour': 0, '1day': 0 };
  
  usage[timeTier] = (usage[timeTier] || 0) + 1;
  usageCounters.set(key, usage);
};

/**
 * Validate user's custom domain (with caching)
 */
const validateUserDomain = async (userId, domain) => {
  try {
    // Check cache first
    const cached = userDomainsCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.domains.includes(domain) ? domain : null;
    }
    
    // Cache miss or expired - refresh from database
    const [customDomains] = await pool.query(
      'SELECT domain FROM custom_domains WHERE user_id = ? AND status = ?',
      [userId, 'verified']
    );
    
    const domains = customDomains.map(d => d.domain);
    userDomainsCache.set(userId, {
      domains,
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes cache
    });
    
    console.log(`Refreshed user domains cache for ${userId}: ${domains.length} domains`);
    
    return domains.includes(domain) ? domain : null;
  } catch (error) {
    console.error('Failed to validate custom domain:', error);
    return null;
  }
};

/**
 * Schedule automatic cleanup for expired email
 */
const scheduleEmailCleanup = (emailId, expiresAt) => {
  const delay = expiresAt.getTime() - Date.now();
  
  if (delay > 0) {
    setTimeout(() => {
      const email = apiEmailStore.get(emailId);
      if (email) {
        // Remove from all maps
        apiEmailStore.delete(emailId);
        userApiEmailIndex.get(email.userId)?.delete(emailId);
        emailToApiUserMap.delete(email.email);
        
        console.log(`API email ${email.email} automatically expired and cleaned up`);
      }
    }, delay);
  }
};

/**
 * Create new API email
 */
export const createApiEmail = async (
  userId,
  timeTier = '10min',
  customDomain = null,
  userTier = 'free'
) => {
  // Skip limit enforcement for privileged tiers
  if (userTier !== 'unlimited' && userTier !== 'enterprise') {
    if (!checkDailyLimit(userId, timeTier)) {
      throw new Error(`Daily limit exceeded for ${timeTier} emails`);
    }
  }

  const emailId = uuidv4();
  let domain;

  if (customDomain) {
    // 1) Check if it's a verified custom domain for the user (cached query)
    domain = await validateUserDomain(userId, customDomain);

    // 2) Fallback: treat it as a public domain existing in "domains" table
    if (!domain) {
      // First, look inside the 30-min cache without DB hit
      const isInCache = domainsCache.domains.includes(customDomain);

      // If cache miss, refresh it once
      if (!isInCache) {
        try {
          const [domains] = await pool.query('SELECT domain FROM domains');
          domainsCache.domains = domains.map(d => d.domain);
          domainsCache.lastUpdate = Date.now();
          console.log(`Refreshed domains cache: ${domainsCache.domains.length} domains loaded`);
        } catch (err) {
          console.error('Failed to refresh domains cache:', err);
        }
      }

      if (domainsCache.domains.includes(customDomain)) {
        domain = customDomain; // Valid public domain
      }
    }

    // Still not found? Throw
    if (!domain) {
      throw new Error(`Domain ${customDomain} is not available`);
    }
  } else {
    // No domain specified – use a random public domain
    domain = await getRandomDomain();
  }

  const email = `${generateRandomString()}@${domain}`;
  const expiresAt = calculateExpiry(timeTier);
  
  const emailData = {
    id: emailId,
    email,
    userId,
    timeTier,
    createdAt: new Date(),
    expiresAt,
    messages: [],
    isApiEmail: true, // Flag to distinguish from regular emails
    domain: domain,
    isCustomDomain: !!customDomain
  };
  
  // Store in memory (like guest system)
  apiEmailStore.set(emailId, emailData);
  
  // Index by user
  if (!userApiEmailIndex.has(userId)) {
    userApiEmailIndex.set(userId, new Set());
  }
  userApiEmailIndex.get(userId).add(emailId);
  
  // Add to email lookup map (for webhook handling)
  emailToApiUserMap.set(email, { userId, emailId });
  
  // Update usage counter in memory
  updateUsageCounter(userId, timeTier);
  
  // Schedule automatic cleanup
  scheduleEmailCleanup(emailId, expiresAt);
  
  console.log(`Created API email: ${email} for user ${userId}, expires at ${expiresAt.toISOString()}`);
  
  return emailData;
};

/**
 * Get all API emails for a user
 */
export const getUserApiEmails = (userId) => {
  const emailIds = userApiEmailIndex.get(userId) || new Set();
  const emails = [];
  
  for (const emailId of emailIds) {
    const email = apiEmailStore.get(emailId);
    if (email && email.expiresAt > new Date()) {
      emails.push(email);
    } else if (email && email.expiresAt <= new Date()) {
      // Clean up expired email
      apiEmailStore.delete(emailId);
      userApiEmailIndex.get(userId)?.delete(emailId);
      emailToApiUserMap.delete(email.email);
    }
  }
  
  // Sort by creation time (newest first)
  return emails.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

/**
 * Get specific API email by ID for a user
 */
export const getApiEmail = (emailId, userId) => {
  const email = apiEmailStore.get(emailId);
  
  if (!email || email.userId !== userId) {
    return null;
  }
  
  // Check if expired
  if (email.expiresAt <= new Date()) {
    // Clean up expired email
    apiEmailStore.delete(emailId);
    userApiEmailIndex.get(userId)?.delete(emailId);
    emailToApiUserMap.delete(email.email);
    return null;
  }
  
  return email;
};

/**
 * Delete an API email
 */
export const deleteApiEmail = (emailId, userId) => {
  const email = apiEmailStore.get(emailId);
  
  if (!email || email.userId !== userId) {
    return false; // Email not found or doesn't belong to user
  }
  
  // Remove from all maps and indexes
  apiEmailStore.delete(emailId);
  userApiEmailIndex.get(userId)?.delete(emailId);
  emailToApiUserMap.delete(email.email);
  
  console.log(`API email ${email.email} deleted by user ${userId}`);
  
  return true; // Successfully deleted
};

/**
 * Add received message to API email
 */
export const addApiEmailMessage = (emailId, messageData) => {
  const email = apiEmailStore.get(emailId);
  
  if (!email || email.expiresAt <= new Date()) {
    return false;
  }
  
  // Add message to the beginning (newest first)
  email.messages.unshift({
    ...messageData,
    received_at: messageData.received_at || new Date().toISOString()
  });
  
  // Limit messages to prevent memory bloat (keep last 50 messages)
  if (email.messages.length > 50) {
    email.messages = email.messages.slice(0, 50);
  }
  
  apiEmailStore.set(emailId, email);
  
  console.log(`Added message to API email ${email.email}: ${messageData.subject}`);
  
  return true;
};

/**
 * Get usage statistics for a user
 */
export const getUserUsageStats = (userId) => {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}-${today}`;
  const usage = usageCounters.get(key) || { '10min': 0, '1hour': 0, '1day': 0 };
  
  return {
    '10min': usage['10min'] || 0,
    '1hour': usage['1hour'] || 0,
    '1day': usage['1day'] || 0
  };
};

/**
 * Get tomorrow midnight for reset time
 */
export const getTomorrowMidnight = () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString();
};

/**
 * Find API user by email address (for webhook handling)
 */
export const findApiUserByEmail = (emailAddress) => {
  return emailToApiUserMap.get(emailAddress) || null;
};

/**
 * Sync usage counters to database (called periodically)
 */
const syncUsageToDatabase = async () => {
  try {
    for (const [key, usage] of usageCounters.entries()) {
      // Fix: Split on last dash to handle UUIDs with multiple dashes
      const lastDashIndex = key.lastIndexOf('-');
      if (lastDashIndex === -1) {
        console.error('Invalid usage counter key format:', key);
        continue;
      }
      
      const userId = key.substring(0, lastDashIndex);
      const date = key.substring(lastDashIndex + 1);
      
      // Validate date format (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error('Invalid date format in key:', key, 'extracted date:', date);
        continue;
      }
      
      await pool.query(`
        INSERT INTO api_usage_daily (user_id, date, tier_10min, tier_1hour, tier_1day, updated_at) 
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE 
        tier_10min = VALUES(tier_10min),
        tier_1hour = VALUES(tier_1hour),
        tier_1day = VALUES(tier_1day),
        updated_at = NOW()
      `, [userId, date, usage['10min'] || 0, usage['1hour'] || 0, usage['1day'] || 0]);
    }
    
    console.log(`Synced ${usageCounters.size} usage records to database`);
  } catch (error) {
    console.error('Failed to sync usage to database:', error);
  }
};

/**
 * Clean up expired emails and old usage counters
 */
const cleanupExpiredData = () => {
  const now = new Date();
  let cleanedEmails = 0;
  let cleanedCounters = 0;
  
  // Clean expired emails
  for (const [emailId, email] of apiEmailStore.entries()) {
    if (email.expiresAt <= now) {
      apiEmailStore.delete(emailId);
      userApiEmailIndex.get(email.userId)?.delete(emailId);
      emailToApiUserMap.delete(email.email);
      cleanedEmails++;
    }
  }
  
  // Clean old usage counters (older than 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];
  
  for (const [key] of usageCounters.entries()) {
    // Fix: Split on last dash to handle UUIDs with multiple dashes
    const lastDashIndex = key.lastIndexOf('-');
    if (lastDashIndex === -1) continue;
    
    const date = key.substring(lastDashIndex + 1);
    if (date < cutoffDate) {
      usageCounters.delete(key);
      cleanedCounters++;
    }
  }
  
  // Clean expired user domains cache
  let cleanedDomainCache = 0;
  for (const [userId, data] of userDomainsCache.entries()) {
    if (data.expiresAt <= now.getTime()) {
      userDomainsCache.delete(userId);
      cleanedDomainCache++;
    }
  }

  if (cleanedEmails > 0 || cleanedCounters > 0 || cleanedDomainCache > 0) {
    console.log(`Cleanup: Removed ${cleanedEmails} expired emails, ${cleanedCounters} old usage counters, and ${cleanedDomainCache} expired domain caches`);
  }
};

// Sync to database every 5 minutes (like your cache system)
setInterval(syncUsageToDatabase, 5 * 60 * 1000);

// Cleanup expired data every hour
setInterval(cleanupExpiredData, 60 * 60 * 1000);

// Initial cleanup on startup
setTimeout(cleanupExpiredData, 5000);

/**
 * Initialize the API memory store
 */
export const initializeApiMemoryStore = () => {
  console.log('API Memory Store initialized with periodic sync and cleanup');
  
  // Run initial cleanup
  setTimeout(cleanupExpiredData, 5000);
  
  return {
    emailCount: apiEmailStore.size,
    userCount: userApiEmailIndex.size,
    usageCounterCount: usageCounters.size
  };
};

/**
 * Invalidate user's domains cache when they add/remove domains
 */
export const invalidateUserDomainsCache = (userId) => {
  userDomainsCache.delete(userId);
  console.log(`Invalidated domains cache for user ${userId}`);
};

/**
 * Invalidate all domains cache when domains are added/removed
 */
export const invalidateDomainsCache = () => {
  domainsCache.lastUpdate = 0;
  domainsCache.domains = [];
  console.log('Invalidated global domains cache');
};

console.log('API Memory Store loaded with smart caching'); 