import creditManager from './creditManager.js';
import { pool } from '../../db/init.js';

class UsageTracker {
  constructor() {
    // Enhanced usage counters with credit cost tracking
    this.usageCounters = new Map(); 
    // Structure: { `${userId}-${date}`: { '10min': count, '1hour': count, '1day': count, creditCost: total } }
    
    // Real-time rate limiting counters
    this.rateLimitCounters = new Map();
    // Structure: { `${userId}-${window}`: { count, resetAt } }
    
    // Batch sync interval - every 5 minutes
    this.syncInterval = setInterval(() => {
      this.syncUsageToDatabase();
    }, 5 * 60 * 1000);
    
    console.log('Enhanced UsageTracker initialized with credit integration');
  }
  
  // ==================== CREDIT-AWARE EMAIL CREATION ====================
  
  /**
   * Track API email creation with credit charging
   * @param {string} userId - User ID
   * @param {string} timeTier - Email time tier (10min, 1hour, 1day)
   * @param {string} userTier - User subscription tier
   * @returns {Object} Usage result with credit info
   */
  async trackApiEmailCreation(userId, timeTier, userTier = 'free') {
    // 1. Check rate limits first
    this.checkRateLimit(userId, timeTier);
    
    // 2. Charge credits through CreditManager
    const chargeResult = await creditManager.chargeCreditsForEmail(userId, timeTier, userTier);
    
    // 3. Update usage counters
    this.updateUsageCounters(userId, timeTier, chargeResult.totalCharged);
    
    // 4. Update rate limit counters
    this.updateRateLimitCounters(userId, timeTier);
    
    return {
      success: true,
      creditCharged: chargeResult.totalCharged,
      chargedFromSubscription: chargeResult.chargedFromSubscription,
      chargedFromWallet: chargeResult.chargedFromWallet,
      remainingBalance: chargeResult.remainingBalance,
      usageStats: this.getUserUsageStats(userId)
    };
  }
  
  // ==================== RATE LIMITING ====================
  
  /**
   * Check rate limits for user
   * @param {string} userId - User ID
   * @param {string} timeTier - Email time tier
   */
  checkRateLimit(userId, timeTier) {
    const limits = this.getRateLimits(timeTier);
    
    // Check each rate limit window
    for (const [window, limit] of Object.entries(limits)) {
      const key = `${userId}-${window}`;
      const counter = this.rateLimitCounters.get(key) || { count: 0, resetAt: this.getWindowResetTime(window) };
      
      // Reset if window expired
      if (Date.now() > counter.resetAt) {
        counter.count = 0;
        counter.resetAt = this.getWindowResetTime(window);
      }
      
      // Check limit
      if (counter.count >= limit) {
        throw new Error(`RATE_LIMIT_EXCEEDED_${window.toUpperCase()}`);
      }
      
      this.rateLimitCounters.set(key, counter);
    }
  }
  
  /**
   * Get rate limits for time tier
   * @param {string} timeTier - Email time tier
   * @returns {Object} Rate limits
   */
  getRateLimits(timeTier) {
    const baseLimits = {
      '1min': 10,    // Max 10 emails per minute
      '5min': 30,    // Max 30 emails per 5 minutes
      '1hour': 200,  // Max 200 emails per hour
      '1day': 2000   // Max 2000 emails per day
    };
    
    // Higher limits for longer-lived emails
    const multiplier = {
      '10min': 1,
      '1hour': 0.8,  // Slightly lower for 1-hour emails
      '1day': 0.6    // Lower for 1-day emails
    }[timeTier] || 1;
    
    const limits = {};
    for (const [window, limit] of Object.entries(baseLimits)) {
      limits[window] = Math.floor(limit * multiplier);
    }
    
    return limits;
  }
  
  /**
   * Get window reset time
   * @param {string} window - Time window (1min, 5min, 1hour, 1day)
   * @returns {number} Reset timestamp
   */
  getWindowResetTime(window) {
    const now = new Date();
    
    switch (window) {
      case '1min':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 
                       now.getHours(), now.getMinutes() + 1, 0, 0).getTime();
      case '5min':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                       now.getHours(), Math.floor(now.getMinutes() / 5) * 5 + 5, 0, 0).getTime();
      case '1hour':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 
                       now.getHours() + 1, 0, 0, 0).getTime();
      case '1day':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime();
      default:
        return Date.now() + 60000; // 1 minute fallback
    }
  }
  
  /**
   * Update rate limit counters
   * @param {string} userId - User ID
   * @param {string} timeTier - Email time tier
   */
  updateRateLimitCounters(userId, timeTier) {
    const limits = this.getRateLimits(timeTier);
    
    for (const window of Object.keys(limits)) {
      const key = `${userId}-${window}`;
      const counter = this.rateLimitCounters.get(key) || { count: 0, resetAt: this.getWindowResetTime(window) };
      
      // Reset if window expired
      if (Date.now() > counter.resetAt) {
        counter.count = 0;
        counter.resetAt = this.getWindowResetTime(window);
      }
      
      counter.count++;
      this.rateLimitCounters.set(key, counter);
    }
  }
  
  // ==================== USAGE TRACKING ====================
  
  /**
   * Update usage counters with credit cost tracking
   * @param {string} userId - User ID
   * @param {string} timeTier - Email time tier
   * @param {number} creditCost - Credits charged
   */
  updateUsageCounters(userId, timeTier, creditCost) {
    const today = new Date().toISOString().split('T')[0];
    const key = `${userId}-${today}`;
    
    const usage = this.usageCounters.get(key) || { 
      '10min': 0, 
      '1hour': 0, 
      '1day': 0, 
      creditCost: 0,
      lastUpdate: Date.now()
    };
    
    // Update counters
    usage[timeTier] = (usage[timeTier] || 0) + 1;
    usage.creditCost = (usage.creditCost || 0) + creditCost;
    usage.lastUpdate = Date.now();
    
    this.usageCounters.set(key, usage);
    
    console.log(`Usage tracked - User: ${userId}, Tier: ${timeTier}, Credits: ${creditCost}`);
  }
  
  /**
   * Get user usage statistics for today
   * @param {string} userId - User ID
   * @returns {Object} Usage statistics
   */
  getUserUsageStats(userId) {
    const today = new Date().toISOString().split('T')[0];
    const key = `${userId}-${today}`;
    const usage = this.usageCounters.get(key) || { '10min': 0, '1hour': 0, '1day': 0, creditCost: 0 };
    
    const totalEmails = usage['10min'] + usage['1hour'] + usage['1day'];
    
    return {
      today: {
        emails: {
          '10min': usage['10min'],
          '1hour': usage['1hour'],
          '1day': usage['1day'],
          total: totalEmails
        },
        creditsUsed: usage.creditCost
      },
      rateLimits: this.getCurrentRateLimitStatus(userId)
    };
  }
  
  /**
   * Get current rate limit status for user
   * @param {string} userId - User ID
   * @returns {Object} Rate limit status
   */
  getCurrentRateLimitStatus(userId) {
    const status = {};
    const windows = ['1min', '5min', '1hour', '1day'];
    
    for (const window of windows) {
      const key = `${userId}-${window}`;
      const counter = this.rateLimitCounters.get(key) || { count: 0, resetAt: Date.now() + 60000 };
      
      // Get limits for average time tier
      const limits = this.getRateLimits('10min');
      
      status[window] = {
        used: counter.count,
        limit: limits[window] || 100,
        resetAt: counter.resetAt,
        remaining: Math.max(0, (limits[window] || 100) - counter.count)
      };
    }
    
    return status;
  }
  
  // ==================== DATABASE SYNCHRONIZATION ====================
  
  /**
   * Sync usage data to database (batch operation)
   */
  async syncUsageToDatabase() {
    if (this.usageCounters.size === 0) {
      return;
    }
    
    console.log('Syncing usage data to database...');
    
    const usageData = Array.from(this.usageCounters.entries());
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      for (const [key, usage] of usageData) {
        const [userId, date] = key.split('-');
        
        await connection.execute(`
          INSERT INTO api_usage_daily (
            user_id, date, emails_10min, emails_1hour, emails_1day, 
            total_emails, total_credit_cost, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            emails_10min = emails_10min + VALUES(emails_10min),
            emails_1hour = emails_1hour + VALUES(emails_1hour),
            emails_1day = emails_1day + VALUES(emails_1day),
            total_emails = total_emails + VALUES(total_emails),
            total_credit_cost = total_credit_cost + VALUES(total_credit_cost),
            updated_at = NOW()
        `, [
          userId,
          date,
          usage['10min'] || 0,
          usage['1hour'] || 0,
          usage['1day'] || 0,
          (usage['10min'] || 0) + (usage['1hour'] || 0) + (usage['1day'] || 0),
          usage.creditCost || 0
        ]);
      }
      
      await connection.commit();
      
      // Clear synced data (keep today's data)
      const today = new Date().toISOString().split('T')[0];
      const keysToRemove = [];
      
      for (const key of this.usageCounters.keys()) {
        const [, date] = key.split('-');
        if (date !== today) {
          keysToRemove.push(key);
        }
      }
      
      keysToRemove.forEach(key => this.usageCounters.delete(key));
      
      console.log(`Synced ${usageData.length} usage records to database`);
    } catch (error) {
      await connection.rollback();
      console.error('Error syncing usage to database:', error);
    } finally {
      connection.release();
    }
  }
  
  // ==================== ANALYTICS ====================
  
  /**
   * Get comprehensive usage analytics for user
   * @param {string} userId - User ID
   * @param {number} days - Number of days to look back
   * @returns {Object} Usage analytics
   */
  async getUsageAnalytics(userId, days = 7) {
    try {
      const [rows] = await pool.execute(`
        SELECT 
          date,
          emails_10min,
          emails_1hour,
          emails_1day,
          total_emails,
          total_credit_cost
        FROM api_usage_daily 
        WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ORDER BY date DESC
      `, [userId, days]);
      
      const analytics = {
        dailyUsage: rows,
        totals: {
          emails: rows.reduce((sum, row) => sum + (row.total_emails || 0), 0),
          credits: rows.reduce((sum, row) => sum + (row.total_credit_cost || 0), 0)
        },
        averages: {
          emailsPerDay: rows.length > 0 ? rows.reduce((sum, row) => sum + (row.total_emails || 0), 0) / rows.length : 0,
          creditsPerDay: rows.length > 0 ? rows.reduce((sum, row) => sum + (row.total_credit_cost || 0), 0) / rows.length : 0
        }
      };
      
      return analytics;
    } catch (error) {
      console.error('Error getting usage analytics:', error);
      return {
        dailyUsage: [],
        totals: { emails: 0, credits: 0 },
        averages: { emailsPerDay: 0, creditsPerDay: 0 }
      };
    }
  }
  
  // ==================== CLEANUP ====================
  
  /**
   * Cleanup old rate limit counters
   */
  cleanupRateLimitCounters() {
    const now = Date.now();
    const keysToRemove = [];
    
    for (const [key, counter] of this.rateLimitCounters.entries()) {
      if (now > counter.resetAt + 3600000) { // Remove counters older than 1 hour past reset
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => this.rateLimitCounters.delete(key));
    
    if (keysToRemove.length > 0) {
      console.log(`Cleaned up ${keysToRemove.length} expired rate limit counters`);
    }
  }
  
  /**
   * Destroy and cleanup
   */
  destroy() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    
    // Final sync
    this.syncUsageToDatabase();
    
    // Clear maps
    this.usageCounters.clear();
    this.rateLimitCounters.clear();
    
    console.log('UsageTracker destroyed');
  }
}

// Export singleton instance
export default new UsageTracker(); 