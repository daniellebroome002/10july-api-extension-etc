// billing.js - Credit Accounting System with In-Memory Caching
import { pool } from '../db/init.js';

// Initialize Paddle client with error handling
let paddle = null;

/**
 * Initialize Paddle client
 */
async function initializePaddle() {
  try {
    const { Paddle, Environment } = await import('@paddle/paddle-node-sdk');
    
    if (!process.env.PADDLE_API_KEY) {
      console.warn('PADDLE_API_KEY not found in environment variables. Billing features will be disabled.');
      return;
    }
    
    const environment = process.env.PADDLE_SANDBOX === 'true' ? Environment.sandbox : Environment.production;
    
    paddle = new Paddle(process.env.PADDLE_API_KEY, {
      environment: environment
    });
    
    console.log(`Paddle client initialized successfully in ${environment} mode`);
  } catch (error) {
    console.error('Failed to initialize Paddle client:', error);
    console.warn('Billing features will be disabled. Please check Paddle SDK installation and configuration.');
  }
}

// Validate required environment variables
const requiredEnvVars = {
  'PADDLE_API_KEY': 'Your Paddle API key for server-side operations',
  'PADDLE_SANDBOX': 'Set to "true" for sandbox environment, "false" for production',
  'FRONTEND_URL': 'Your frontend URL for return redirects',
  'PADDLE_PREMIUM_PLAN_ID': 'Price ID for Premium plan',
  'PADDLE_PREMIUM_PLUS_PLAN_ID': 'Price ID for Premium Plus plan',
  'PADDLE_CREDITS_1K_PRODUCT_ID': 'Product ID for 1k credits package',
  'PADDLE_CREDITS_5K_PRODUCT_ID': 'Product ID for 5k credits package',
  'PADDLE_CREDITS_20K_PRODUCT_ID': 'Product ID for 20k credits package'
};

function validateEnvironmentVariables() {
  const missing = [];
  const warnings = [];
  
  for (const [key, description] of Object.entries(requiredEnvVars)) {
    if (!process.env[key]) {
      if (key === 'PADDLE_API_KEY') {
        missing.push(`${key}: ${description}`);
      } else {
        warnings.push(`${key}: ${description}`);
      }
    }
  }
  
  if (missing.length > 0) {
    console.error('❌ CRITICAL: Missing required environment variables:');
    missing.forEach(msg => console.error(`   - ${msg}`));
    console.error('   Billing features will be completely disabled.');
  }
  
  if (warnings.length > 0) {
    console.warn('⚠️  WARNING: Missing optional environment variables:');
    warnings.forEach(msg => console.warn(`   - ${msg}`));
    console.warn('   Some billing features may not work correctly.');
  }
  
  return missing.length === 0;
}

// Initialize Paddle on module load
validateEnvironmentVariables();
initializePaddle();

/**
 * Ensure Paddle is initialized
 */
async function ensurePaddleInitialized() {
  if (!paddle) {
    console.log('Paddle not initialized, attempting to initialize...');
    await initializePaddle();
  }
  return paddle !== null;
}

// In-memory credit wallet cache
const creditWalletCache = new Map(); // { userId: { balance, lastSync, dirty } }

// Monthly allowance cache
const monthlyAllowanceCache = new Map(); // { userId-ym: { used, limit, subscription } }

// Configuration constants
const CACHE_FLUSH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CRITICAL_BALANCE_THRESHOLD = 100; // Write-through threshold
const PROBABILISTIC_FLUSH_CHANCE = 0.05; // 5% chance on any operation

// Credit costs by time tier
const CREDIT_COSTS = {
  '10min': 1,
  '1hour': 2,
  '1day': 3
};

// Plan configurations
const PLAN_CONFIGS = {
  'free': {
    monthlyAllowance: 0,
    rolloverMonths: 0,
    rpmLimit: 60
  },
  'premium': {
    monthlyAllowance: 3000,
    rolloverMonths: 0,
    rpmLimit: 120
  },
  'premium_plus': {
    monthlyAllowance: 15000,
    rolloverMonths: 3,
    rpmLimit: 1000
  }
};

/**
 * Initialize credit balance for a user in cache
 */
async function initializeUserCache(userId) {
  try {
    const [users] = await pool.query(
      'SELECT credit_balance, premium_tier FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0) {
      throw new Error('User not found');
    }
    
    const user = users[0];
    const cacheEntry = {
      balance: user.credit_balance || 0,
      lastSync: Date.now(),
      dirty: false
    };
    
    creditWalletCache.set(userId, cacheEntry);
    console.log(`Initialized credit cache for user ${userId}: ${cacheEntry.balance} credits`);
    
    return cacheEntry;
  } catch (error) {
    console.error('Failed to initialize user cache:', error);
    throw error;
  }
}

/**
 * Get user's credit balance (cache-first)
 */
export async function getCreditBalance(userId) {
  let cached = creditWalletCache.get(userId);
  
  if (!cached) {
    cached = await initializeUserCache(userId);
  }
  
  return cached.balance;
}

/**
 * Get user's monthly allowance info
 */
export async function getMonthlyAllowance(userId) {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const cacheKey = `${userId}-${yearMonth}`;
  
  let cached = monthlyAllowanceCache.get(cacheKey);
  
  if (!cached) {
    // Load from database
    const [usage] = await pool.query(
      'SELECT * FROM api_usage_monthly WHERE user_id = ? AND usage_year = ? AND usage_month = ?',
      [userId, now.getFullYear(), now.getMonth() + 1]
    );
    
    // Get user's subscription info
    const [subscriptions] = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = ? AND status = ?',
      [userId, 'active']
    );
    
    const subscription = subscriptions[0];
    const planType = subscription?.plan_type || 'free';
    const monthlyLimit = PLAN_CONFIGS[planType]?.monthlyAllowance || 0;
    
    cached = {
      used: usage[0]?.allowance_used || 0,
      limit: monthlyLimit,
      subscription: subscription?.id || null
    };
    
    monthlyAllowanceCache.set(cacheKey, cached);
  }
  
  return cached;
}

/**
 * Charge credits from user's balance
 */
export async function chargeCredits(userId, timeTier, forceWriteThrough = false) {
  const cost = CREDIT_COSTS[timeTier];
  if (!cost) {
    throw new Error(`Invalid time tier: ${timeTier}`);
  }
  
  // First try to use monthly allowance
  const allowanceUsed = await chargeIncludedCredits(userId, cost);
  if (allowanceUsed) {
    return { success: true, source: 'monthly_allowance', cost };
  }
  
  // Fall back to charged credits
  let cached = creditWalletCache.get(userId);
  if (!cached) {
    cached = await initializeUserCache(userId);
  }
  
  if (cached.balance < cost) {
    throw new Error('Insufficient credits');
  }
  
  // Deduct from cache
  cached.balance -= cost;
  cached.dirty = true;
  cached.lastSync = Date.now();
  
  // Write-through for critical balance or forced flush
  if (cached.balance < CRITICAL_BALANCE_THRESHOLD || forceWriteThrough) {
    await flushUserToDatabase(userId);
  }
  
  // Probabilistic flush to prevent data loss
  if (Math.random() < PROBABILISTIC_FLUSH_CHANCE) {
    await flushUserToDatabase(userId);
  }
  
  console.log(`Charged ${cost} credits from user ${userId}, remaining: ${cached.balance}`);
  return { success: true, source: 'topup_credits', cost };
}

/**
 * Add credits to user's balance
 */
export async function addCredits(userId, amount, source = 'topup') {
  let cached = creditWalletCache.get(userId);
  if (!cached) {
    cached = await initializeUserCache(userId);
  }
  
  cached.balance += amount;
  cached.dirty = true;
  cached.lastSync = Date.now();
  
  // Always write-through for credit additions
  await flushUserToDatabase(userId);
  
  console.log(`Added ${amount} credits to user ${userId}, new balance: ${cached.balance}`);
  return cached.balance;
}

/**
 * Charge from monthly allowance if available
 */
export async function chargeIncludedCredits(userId, cost) {
  const allowanceInfo = await getMonthlyAllowance(userId);
  
  if (allowanceInfo.limit === 0 || allowanceInfo.used + cost > allowanceInfo.limit) {
    return false; // No allowance or insufficient
  }
  
  // Update monthly usage
  const now = new Date();
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Update or insert monthly usage
    await connection.query(`
      INSERT INTO api_usage_monthly 
      (user_id, usage_year, usage_month, allowance_used, monthly_allowance, subscription_id, credits_from_subscription)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
      allowance_used = allowance_used + ?,
      credits_from_subscription = credits_from_subscription + ?,
      updated_at = NOW()
    `, [
      userId, now.getFullYear(), now.getMonth() + 1, cost, allowanceInfo.limit, 
      allowanceInfo.subscription, cost, cost, cost
    ]);
    
    await connection.commit();
    
    // Update cache
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const cacheKey = `${userId}-${yearMonth}`;
    allowanceInfo.used += cost;
    monthlyAllowanceCache.set(cacheKey, allowanceInfo);
    
    console.log(`Used ${cost} credits from monthly allowance for user ${userId}`);
    return true;
  } catch (error) {
    await connection.rollback();
    console.error('Failed to charge included credits:', error);
    return false;
  } finally {
    connection.release();
  }
}

/**
 * Flush user's credit balance to database
 */
export async function flushUserToDatabase(userId) {
  const cached = creditWalletCache.get(userId);
  if (!cached || !cached.dirty) {
    return;
  }
  
  try {
    await pool.query(
      'UPDATE users SET credit_balance = ? WHERE id = ?',
      [cached.balance, userId]
    );
    
    cached.dirty = false;
    cached.lastSync = Date.now();
    
    console.log(`Flushed credit balance for user ${userId}: ${cached.balance} credits`);
  } catch (error) {
    console.error('Failed to flush user balance to database:', error);
    throw error;
  }
}

/**
 * Batch flush dirty entries to database
 */
export async function batchFlushToDatabase() {
  const dirtyEntries = Array.from(creditWalletCache.entries())
    .filter(([_, cached]) => cached.dirty)
    .slice(0, 50); // Limit batch size
  
  if (dirtyEntries.length === 0) {
    return;
  }
  
  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    // Build batch UPDATE with CASE statements
    const userIds = dirtyEntries.map(([userId]) => userId);
    const caseStatements = dirtyEntries.map(([userId, cached]) => 
      `WHEN '${userId}' THEN ${cached.balance}`
    ).join(' ');
    
    await connection.query(`
      UPDATE users 
      SET credit_balance = CASE id ${caseStatements} END
      WHERE id IN (${userIds.map(() => '?').join(',')})
    `, userIds);
    
    await connection.commit();
    
    // Mark as clean
    dirtyEntries.forEach(([userId, cached]) => {
      cached.dirty = false;
      cached.lastSync = Date.now();
    });
    
    console.log(`Batch flushed ${dirtyEntries.length} user balances to database`);
  } catch (error) {
    console.error('Failed to batch flush to database:', error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Get user's subscription info
 */
export async function getUserSubscription(userId) {
  try {
    const [subscriptions] = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = ? AND status IN (?, ?, ?)',
      [userId, 'active', 'trialing', 'past_due']
    );
    
    return subscriptions[0] || null;
  } catch (error) {
    console.error('Failed to get user subscription:', error);
    return null;
  }
}

/**
 * Create or update subscription
 */
export async function createOrUpdateSubscription(subscriptionData) {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Check if subscription already exists
    const [existing] = await connection.query(
      'SELECT id FROM subscriptions WHERE id = ?',
      [subscriptionData.id]
    );
    
    if (existing.length > 0) {
      // Update existing subscription
      await connection.query(`
        UPDATE subscriptions 
        SET status = ?, paddle_customer_id = ?, plan_type = ?, paddle_plan_id = ?,
            current_period_start = ?, current_period_end = ?, next_billed_at = ?,
            monthly_credit_allowance = ?, updated_at = NOW()
        WHERE id = ?
      `, [
        subscriptionData.status,
        subscriptionData.paddle_customer_id,
        subscriptionData.plan_type,
        subscriptionData.paddle_plan_id,
        subscriptionData.current_period_start,
        subscriptionData.current_period_end,
        subscriptionData.next_billed_at,
        subscriptionData.monthly_credit_allowance,
        subscriptionData.id
      ]);
    } else {
      // Create new subscription
      await connection.query(`
        INSERT INTO subscriptions 
        (id, user_id, paddle_customer_id, plan_type, status, paddle_plan_id, currency_code,
         billing_cycle, monthly_credit_allowance, started_at, current_period_start, 
         current_period_end, next_billed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        subscriptionData.id,
        subscriptionData.user_id,
        subscriptionData.paddle_customer_id,
        subscriptionData.plan_type,
        subscriptionData.status,
        subscriptionData.paddle_plan_id,
        subscriptionData.currency_code || 'USD',
        JSON.stringify(subscriptionData.billing_cycle),
        subscriptionData.monthly_credit_allowance,
        subscriptionData.started_at,
        subscriptionData.current_period_start,
        subscriptionData.current_period_end,
        subscriptionData.next_billed_at
      ]);
    }
    
    // Update user's premium tier
    await connection.query(
      'UPDATE users SET premium_tier = ? WHERE id = ?',
      [subscriptionData.plan_type, subscriptionData.user_id]
    );
    
    await connection.commit();
    
    console.log(`Created/updated subscription ${subscriptionData.id} for user ${subscriptionData.user_id}`);
    return subscriptionData;
  } catch (error) {
    await connection.rollback();
    console.error('Failed to create/update subscription:', error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Record credit topup
 */
export async function recordCreditTopup(topupData) {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Insert topup record
    await connection.query(`
      INSERT INTO credit_topups 
      (user_id, paddle_transaction_id, paddle_customer_id, paddle_product_id,
       credits_purchased, credits_applied, amount_paid, currency_code, 
       payment_status, purchased_at, completed_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      topupData.user_id,
      topupData.paddle_transaction_id,
      topupData.paddle_customer_id,
      topupData.paddle_product_id,
      topupData.credits_purchased,
      topupData.credits_applied,
      topupData.amount_paid,
      topupData.currency_code || 'USD',
      topupData.payment_status,
      topupData.purchased_at,
      topupData.completed_at,
      topupData.applied_at
    ]);
    
    // Add credits to user's balance
    if (topupData.credits_applied > 0) {
      await addCredits(topupData.user_id, topupData.credits_applied, 'topup');
    }
    
    await connection.commit();
    
    console.log(`Recorded credit topup: ${topupData.credits_applied} credits for user ${topupData.user_id}`);
    return topupData;
  } catch (error) {
    await connection.rollback();
    console.error('Failed to record credit topup:', error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Get Paddle checkout URL for subscription
 */
export async function createSubscriptionCheckout(userId, planId, customData = {}) {
  try {
    // Ensure Paddle is initialized
    const isPaddleReady = await ensurePaddleInitialized();
    if (!isPaddleReady) {
      throw new Error('Paddle payment system is not configured. Please contact support.');
    }
    
    // Get user info
    const [users] = await pool.query('SELECT email FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      throw new Error('User not found');
    }
    
    const user = users[0];
    
    // Create transaction with checkout
    const transactionData = {
      items: [{ priceId: planId, quantity: 1 }],
      customerEmail: user.email,
      customData: {
        userId: userId,
        ...customData
      },
      returnUrl: `${process.env.FRONTEND_URL}/billing?success=1`,
      billingDetails: {
        enableCheckout: true,
        collectAddresses: true
      }
    };
    
    const transaction = await paddle.transactions.create(transactionData);
    
    return {
      checkout_url: transaction.data.checkout.url,
      checkout_id: transaction.data.id
    };
  } catch (error) {
    console.error('Failed to create subscription checkout:', error);
    throw error;
  }
}

/**
 * Get Paddle checkout URL for credit topup
 */
export async function createCreditTopupCheckout(userId, productId, customData = {}) {
  try {
    // Ensure Paddle is initialized
    const isPaddleReady = await ensurePaddleInitialized();
    if (!isPaddleReady) {
      throw new Error('Paddle payment system is not configured. Please contact support.');
    }
    
    // Get user info
    const [users] = await pool.query('SELECT email FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      throw new Error('User not found');
    }
    
    const user = users[0];
    
    // Create transaction with checkout
    const transactionData = {
      items: [{ priceId: productId, quantity: 1 }],
      customerEmail: user.email,
      customData: {
        userId: userId,
        type: 'credit_topup',
        ...customData
      },
      returnUrl: `${process.env.FRONTEND_URL}/billing?topup=1`,
      billingDetails: {
        enableCheckout: true,
        collectAddresses: true
      }
    };
    
    const transaction = await paddle.transactions.create(transactionData);
    
    return {
      checkout_url: transaction.data.checkout.url,
      checkout_id: transaction.data.id
    };
  } catch (error) {
    console.error('Failed to create credit topup checkout:', error);
    throw error;
  }
}

/**
 * Reset monthly allowances (called by cron)
 */
export async function resetMonthlyAllowances() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  
  try {
    // Reset allowances for all active subscriptions
    const [subscriptions] = await pool.query(
      'SELECT user_id, monthly_credit_allowance FROM subscriptions WHERE status = ?',
      ['active']
    );
    
    for (const subscription of subscriptions) {
      await pool.query(`
        INSERT INTO api_usage_monthly 
        (user_id, usage_year, usage_month, monthly_allowance, allowance_used, credits_from_subscription)
        VALUES (?, ?, ?, ?, 0, 0)
        ON DUPLICATE KEY UPDATE
        monthly_allowance = ?,
        allowance_reset_at = NOW()
      `, [
        subscription.user_id, currentYear, currentMonth, subscription.monthly_credit_allowance,
        subscription.monthly_credit_allowance
      ]);
    }
    
    // Clear monthly allowance cache
    monthlyAllowanceCache.clear();
    
    console.log(`Reset monthly allowances for ${subscriptions.length} users`);
  } catch (error) {
    console.error('Failed to reset monthly allowances:', error);
    throw error;
  }
}

/**
 * Initialize periodic tasks
 */
export function initializeBillingTasks() {
  // Batch flush every 5 minutes
  setInterval(async () => {
    try {
      await batchFlushToDatabase();
    } catch (error) {
      console.error('Batch flush failed:', error);
    }
  }, CACHE_FLUSH_INTERVAL);
  
  // Cache cleanup every 30 minutes
  setInterval(() => {
    const now = Date.now();
    const oldThreshold = now - (30 * 60 * 1000); // 30 minutes
    
    for (const [userId, cached] of creditWalletCache.entries()) {
      if (cached.lastSync < oldThreshold && !cached.dirty) {
        creditWalletCache.delete(userId);
      }
    }
    
    console.log(`Credit cache cleanup: ${creditWalletCache.size} entries remaining`);
  }, 30 * 60 * 1000);
  
  console.log('Billing tasks initialized');
}

// Export Paddle client for direct use
export { paddle }; 
