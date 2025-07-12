// subscriptionSync.js - Hourly Paddle Subscription Synchronization
import { pool } from '../db/init.js';
import { paddle, resetMonthlyAllowances } from '../services/billing.js';

/**
 * Sync subscriptions with Paddle API
 * Called hourly to ensure local state matches Paddle state
 */
export async function syncSubscriptionsWithPaddle() {
  console.log('Starting subscription sync with Paddle...');
  
  try {
    // Get all active subscriptions from local database
    const [localSubscriptions] = await pool.query(
      'SELECT id, user_id, status, updated_at FROM subscriptions WHERE status IN (?, ?, ?)',
      ['active', 'trialing', 'past_due']
    );
    
    let syncedCount = 0;
    let errorCount = 0;
    
    for (const localSub of localSubscriptions) {
      try {
        // Fetch subscription from Paddle
        const paddleSubscription = await paddle.subscriptions.get(localSub.id);
        const paddleData = paddleSubscription.data;
        
        // Check if status has changed
        if (paddleData.status !== localSub.status) {
          console.log(`Subscription ${localSub.id} status changed: ${localSub.status} -> ${paddleData.status}`);
          
          // Update local subscription
          await pool.query(`
            UPDATE subscriptions 
            SET status = ?, current_period_start = ?, current_period_end = ?, 
                next_billed_at = ?, updated_at = NOW()
            WHERE id = ?
          `, [
            paddleData.status,
            paddleData.current_billing_period?.starts_at,
            paddleData.current_billing_period?.ends_at,
            paddleData.next_billed_at,
            localSub.id
          ]);
          
          // Update user's premium tier if subscription is canceled
          if (paddleData.status === 'canceled') {
            await pool.query(
              'UPDATE users SET premium_tier = ? WHERE id = ?',
              ['free', localSub.user_id]
            );
          }
        }
        
        syncedCount++;
        
      } catch (error) {
        console.error(`Failed to sync subscription ${localSub.id}:`, error);
        errorCount++;
        
        // If subscription not found in Paddle, mark as canceled
        if (error.response?.status === 404) {
          console.log(`Subscription ${localSub.id} not found in Paddle, marking as canceled`);
          
          await pool.query(
            'UPDATE subscriptions SET status = ?, canceled_at = NOW() WHERE id = ?',
            ['canceled', localSub.id]
          );
          
          await pool.query(
            'UPDATE users SET premium_tier = ? WHERE id = ?',
            ['free', localSub.user_id]
          );
        }
      }
      
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`Subscription sync completed: ${syncedCount} synced, ${errorCount} errors`);
    
  } catch (error) {
    console.error('Failed to sync subscriptions:', error);
    throw error;
  }
}

/**
 * Check for expired subscriptions and downgrade users
 */
export async function downgradeExpiredSubscriptions() {
  console.log('Checking for expired subscriptions...');
  
  try {
    // Find subscriptions that should be expired
    const [expiredSubs] = await pool.query(`
      SELECT id, user_id, status, current_period_end 
      FROM subscriptions 
      WHERE status IN ('active', 'trialing') 
      AND current_period_end < NOW()
    `);
    
    for (const subscription of expiredSubs) {
      console.log(`Downgrading expired subscription: ${subscription.id}`);
      
      // Update subscription status
      await pool.query(
        'UPDATE subscriptions SET status = ?, canceled_at = NOW() WHERE id = ?',
        ['canceled', subscription.id]
      );
      
      // Downgrade user to free tier
      await pool.query(
        'UPDATE users SET premium_tier = ? WHERE id = ?',
        ['free', subscription.user_id]
      );
    }
    
    console.log(`Downgraded ${expiredSubs.length} expired subscriptions`);
    
  } catch (error) {
    console.error('Failed to downgrade expired subscriptions:', error);
    throw error;
  }
}

/**
 * Clean up old usage data (keep last 12 months)
 */
export async function cleanupOldUsageData() {
  console.log('Cleaning up old usage data...');
  
  try {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 12);
    
    const [result] = await pool.query(`
      DELETE FROM api_usage_monthly 
      WHERE created_at < ?
    `, [cutoffDate]);
    
    console.log(`Cleaned up ${result.affectedRows} old usage records`);
    
  } catch (error) {
    console.error('Failed to cleanup old usage data:', error);
    throw error;
  }
}

/**
 * Monthly reset of allowances (runs on 1st of each month)
 */
export async function monthlyAllowanceReset() {
  const now = new Date();
  const dayOfMonth = now.getDate();
  
  // Only run on the 1st of the month
  if (dayOfMonth === 1) {
    console.log('Running monthly allowance reset...');
    
    try {
      await resetMonthlyAllowances();
      console.log('Monthly allowance reset completed');
    } catch (error) {
      console.error('Failed to reset monthly allowances:', error);
      throw error;
    }
  }
}

/**
 * Main sync function that runs all synchronization tasks
 */
export async function runSubscriptionSync() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting subscription sync tasks...`);
  
  try {
    // Run sync tasks in sequence
    await syncSubscriptionsWithPaddle();
    await downgradeExpiredSubscriptions();
    await monthlyAllowanceReset();
    
    // Clean up old data once per day (at midnight)
    const hour = new Date().getHours();
    if (hour === 0) {
      await cleanupOldUsageData();
    }
    
    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Subscription sync completed in ${duration}ms`);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Subscription sync failed:`, error);
    
    // Don't throw error to prevent cron from stopping
    // Log error for monitoring systems to pick up
  }
}

/**
 * Initialize subscription sync cron job
 * Runs every hour at minute 0
 */
export function initializeSubscriptionSync() {
  console.log('Initializing subscription sync cron job...');
  
  // Calculate time until next hour
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  const delayUntilNextHour = nextHour.getTime() - now.getTime();
  
  // Schedule first run at the top of the next hour
  setTimeout(() => {
    runSubscriptionSync();
    
    // Then run every hour
    setInterval(runSubscriptionSync, 60 * 60 * 1000); // 1 hour
    
  }, delayUntilNextHour);
  
  console.log(`Subscription sync scheduled. First run in ${Math.round(delayUntilNextHour / 1000)} seconds`);
}

/**
 * Manual sync trigger for testing/debugging
 */
export async function triggerManualSync() {
  console.log('Manual subscription sync triggered');
  await runSubscriptionSync();
} 