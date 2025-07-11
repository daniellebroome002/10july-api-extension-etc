import { pool } from '../db/init.js';

/**
 * Billing Service - Credit Management & Subscription Tracking
 * 
 * Features:
 * - Credit cost calculation (10min=1cr, 1hr=2cr, 24hr=3cr)
 * - Subscription allowance tracking
 * - In-memory caching with periodic DB flush
 * - Credit balance management
 */

class BillingService {
    constructor() {
        // In-memory cache for user credit data
        this.creditCache = new Map();
        
        // Credit cost mapping
        this.CREDIT_COSTS = {
            '10min': 1,
            '1hour': 2, 
            '24hour': 3
        };
        
        // Subscription credit allowances
        this.PLAN_ALLOWANCES = {
            'premium': 3000,      // 3,000 credits/month
            'premium_plus': 15000  // 15,000 credits/month
        };
        
        // Cache flush interval (5 minutes)
        this.FLUSH_INTERVAL = 5 * 60 * 1000;
        
        // Start periodic cache flush
        this.startPeriodicFlush();
    }

    /**
     * Calculate credit cost for email creation
     * @param {string} duration - '10min', '1hour', or '24hour'
     * @returns {number} Credit cost
     */
    calculateCreditCost(duration) {
        return this.CREDIT_COSTS[duration] || 0;
    }

    /**
     * Get user's current credit information (cached)
     * @param {string} userId - User ID
     * @returns {Promise<Object>} Credit info with balance, allowance, etc.
     */
    async getUserCreditInfo(userId) {
        // Check cache first
        if (this.creditCache.has(userId)) {
            const cached = this.creditCache.get(userId);
            
            // Return cached data if fresh (< 5 minutes old)
            if (Date.now() - cached.lastUpdated < 5 * 60 * 1000) {
                return cached.data;
            }
        }

        // Fetch from database
        const creditInfo = await this.fetchUserCreditInfoFromDB(userId);
        
        // Cache the result
        this.creditCache.set(userId, {
            data: creditInfo,
            lastUpdated: Date.now(),
            dirty: false
        });

        return creditInfo;
    }

    /**
     * Fetch user credit info from database
     * @param {string} userId - User ID
     * @returns {Promise<Object>} Credit information
     */
    async fetchUserCreditInfoFromDB(userId) {
        const connection = await pool.getConnection();
        
        try {
            // Get user's credit balance and subscription info
            const [userRows] = await connection.execute(`
                SELECT 
                    u.credit_balance,
                    u.premium_tier,
                    s.id as subscription_id,
                    s.plan_type,
                    s.status as subscription_status,
                    s.monthly_credit_allowance,
                    s.current_period_start,
                    s.current_period_end
                FROM users u
                LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
                WHERE u.id = ?
            `, [userId]);

            if (userRows.length === 0) {
                throw new Error(`User ${userId} not found`);
            }

            const user = userRows[0];
            const currentMonth = new Date().getMonth() + 1;
            const currentYear = new Date().getFullYear();

            // Get current month's usage
            const [usageRows] = await connection.execute(`
                SELECT 
                    credits_consumed,
                    credits_from_subscription,
                    credits_from_topups,
                    monthly_allowance,
                    allowance_used
                FROM api_usage_monthly
                WHERE user_id = ? AND usage_month = ? AND usage_year = ?
            `, [userId, currentMonth, currentYear]);

            const monthlyUsage = usageRows[0] || {
                credits_consumed: 0,
                credits_from_subscription: 0,
                credits_from_topups: 0,
                monthly_allowance: user.monthly_credit_allowance || this.PLAN_ALLOWANCES[user.plan_type] || 0,
                allowance_used: 0
            };

            return {
                userId,
                creditBalance: user.credit_balance,
                premiumTier: user.premium_tier,
                subscription: {
                    id: user.subscription_id,
                    planType: user.plan_type,
                    status: user.subscription_status,
                    monthlyAllowance: user.monthly_credit_allowance || this.PLAN_ALLOWANCES[user.plan_type] || 0
                },
                monthlyUsage: {
                    creditsConsumed: monthlyUsage.credits_consumed,
                    creditsFromSubscription: monthlyUsage.credits_from_subscription,
                    creditsFromTopups: monthlyUsage.credits_from_topups,
                    monthlyAllowance: monthlyUsage.monthly_allowance,
                    allowanceUsed: monthlyUsage.allowance_used,
                    allowanceRemaining: Math.max(0, monthlyUsage.monthly_allowance - monthlyUsage.allowance_used)
                }
            };

        } finally {
            connection.release();
        }
    }

    /**
     * Check if user can afford the credit cost
     * @param {string} userId - User ID
     * @param {number} creditCost - Required credits
     * @returns {Promise<Object>} Can afford + payment breakdown
     */
    async canAffordCredits(userId, creditCost) {
        const creditInfo = await this.getUserCreditInfo(userId);
        
        const allowanceRemaining = creditInfo.monthlyUsage.allowanceRemaining;
        const creditBalance = creditInfo.creditBalance;
        
        // Try to use monthly allowance first, then credit balance
        const fromAllowance = Math.min(creditCost, allowanceRemaining);
        const fromBalance = Math.max(0, creditCost - fromAllowance);
        
        const canAfford = (fromAllowance + Math.min(fromBalance, creditBalance)) >= creditCost;
        
        return {
            canAfford,
            creditCost,
            paymentBreakdown: {
                fromAllowance,
                fromBalance,
                totalAvailable: allowanceRemaining + creditBalance
            },
            creditInfo
        };
    }

    /**
     * Charge credits for email creation
     * @param {string} userId - User ID
     * @param {string} duration - Email duration ('10min', '1hour', '24hour')
     * @returns {Promise<Object>} Charge result
     */
    async chargeCredits(userId, duration) {
        const creditCost = this.calculateCreditCost(duration);
        
        if (creditCost === 0) {
            throw new Error(`Invalid duration: ${duration}`);
        }

        const affordabilityCheck = await this.canAffordCredits(userId, creditCost);
        
        if (!affordabilityCheck.canAfford) {
            throw new Error('INSUFFICIENT_CREDITS', {
                required: creditCost,
                available: affordabilityCheck.paymentBreakdown.totalAvailable
            });
        }

        // Perform the charge
        const { fromAllowance, fromBalance } = affordabilityCheck.paymentBreakdown;
        
        // Update cache immediately
        await this.updateCreditCache(userId, {
            creditBalanceChange: -fromBalance,
            allowanceUsedChange: fromAllowance,
            creditsConsumedChange: creditCost,
            emailDuration: duration
        });

        return {
            success: true,
            creditCost,
            chargedFromAllowance: fromAllowance,
            chargedFromBalance: fromBalance,
            remainingBalance: affordabilityCheck.creditInfo.creditBalance - fromBalance,
            remainingAllowance: affordabilityCheck.creditInfo.monthlyUsage.allowanceRemaining - fromAllowance
        };
    }

    /**
     * Update credit cache with changes (marks as dirty for DB flush)
     * @param {string} userId - User ID
     * @param {Object} changes - Credit changes to apply
     */
    async updateCreditCache(userId, changes) {
        let cached = this.creditCache.get(userId);
        
        if (!cached) {
            // Load from DB if not cached
            const creditInfo = await this.fetchUserCreditInfoFromDB(userId);
            cached = {
                data: creditInfo,
                lastUpdated: Date.now(),
                dirty: false,
                pendingChanges: {}
            };
        }

        // Apply changes to cached data
        if (changes.creditBalanceChange) {
            cached.data.creditBalance += changes.creditBalanceChange;
            cached.pendingChanges.creditBalanceChange = (cached.pendingChanges.creditBalanceChange || 0) + changes.creditBalanceChange;
        }

        if (changes.allowanceUsedChange) {
            cached.data.monthlyUsage.allowanceUsed += changes.allowanceUsedChange;
            cached.data.monthlyUsage.allowanceRemaining -= changes.allowanceUsedChange;
            cached.pendingChanges.allowanceUsedChange = (cached.pendingChanges.allowanceUsedChange || 0) + changes.allowanceUsedChange;
        }

        if (changes.creditsConsumedChange) {
            cached.data.monthlyUsage.creditsConsumed += changes.creditsConsumedChange;
            cached.pendingChanges.creditsConsumedChange = (cached.pendingChanges.creditsConsumedChange || 0) + changes.creditsConsumedChange;
        }

        if (changes.emailDuration) {
            const durationField = `${changes.emailDuration}_count`;
            cached.pendingChanges.emailCounts = cached.pendingChanges.emailCounts || {};
            cached.pendingChanges.emailCounts[durationField] = (cached.pendingChanges.emailCounts[durationField] || 0) + 1;
        }

        // Mark as dirty and update timestamp
        cached.dirty = true;
        cached.lastUpdated = Date.now();
        
        this.creditCache.set(userId, cached);
    }

    /**
     * Add credits to user balance (from topups)
     * @param {string} userId - User ID
     * @param {number} credits - Credits to add
     * @param {string} source - Source of credits ('topup', 'refund', etc.)
     */
    async addCredits(userId, credits, source = 'topup') {
        await this.updateCreditCache(userId, {
            creditBalanceChange: credits
        });

        // Force immediate flush for credit additions
        await this.flushUserToDatabase(userId);
    }

    /**
     * Flush all dirty cache entries to database
     */
    async flushCacheToDatabase() {
        const flushPromises = [];
        
        for (const [userId, cached] of this.creditCache.entries()) {
            if (cached.dirty) {
                flushPromises.push(this.flushUserToDatabase(userId));
            }
        }

        if (flushPromises.length > 0) {
            console.log(`[BillingService] Flushing ${flushPromises.length} dirty cache entries to database`);
            await Promise.allSettled(flushPromises);
        }
    }

    /**
     * Flush specific user's cache to database
     * @param {string} userId - User ID to flush
     */
    async flushUserToDatabase(userId) {
        const cached = this.creditCache.get(userId);
        
        if (!cached || !cached.dirty) {
            return;
        }

        const connection = await pool.getConnection();
        
        try {
            await connection.beginTransaction();

            // Update user's credit balance
            if (cached.pendingChanges.creditBalanceChange) {
                await connection.execute(`
                    UPDATE users 
                    SET credit_balance = credit_balance + ?
                    WHERE id = ?
                `, [cached.pendingChanges.creditBalanceChange, userId]);
            }

            // Update monthly usage
            if (cached.pendingChanges.allowanceUsedChange || cached.pendingChanges.creditsConsumedChange || cached.pendingChanges.emailCounts) {
                const currentMonth = new Date().getMonth() + 1;
                const currentYear = new Date().getFullYear();

                // Prepare update fields
                const updateFields = [];
                const updateValues = [];

                if (cached.pendingChanges.allowanceUsedChange) {
                    updateFields.push('allowance_used = allowance_used + ?');
                    updateFields.push('credits_from_subscription = credits_from_subscription + ?');
                    updateValues.push(cached.pendingChanges.allowanceUsedChange, cached.pendingChanges.allowanceUsedChange);
                }

                if (cached.pendingChanges.creditsConsumedChange) {
                    updateFields.push('credits_consumed = credits_consumed + ?');
                    updateValues.push(cached.pendingChanges.creditsConsumedChange);
                }

                if (cached.pendingChanges.emailCounts) {
                    for (const [durationField, count] of Object.entries(cached.pendingChanges.emailCounts)) {
                        const dbField = `emails_${durationField}`;
                        updateFields.push(`${dbField} = ${dbField} + ?`);
                        updateValues.push(count);
                    }
                }

                if (updateFields.length > 0) {
                    updateValues.push(userId, currentMonth, currentYear);
                    
                    // Upsert monthly usage record
                    await connection.execute(`
                        INSERT INTO api_usage_monthly (
                            user_id, usage_month, usage_year, 
                            monthly_allowance, allowance_reset_at
                        ) VALUES (?, ?, ?, ?, NOW())
                        ON DUPLICATE KEY UPDATE ${updateFields.join(', ')}
                    `, [userId, currentMonth, currentYear, cached.data.subscription.monthlyAllowance, ...updateValues]);
                }
            }

            await connection.commit();

            // Clear pending changes and mark as clean
            cached.pendingChanges = {};
            cached.dirty = false;

        } catch (error) {
            await connection.rollback();
            console.error(`[BillingService] Failed to flush user ${userId} to database:`, error);
            throw error;
        } finally {
            connection.release();
        }
    }

    /**
     * Start periodic cache flush
     */
    startPeriodicFlush() {
        setInterval(async () => {
            try {
                await this.flushCacheToDatabase();
            } catch (error) {
                console.error('[BillingService] Periodic flush failed:', error);
            }
        }, this.FLUSH_INTERVAL);

        console.log(`[BillingService] Started periodic cache flush every ${this.FLUSH_INTERVAL / 1000}s`);
    }

    /**
     * Get billing statistics for admin/monitoring
     * @returns {Object} Cache and billing stats
     */
    getStats() {
        const totalCached = this.creditCache.size;
        const dirtyCached = Array.from(this.creditCache.values()).filter(c => c.dirty).length;
        
        return {
            totalCachedUsers: totalCached,
            dirtyCachedUsers: dirtyCached,
            cacheHitRate: totalCached > 0 ? ((totalCached - dirtyCached) / totalCached * 100).toFixed(2) + '%' : '0%',
            flushInterval: this.FLUSH_INTERVAL / 1000 + 's'
        };
    }
}

// Export singleton instance
export default new BillingService(); 
