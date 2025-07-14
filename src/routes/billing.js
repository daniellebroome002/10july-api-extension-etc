import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import nowPaymentsService from '../services/billing/nowPaymentsService.js';
import creditManager from '../services/billing/creditManager.js';
import usageTracker from '../services/billing/usageTracker.js';
import { pool } from '../db/init.js';

const router = express.Router();

// ==================== SUBSCRIPTION PLANS CONFIGURATION ====================

const SUBSCRIPTION_PLANS = {
  premium: {
    title: "Boomlify Premium",
    amount: 9,
    currency: "usd",
    interval_day: 30,
    credits_included: 3000,
    plan_id: process.env.NOWPAYMENTS_PREMIUM_PLAN_ID
  },
  premium_plus: {
    title: "Boomlify Premium Plus", 
    amount: 29,
    currency: "usd",
    interval_day: 30,
    credits_included: 15000,
    plan_id: process.env.NOWPAYMENTS_PREMIUM_PLUS_PLAN_ID
  }
};

const CREDIT_PACKS = {
  credit_1k: { 
    amount: 1, 
    currency: "usd", 
    credits: 1000,
    title: "1,000 Credits"
  },
  credit_5k: { 
    amount: 4.5, 
    currency: "usd", 
    credits: 5000,
    title: "5,000 Credits"
  },
  credit_20k: { 
    amount: 16, 
    currency: "usd", 
    credits: 20000,
    title: "20,000 Credits"
  }
};

// ==================== SUBSCRIPTION CHECKOUT ====================

/**
 * Create subscription checkout
 */
router.post('/checkout/subscription/:plan', authenticateToken, async (req, res) => {
  try {
    const { plan } = req.params;
    const userId = req.user.id;
    const userEmail = req.user.email;
    
    // Validate plan
    if (!SUBSCRIPTION_PLANS[plan]) {
      return res.status(400).json({
        error: 'Invalid subscription plan',
        availablePlans: Object.keys(SUBSCRIPTION_PLANS)
      });
    }
    
    const planConfig = SUBSCRIPTION_PLANS[plan];
    
    // Check if user already has an active subscription
    const existingSubscription = await getUserActiveSubscription(userId);
    if (existingSubscription && existingSubscription.status === 'active') {
      return res.status(409).json({
        error: 'User already has an active subscription',
        currentPlan: existingSubscription.plan_type,
        nextBilling: existingSubscription.next_billing_date
      });
    }
    
    // Create subscription through NOWPayments
    const subscription = await nowPaymentsService.createSubscription(
      userId,
      planConfig.plan_id,
      userEmail
    );
    
    // Store pending subscription in database
    await storePendingSubscription(userId, plan, subscription, planConfig);
    
    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        payment_url: subscription.payment_url,
        plan: plan,
        amount: planConfig.amount,
        currency: planConfig.currency,
        credits_included: planConfig.credits_included
      }
    });
    
  } catch (error) {
    console.error('Subscription checkout error:', error);
    res.status(500).json({
      error: 'Failed to create subscription checkout',
      message: error.message
    });
  }
});

/**
 * Cancel subscription
 */
router.post('/subscription/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get active subscription
    const subscription = await getUserActiveSubscription(userId);
    if (!subscription) {
      return res.status(404).json({
        error: 'No active subscription found'
      });
    }
    
    // Cancel through NOWPayments
    await nowPaymentsService.cancelSubscription(subscription.id);
    
    // Update status in database
    await pool.execute(
      'UPDATE nowpayments_subscriptions SET status = ?, updated_at = NOW() WHERE id = ?',
      ['cancelled', subscription.id]
    );
    
    // Clear subscription cache
    creditManager.subscriptionCache.del(`subscription_${userId}`);
    
    res.json({
      success: true,
      message: 'Subscription cancelled successfully',
      subscription: {
        id: subscription.id,
        plan: subscription.plan_type,
        cancelledAt: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Subscription cancellation error:', error);
    res.status(500).json({
      error: 'Failed to cancel subscription',
      message: error.message
    });
  }
});

// ==================== CREDIT PACK CHECKOUT ====================

/**
 * Create credit pack checkout
 */
router.post('/checkout/credits/:pack', authenticateToken, async (req, res) => {
  try {
    const { pack } = req.params;
    const userId = req.user.id;
    
    // Validate credit pack
    if (!CREDIT_PACKS[pack]) {
      return res.status(400).json({
        error: 'Invalid credit pack',
        availablePacks: Object.keys(CREDIT_PACKS)
      });
    }
    
    const packConfig = CREDIT_PACKS[pack];
    
    // Create payment through NOWPayments
    const payment = await nowPaymentsService.createPayment({
      userId,
      amount: packConfig.amount,
      currency: packConfig.currency,
      credits: packConfig.credits
    });
    
    // Store pending credit purchase in database
    await storePendingCreditPurchase(userId, payment, packConfig);
    
    res.json({
      success: true,
      payment: {
        id: payment.payment_id,
        order_id: payment.order_id,
        payment_url: payment.payment_url,
        pack: pack,
        amount: packConfig.amount,
        currency: packConfig.currency,
        credits: packConfig.credits
      }
    });
    
  } catch (error) {
    console.error('Credit checkout error:', error);
    res.status(500).json({
      error: 'Failed to create credit checkout',
      message: error.message
    });
  }
});

// ==================== BILLING STATUS ====================

/**
 * Get billing status
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get subscription status
    const subscription = await creditManager.getUserSubscription(userId);
    
    // Get credit balance
    const creditBalance = await creditManager.getBalance(userId);
    
    // Get monthly usage
    const monthYear = new Date().toISOString().slice(0, 7);
    const monthlyUsage = await creditManager.getMonthlyUsage(userId, monthYear);
    
    // Get usage analytics
    const usageAnalytics = await usageTracker.getUsageAnalytics(userId, 7);
    
    // Get current usage stats
    const currentUsage = usageTracker.getUserUsageStats(userId);
    
    res.json({
      success: true,
      billing: {
        subscription: {
          tier: subscription.tier,
          status: subscription.status,
          monthlyCredits: subscription.monthlyCredits,
          nextBilling: subscription.nextBilling
        },
        credits: {
          balance: creditBalance,
          monthlyUsage: {
            included: monthlyUsage.creditsUsedIncluded,
            purchased: monthlyUsage.creditsUsedPurchased,
            total: monthlyUsage.creditsUsedIncluded + monthlyUsage.creditsUsedPurchased,
            allowance: monthlyUsage.subscriptionAllowance,
            remaining: Math.max(0, monthlyUsage.subscriptionAllowance - monthlyUsage.creditsUsedIncluded)
          }
        },
        usage: {
          today: currentUsage.today,
          analytics: usageAnalytics,
          rateLimits: currentUsage.rateLimits
        }
      }
    });
    
  } catch (error) {
    console.error('Billing status error:', error);
    res.status(500).json({
      error: 'Failed to get billing status',
      message: error.message
    });
  }
});

/**
 * GET /billing/plans
 * Get available subscription plans (using local definitions)
 */
router.get('/plans', authenticateToken, async (req, res) => {
  try {
    // Get plans from the service (local definitions, no API call needed)
    const subscriptionPlans = nowPaymentsService.getAvailablePlans();
    
    res.json({
      success: true,
      subscriptions: subscriptionPlans.map(plan => ({
        id: plan.id,
        name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        credits: plan.credits,
        description: plan.description,
        interval: plan.interval
      })),
      creditPacks: CREDIT_PACKS
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch plans'
    });
  }
});

// ==================== PURCHASE HISTORY ====================

/**
 * Get purchase history
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Ensure limit and offset are valid integers
    let limit = parseInt(req.query.limit);
    let offset = parseInt(req.query.offset);
    
    // Set defaults and validate
    if (isNaN(limit) || limit < 1 || limit > 100) {
      limit = 50;
    }
    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }
    
    // Get credit purchases - using string interpolation for LIMIT/OFFSET to avoid SQL parameter issues
    const [creditPurchases] = await pool.execute(`
      SELECT 
        id,
        credits_purchased,
        amount_usd,
        status,
        completed_at,
        created_at
      FROM credit_purchases 
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [userId]);
    
    // Get subscription history
    const [subscriptions] = await pool.execute(`
      SELECT 
        id,
        plan_type,
        monthly_credits,
        price_amount,
        status,
        created_at,
        next_billing_date
      FROM nowpayments_subscriptions 
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [userId]);
    
    res.json({
      success: true,
      history: {
        creditPurchases: creditPurchases.map(purchase => ({
          id: purchase.id,
          type: 'credit_purchase',
          credits: purchase.credits_purchased,
          amount: purchase.amount_usd,
          currency: 'USD',
          status: purchase.status,
          completedAt: purchase.completed_at,
          createdAt: purchase.created_at
        })),
        subscriptions: subscriptions.map(sub => ({
          id: sub.id,
          type: 'subscription',
          plan: sub.plan_type,
          monthlyCredits: sub.monthly_credits,
          amount: sub.price_amount,
          currency: 'USD',
          status: sub.status,
          nextBilling: sub.next_billing_date,
          createdAt: sub.created_at
        }))
      }
    });
    
  } catch (error) {
    console.error('Purchase history error:', error);
    res.status(500).json({
      error: 'Failed to get purchase history',
      message: error.message
    });
  }
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Get user's active subscription
 */
async function getUserActiveSubscription(userId) {
  try {
    const [rows] = await pool.execute(`
      SELECT id, plan_type, status, next_billing_date
      FROM nowpayments_subscriptions 
      WHERE user_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId]);
    
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting active subscription:', error);
    return null;
  }
}

/**
 * Store pending subscription in database
 */
async function storePendingSubscription(userId, planType, subscription, planConfig) {
  try {
    await pool.execute(`
      INSERT INTO nowpayments_subscriptions (
        id, user_id, plan_id, plan_type, status,
        customer_email, price_amount, price_currency,
        monthly_credits, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      subscription.id,
      userId,
      planConfig.plan_id,
      planType,
      'pending',
      subscription.customer_email || '',
      planConfig.amount,
      planConfig.currency,
      planConfig.credits_included
    ]);
  } catch (error) {
    console.error('Error storing pending subscription:', error);
    throw error;
  }
}

/**
 * Store pending credit purchase in database
 */
async function storePendingCreditPurchase(userId, payment, packConfig) {
  try {
    await pool.execute(`
      INSERT INTO credit_purchases (
        id, user_id, nowpayments_payment_id, order_id,
        credits_purchased, amount_usd, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      payment.order_id, // Use order_id as our internal ID
      userId,
      payment.payment_id,
      payment.order_id,
      packConfig.credits,
      packConfig.amount,
      'pending'
    ]);
  } catch (error) {
    console.error('Error storing pending credit purchase:', error);
    throw error;
  }
}

export default router; 
