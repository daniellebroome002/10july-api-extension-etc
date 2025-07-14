import NodeCache from 'node-cache';
import { pool } from '../../db/init.js';
import { v4 as uuidv4 } from 'uuid';

class CreditManager {
  constructor() {
    // Credit wallet cache - instant operations
    this.creditWalletCache = new NodeCache({ 
      stdTTL: 300, // 5 minutes TTL
      checkperiod: 60, // Check for expired keys every minute
      useClones: false // Better performance
    });
    
    // Subscription status cache - 5 minute TTL  
    this.subscriptionCache = new NodeCache({
      stdTTL: 300, // 5 minutes TTL
      checkperiod: 60,
      useClones: false
    });
    
    // Monthly usage cache - updated frequently
    this.monthlyUsageCache = new NodeCache({
      stdTTL: 600, // 10 minutes TTL for usage stats
      checkperiod: 120,
      useClones: false
    });
    
    // Batch operations queue
    this.creditUpdateQueue = new Map(); // { userId: { deltaAmount, lastUpdate } }
    this.usageUpdateQueue = new Map(); // { userId-monthYear: usageData }
    
    // Start batch processor every 5 minutes
    this.batchInterval = setInterval(() => {
      this.processBatchOperations();
    }, 5 * 60 * 1000);
    
    console.log('CreditManager initialized with caching and batch processing');
  }
  
  // ==================== CREDIT BALANCE OPERATIONS ====================
  
  /**
   * Get user's credit balance (cache-first)
   * @param {string} userId - User ID
   * @returns {number} Credit balance
   */
  async getBalance(userId) {
    // 1. Check cache first
    const cached = this.creditWalletCache.get(`balance_${userId}`);
    if (cached !== undefined) {
      return cached.balance;
    }
    
    // 2. Cache miss - load from database
    const balance = await this.loadBalanceFromDB(userId);
    
    // 3. Cache the result
    this.creditWalletCache.set(`balance_${userId}`, {
      balance,
      lastSync: Date.now(),
      dirty: false
    });
    
    return balance;
  }
  
  /**
   * Load balance from database
   * @param {string} userId - User ID  
   * @returns {number} Credit balance
   */
  async loadBalanceFromDB(userId) {
    try {
      const [rows] = await pool.execute(
        'SELECT credit_balance FROM users WHERE id = ? LIMIT 1',
        [userId]
      );
      
      return rows.length > 0 ? (rows[0].credit_balance || 0) : 0;
    } catch (error) {
      console.error('Error loading credit balance from DB:', error);
      throw new Error('Failed to load credit balance');
    }
  }
  
  /**
   * Charge credits from user wallet (cache-first with batch sync)
   * @param {string} userId - User ID
   * @param {number} amount - Credits to charge
   * @returns {number} New balance
   */
  async chargeCredits(userId, amount) {
    if (amount <= 0) {
      throw new Error('Invalid credit amount');
    }
    
    // Get current balance
    const currentBalance = await this.getBalance(userId);
    
    if (currentBalance < amount) {
      throw new Error('INSUFFICIENT_CREDITS');
    }
    
    // Update cache immediately
    const newBalance = currentBalance - amount;
    this.creditWalletCache.set(`balance_${userId}`, {
      balance: newBalance,
      lastSync: Date.now(),
      dirty: true
    });
    
    // Queue database update
    this.scheduleCreditUpdate(userId, -amount);
    
    return newBalance;
  }
  
  /**
   * Add credits to user wallet
   * @param {string} userId - User ID
   * @param {number} amount - Credits to add
   * @returns {number} New balance
   */
  async addCredits(userId, amount) {
    if (amount <= 0) {
      throw new Error('Invalid credit amount');
    }
    
    // Get current balance
    const currentBalance = await this.getBalance(userId);
    
    // Update cache immediately
    const newBalance = currentBalance + amount;
    this.creditWalletCache.set(`balance_${userId}`, {
      balance: newBalance,
      lastSync: Date.now(),
      dirty: true
    });
    
    // Queue database update
    this.scheduleCreditUpdate(userId, amount);
    
    return newBalance;
  }
  
  // ==================== SUBSCRIPTION CREDITS ====================
  
  /**
   * Get user's subscription status and monthly allowance
   * @param {string} userId - User ID
   * @returns {Object} Subscription data
   */
  async getUserSubscription(userId) {
    const cacheKey = `subscription_${userId}`;
    const cached = this.subscriptionCache.get(cacheKey);
    
    if (cached) {
      return cached;
    }
    
    // Load from database
    const subscription = await this.loadSubscriptionFromDB(userId);
    
    // Cache for 5 minutes
    this.subscriptionCache.set(cacheKey, subscription);
    
    return subscription;
  }
  
  /**
   * Load subscription from database
   * @param {string} userId - User ID
   * @returns {Object} Subscription data
   */
  async loadSubscriptionFromDB(userId) {
    try {
      const [rows] = await pool.execute(`
        SELECT 
          plan_type,
          status,
          monthly_credits,
          next_billing_date,
          created_at
        FROM nowpayments_subscriptions 
        WHERE user_id = ? AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);
      
      if (rows.length === 0) {
        return {
          tier: 'free',
          status: 'none',
          monthlyCredits: 0,
          nextBilling: null
        };
      }
      
      const sub = rows[0];
      return {
        tier: sub.plan_type,
        status: sub.status,
        monthlyCredits: sub.monthly_credits,
        nextBilling: sub.next_billing_date
      };
    } catch (error) {
      console.error('Error loading subscription from DB:', error);
      return {
        tier: 'free',
        status: 'error',
        monthlyCredits: 0,
        nextBilling: null
      };
    }
  }
  
  /**
   * Get monthly usage for user
   * @param {string} userId - User ID
   * @param {string} monthYear - Format: 2025-01
   * @returns {Object} Usage data
   */
  async getMonthlyUsage(userId, monthYear = null) {
    if (!monthYear) {
      monthYear = new Date().toISOString().slice(0, 7); // Current month
    }
    
    const cacheKey = `usage_${userId}_${monthYear}`;
    const cached = this.monthlyUsageCache.get(cacheKey);
    
    if (cached) {
      return cached;
    }
    
    // Load from database
    const usage = await this.loadMonthlyUsageFromDB(userId, monthYear);
    
    // Cache for 10 minutes
    this.monthlyUsageCache.set(cacheKey, usage);
    
    return usage;
  }
  
  /**
   * Load monthly usage from database
   * @param {string} userId - User ID
   * @param {string} monthYear - Format: 2025-01
   * @returns {Object} Usage data
   */
  async loadMonthlyUsageFromDB(userId, monthYear) {
    try {
      const [rows] = await pool.execute(`
        SELECT 
          credits_used_included,
          credits_used_purchased,
          subscription_allowance,
          allowance_reset_at,
          total_emails_created
        FROM monthly_usage 
        WHERE user_id = ? AND month_year = ?
        LIMIT 1
      `, [userId, monthYear]);
      
      if (rows.length === 0) {
        return {
          creditsUsedIncluded: 0,
          creditsUsedPurchased: 0,
          subscriptionAllowance: 0,
          allowanceResetAt: null,
          totalEmailsCreated: 0
        };
      }
      
      const usage = rows[0];
      return {
        creditsUsedIncluded: usage.credits_used_included,
        creditsUsedPurchased: usage.credits_used_purchased,
        subscriptionAllowance: usage.subscription_allowance,
        allowanceResetAt: usage.allowance_reset_at,
        totalEmailsCreated: usage.total_emails_created
      };
    } catch (error) {
      console.error('Error loading monthly usage from DB:', error);
      return {
        creditsUsedIncluded: 0,
        creditsUsedPurchased: 0,
        subscriptionAllowance: 0,
        allowanceResetAt: null,
        totalEmailsCreated: 0
      };
    }
  }
  
  // ==================== SMART CREDIT CHARGING ====================
  
  /**
   * Smart credit charging - tries subscription credits first, then wallet
   * @param {string} userId - User ID
   * @param {string} timeTier - Email time tier (10min, 1hour, 1day)
   * @param {string} userTier - User subscription tier
   * @returns {Object} Charge result
   */
  async chargeCreditsForEmail(userId, timeTier, userTier = 'free') {
    const creditCost = this.calculateCreditCost(timeTier);
    const monthYear = new Date().toISOString().slice(0, 7);
    
    let chargedFromSubscription = 0;
    let chargedFromWallet = 0;
    
    // For premium users, try subscription credits first
    if (userTier !== 'free') {
      const subscription = await this.getUserSubscription(userId);
      const monthlyUsage = await this.getMonthlyUsage(userId, monthYear);
      
      const availableSubscriptionCredits = Math.max(0, 
        subscription.monthlyCredits - monthlyUsage.creditsUsedIncluded
      );
      
      if (availableSubscriptionCredits > 0) {
        chargedFromSubscription = Math.min(creditCost, availableSubscriptionCredits);
        
        // Update monthly usage cache
        this.updateMonthlyUsageCache(userId, monthYear, {
          creditsUsedIncluded: monthlyUsage.creditsUsedIncluded + chargedFromSubscription,
          [`emails_created_${timeTier}`]: 1
        });
      }
    }
    
    // Charge remaining from wallet if needed
    const remainingCost = creditCost - chargedFromSubscription;
    if (remainingCost > 0) {
      const newBalance = await this.chargeCredits(userId, remainingCost);
      chargedFromWallet = remainingCost;
      
      // Update monthly usage for purchased credits
      const monthlyUsage = await this.getMonthlyUsage(userId, monthYear);
      this.updateMonthlyUsageCache(userId, monthYear, {
        creditsUsedPurchased: monthlyUsage.creditsUsedPurchased + remainingCost,
        [`emails_created_${timeTier}`]: 1
      });
    }
    
    return {
      totalCharged: creditCost,
      chargedFromSubscription,
      chargedFromWallet,
      remainingBalance: await this.getBalance(userId)
    };
  }
  
  /**
   * Calculate credit cost for time tier
   * @param {string} timeTier - Time tier (10min, 1hour, 1day)
   * @returns {number} Credit cost
   */
  calculateCreditCost(timeTier) {
    const costs = {
      '10min': 1,
      '1hour': 5, 
      '1day': 25
    };
    return costs[timeTier] || 1;
  }
  
  // ==================== CACHE MANAGEMENT ====================
  
  /**
   * Update monthly usage cache
   * @param {string} userId - User ID
   * @param {string} monthYear - Month year
   * @param {Object} updateData - Data to update
   */
  updateMonthlyUsageCache(userId, monthYear, updateData) {
    const cacheKey = `usage_${userId}_${monthYear}`;
    const current = this.monthlyUsageCache.get(cacheKey) || {};
    
    const updated = { ...current, ...updateData };
    this.monthlyUsageCache.set(cacheKey, updated);
    
    // Queue database update
    this.scheduleUsageUpdate(userId, monthYear, updated);
  }
  
  /**
   * Schedule credit balance update for batch processing
   * @param {string} userId - User ID
   * @param {number} deltaAmount - Amount to add/subtract
   */
  scheduleCreditUpdate(userId, deltaAmount) {
    const existing = this.creditUpdateQueue.get(userId) || { deltaAmount: 0, lastUpdate: Date.now() };
    
    this.creditUpdateQueue.set(userId, {
      deltaAmount: existing.deltaAmount + deltaAmount,
      lastUpdate: Date.now()
    });
  }
  
  /**
   * Schedule usage update for batch processing
   * @param {string} userId - User ID
   * @param {string} monthYear - Month year
   * @param {Object} usageData - Usage data
   */
  scheduleUsageUpdate(userId, monthYear, usageData) {
    const key = `${userId}-${monthYear}`;
    this.usageUpdateQueue.set(key, usageData);
  }
  
  // ==================== BATCH PROCESSING ====================
  
  /**
   * Process all queued batch operations
   */
  async processBatchOperations() {
    try {
      await Promise.all([
        this.processCreditUpdates(),
        this.processUsageUpdates()
      ]);
    } catch (error) {
      console.error('Error processing batch operations:', error);
    }
  }
  
  /**
   * Process credit balance updates in batch
   */
  async processCreditUpdates() {
    if (this.creditUpdateQueue.size === 0) return;
    
    const updates = Array.from(this.creditUpdateQueue.entries());
    this.creditUpdateQueue.clear();
    
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      
      for (const [userId, { deltaAmount }] of updates) {
        await connection.execute(
          'UPDATE users SET credit_balance = credit_balance + ? WHERE id = ?',
          [deltaAmount, userId]
        );
        
        // Update cache sync status
        const cached = this.creditWalletCache.get(`balance_${userId}`);
        if (cached) {
          cached.dirty = false;
          cached.lastSync = Date.now();
          this.creditWalletCache.set(`balance_${userId}`, cached);
        }
      }
      
      await connection.commit();
      console.log(`Batch updated ${updates.length} credit balances`);
    } catch (error) {
      await connection.rollback();
      
      // Re-queue failed updates
      for (const [userId, updateData] of updates) {
        this.scheduleCreditUpdate(userId, updateData.deltaAmount);
      }
      
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Process usage updates in batch
   */
  async processUsageUpdates() {
    if (this.usageUpdateQueue.size === 0) return;
    
    const updates = Array.from(this.usageUpdateQueue.entries());
    this.usageUpdateQueue.clear();
    
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      
      for (const [key, usageData] of updates) {
        const [userId, monthYear] = key.split('-');
        
        await connection.execute(`
          INSERT INTO monthly_usage (
            user_id, month_year, credits_used_included, credits_used_purchased,
            emails_created_10min, emails_created_1hour, emails_created_1day,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            credits_used_included = VALUES(credits_used_included),
            credits_used_purchased = VALUES(credits_used_purchased),
            emails_created_10min = emails_created_10min + VALUES(emails_created_10min),
            emails_created_1hour = emails_created_1hour + VALUES(emails_created_1hour),
            emails_created_1day = emails_created_1day + VALUES(emails_created_1day),
            updated_at = NOW()
        `, [
          userId, 
          monthYear,
          usageData.creditsUsedIncluded || 0,
          usageData.creditsUsedPurchased || 0,
          usageData.emails_created_10min || 0,
          usageData.emails_created_1hour || 0,
          usageData.emails_created_1day || 0
        ]);
      }
      
      await connection.commit();
      console.log(`Batch updated ${updates.length} usage records`);
    } catch (error) {
      await connection.rollback();
      
      // Re-queue failed updates
      for (const [key, usageData] of updates) {
        this.usageUpdateQueue.set(key, usageData);
      }
      
      throw error;
    } finally {
      connection.release();
    }
  }
  
  // ==================== CLEANUP ====================
  
  /**
   * Cleanup and shutdown
   */
  destroy() {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
    }
    
    // Process remaining batches
    this.processBatchOperations();
    
    // Clear caches
    this.creditWalletCache.flushAll();
    this.subscriptionCache.flushAll();
    this.monthlyUsageCache.flushAll();
    
    console.log('CreditManager destroyed');
  }
}

// Export singleton instance
export default new CreditManager(); 