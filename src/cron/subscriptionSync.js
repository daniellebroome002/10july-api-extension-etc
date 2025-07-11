import cron from 'node-cron';
import { pool } from '../db/init.js';
import billingService from '../services/billing.js';
import paddleApi from '../services/paddleApi.js';

/**
 * Subscription Synchronization Cron Job
 * 
 * Features:
 * - Hourly reconciliation with Paddle API
 * - Monthly allowance reset on billing cycle
 * - Cleanup of expired data
 * - Health monitoring and alerts
 */

/**
 * Sync subscription status with Paddle API
 * This would normally call Paddle's API to get current subscription status
 */
async function syncSubscriptionsWithPaddle() {
  const connection = await pool.getConnection();
  
  try {
    console.log('[SubscriptionSync] Starting subscription sync with Paddle...');
    
    // Get all active subscriptions that need checking
    const [subscriptions] = await connection.execute(`
      SELECT id, user_id, paddle_customer_id, status, next_billed_at
      FROM subscriptions 
      WHERE status IN ('active', 'past_due') 
      AND next_billed_at IS NOT NULL
      ORDER BY next_billed_at ASC
      LIMIT 100
    `);
    
    console.log(`[SubscriptionSync] Found ${subscriptions.length} subscriptions to check`);
    
    let syncedCount = 0;
    let errorCount = 0;
    
    for (const subscription of subscriptions) {
      try {
        // Retrieve current status from Paddle
        const paddleSub = await paddleApi.getSubscription(subscription.id);
        const paddleStatus = paddleSub.status || paddleSub.data?.status;

        if (paddleStatus && paddleStatus !== subscription.status) {
          await connection.execute(`
            UPDATE subscriptions 
            SET status = ?, updated_at = NOW()
            WHERE id = ?
          `, [paddleStatus, subscription.id]);
          console.log(`[SubscriptionSync] Updated subscription ${subscription.id}: ${subscription.status} -> ${paddleStatus}`);
        }
        
        syncedCount++;
        
      } catch (error) {
        console.error(`[SubscriptionSync] Failed to sync subscription ${subscription.id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`[SubscriptionSync] Sync completed: ${syncedCount} synced, ${errorCount} errors`);
    
  } catch (error) {
    console.error('[SubscriptionSync] Failed to sync subscriptions:', error);
  } finally {
    connection.release();
  }
}

/**
 * Reset monthly allowances for subscriptions on their billing cycle
 */
async function resetMonthlyAllowances() {
  const connection = await pool.getConnection();
  
  try {
    console.log('[SubscriptionSync] Checking for monthly allowance resets...');
    
    // Find subscriptions where current period has started recently (within last hour)
    // This catches subscriptions that renewed in the last hour
    const [subscriptions] = await connection.execute(`
      SELECT s.id, s.user_id, s.monthly_credit_allowance, s.current_period_start
      FROM subscriptions s
      WHERE s.status = 'active'
      AND s.current_period_start > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      AND s.current_period_start <= NOW()
    `);
    
    console.log(`[SubscriptionSync] Found ${subscriptions.length} subscriptions needing allowance reset`);
    
    for (const subscription of subscriptions) {
      try {
        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();
        
        // Reset the monthly usage record
        await connection.execute(`
          INSERT INTO api_usage_monthly (
            user_id, usage_month, usage_year, monthly_allowance,
            allowance_used, allowance_reset_at
          ) VALUES (?, ?, ?, ?, 0, NOW())
          ON DUPLICATE KEY UPDATE 
            allowance_used = 0,
            allowance_reset_at = NOW()
        `, [
          subscription.user_id,
          currentMonth,
          currentYear,
          subscription.monthly_credit_allowance
        ]);
        
        console.log(`[SubscriptionSync] Reset allowance for user ${subscription.user_id}: ${subscription.monthly_credit_allowance} credits`);
        
      } catch (error) {
        console.error(`[SubscriptionSync] Failed to reset allowance for subscription ${subscription.id}:`, error);
      }
    }
    
  } catch (error) {
    console.error('[SubscriptionSync] Failed to reset monthly allowances:', error);
  } finally {
    connection.release();
  }
}

/**
 * Clean up expired subscriptions and old data
 */
async function cleanupExpiredData() {
  const connection = await pool.getConnection();
  
  try {
    console.log('[SubscriptionSync] Starting cleanup of expired data...');
    
    // Mark subscriptions as expired if they're past due and haven't been billed
    const [expiredResult] = await connection.execute(`
      UPDATE subscriptions 
      SET status = 'canceled', canceled_at = NOW()
      WHERE status = 'past_due' 
      AND next_billed_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);
    
    if (expiredResult.affectedRows > 0) {
      console.log(`[SubscriptionSync] Marked ${expiredResult.affectedRows} past due subscriptions as canceled`);
    }
    
    // Clean up old usage records (older than 12 months)
    const [usageResult] = await connection.execute(`
      DELETE FROM api_usage_monthly 
      WHERE (usage_year < YEAR(NOW()) - 1) 
      OR (usage_year = YEAR(NOW()) - 1 AND usage_month < MONTH(NOW()))
    `);
    
    if (usageResult.affectedRows > 0) {
      console.log(`[SubscriptionSync] Cleaned up ${usageResult.affectedRows} old usage records`);
    }
    
    // Clean up old credit topup records (older than 2 years, keep for tax records)
    const [topupResult] = await connection.execute(`
      DELETE FROM credit_topups 
      WHERE completed_at < DATE_SUB(NOW(), INTERVAL 2 YEAR)
      AND payment_status = 'completed'
    `);
    
    if (topupResult.affectedRows > 0) {
      console.log(`[SubscriptionSync] Cleaned up ${topupResult.affectedRows} old credit topup records`);
    }
    
  } catch (error) {
    console.error('[SubscriptionSync] Failed to cleanup expired data:', error);
  } finally {
    connection.release();
  }
}

/**
 * Flush billing service cache to ensure data consistency
 */
async function flushBillingCache() {
  try {
    console.log('[SubscriptionSync] Flushing billing service cache...');
    await billingService.flushCacheToDatabase();
    
    const stats = billingService.getStats();
    console.log(`[SubscriptionSync] Cache stats: ${stats.totalCachedUsers} users, ${stats.dirtyCachedUsers} dirty`);
    
  } catch (error) {
    console.error('[SubscriptionSync] Failed to flush billing cache:', error);
  }
}

/**
 * Generate health report for monitoring
 */
async function generateHealthReport() {
  const connection = await pool.getConnection();
  
  try {
    // Get subscription statistics
    const [subStats] = await connection.execute(`
      SELECT 
        status,
        COUNT(*) as count
      FROM subscriptions 
      GROUP BY status
    `);
    
    // Get credit usage statistics for current month
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    
    const [usageStats] = await connection.execute(`
      SELECT 
        COUNT(*) as active_users,
        SUM(credits_consumed) as total_credits_consumed,
        SUM(monthly_allowance) as total_allowance,
        AVG(credits_consumed) as avg_credits_per_user
      FROM api_usage_monthly 
      WHERE usage_month = ? AND usage_year = ?
    `, [currentMonth, currentYear]);
    
    // Get billing service stats
    const billingStats = billingService.getStats();
    
    const healthReport = {
      timestamp: new Date().toISOString(),
      subscriptions: subStats.reduce((acc, stat) => {
        acc[stat.status] = stat.count;
        return acc;
      }, {}),
      usage: usageStats[0] || {},
      billing: billingStats
    };
    
    console.log('[SubscriptionSync] Health Report:', JSON.stringify(healthReport, null, 2));
    
    // You could send this to a monitoring service or store it
    
  } catch (error) {
    console.error('[SubscriptionSync] Failed to generate health report:', error);
  } finally {
    connection.release();
  }
}

/**
 * Main sync function that runs all tasks
 */
async function runFullSync() {
  const startTime = Date.now();
  console.log('[SubscriptionSync] === Starting full synchronization ===');
  
  try {
    // Run all sync tasks
    await syncSubscriptionsWithPaddle();
    await resetMonthlyAllowances();
    await cleanupExpiredData();
    await flushBillingCache();
    await generateHealthReport();
    
    const duration = Date.now() - startTime;
    console.log(`[SubscriptionSync] === Full sync completed in ${duration}ms ===`);
    
  } catch (error) {
    console.error('[SubscriptionSync] Full sync failed:', error);
  }
}

/**
 * Initialize cron jobs
 */
function initializeSubscriptionSync() {
  console.log('[SubscriptionSync] Initializing subscription sync cron jobs...');
  
  // Run full sync every hour at minute 0
  cron.schedule('0 * * * *', () => {
    console.log('[SubscriptionSync] Hourly sync triggered');
    runFullSync();
  }, {
    scheduled: true,
    timezone: "UTC"
  });
  
  // Run cache flush every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    console.log('[SubscriptionSync] Cache flush triggered');
    flushBillingCache();
  }, {
    scheduled: true,
    timezone: "UTC"
  });
  
  // Run health report every 6 hours
  cron.schedule('0 */6 * * *', () => {
    console.log('[SubscriptionSync] Health report triggered');
    generateHealthReport();
  }, {
    scheduled: true,
    timezone: "UTC"
  });
  
  console.log('[SubscriptionSync] Cron jobs scheduled:');
  console.log('  - Full sync: Every hour at minute 0');
  console.log('  - Cache flush: Every 15 minutes');
  console.log('  - Health report: Every 6 hours');
  
  // Run initial sync after 30 seconds
  setTimeout(() => {
    console.log('[SubscriptionSync] Running initial sync...');
    runFullSync();
  }, 30000);
}

// Export functions for manual execution or testing
export {
  initializeSubscriptionSync,
  runFullSync,
  syncSubscriptionsWithPaddle,
  resetMonthlyAllowances,
  cleanupExpiredData,
  flushBillingCache,
  generateHealthReport
}; 
