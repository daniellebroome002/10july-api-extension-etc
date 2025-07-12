// billing.js - Billing and Subscription Management Routes
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { 
  createSubscriptionCheckout,
  createCreditTopupCheckout,
  getUserSubscription,
  getCreditBalance,
  getMonthlyAllowance,
  addCredits
} from '../services/billing.js';
import { pool } from '../db/init.js';

const router = express.Router();

/**
 * POST /billing/checkout/:plan
 * Create Paddle checkout URL for subscription
 */
router.post('/checkout/:plan', authenticateToken, async (req, res) => {
  try {
    const { plan } = req.params;
    const userId = req.user.id;
    
    // Validate plan
    const validPlans = ['premium', 'premium_plus'];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ 
        error: 'Invalid plan',
        message: 'Plan must be either "premium" or "premium_plus"'
      });
    }
    
    // Check if user already has an active subscription
    const existingSubscription = await getUserSubscription(userId);
    if (existingSubscription && existingSubscription.status === 'active') {
      return res.status(400).json({
        error: 'Active subscription exists',
        message: 'You already have an active subscription. Please cancel it first to change plans.'
      });
    }
    
    // Get plan ID from environment
    const planIds = {
      'premium': process.env.PADDLE_PREMIUM_PLAN_ID,
      'premium_plus': process.env.PADDLE_PREMIUM_PLUS_PLAN_ID
    };
    
    const planId = planIds[plan];
    if (!planId) {
      return res.status(500).json({
        error: 'Plan not configured',
        message: 'The requested plan is not properly configured'
      });
    }
    
    // Create checkout session
    const checkout = await createSubscriptionCheckout(userId, planId, { plan });
    
    res.json({
      success: true,
      checkout_url: checkout.checkoutUrl,
      checkout_id: checkout.checkoutId,
      plan,
      message: 'Checkout session created successfully'
    });
    
  } catch (error) {
    console.error('Failed to create subscription checkout:', error);
    res.status(500).json({
      error: 'Checkout creation failed',
      message: 'Failed to create checkout session'
    });
  }
});

/**
 * POST /billing/topup/:product
 * Create Paddle checkout URL for credit topup
 */
router.post('/topup/:product', authenticateToken, async (req, res) => {
  try {
    const { product } = req.params;
    const userId = req.user.id;
    
    // Validate product
    const validProducts = ['1k', '5k', '20k'];
    if (!validProducts.includes(product)) {
      return res.status(400).json({
        error: 'Invalid product',
        message: 'Product must be one of: 1k, 5k, 20k'
      });
    }
    
    // Get product ID from environment
    const productIds = {
      '1k': process.env.PADDLE_CREDITS_1K_PRODUCT_ID,
      '5k': process.env.PADDLE_CREDITS_5K_PRODUCT_ID,
      '20k': process.env.PADDLE_CREDITS_20K_PRODUCT_ID
    };
    
    const productId = productIds[product];
    if (!productId) {
      return res.status(500).json({
        error: 'Product not configured',
        message: 'The requested credit pack is not properly configured'
      });
    }
    
    // Create checkout session
    const checkout = await createCreditTopupCheckout(userId, productId, { product });
    
    // Credit amounts for display
    const creditAmounts = { '1k': 1000, '5k': 5000, '20k': 20000 };
    
    res.json({
      success: true,
      checkout_url: checkout.checkoutUrl,
      checkout_id: checkout.checkoutId,
      product,
      credits: creditAmounts[product],
      message: 'Credit topup checkout created successfully'
    });
    
  } catch (error) {
    console.error('Failed to create credit topup checkout:', error);
    res.status(500).json({
      error: 'Checkout creation failed',
      message: 'Failed to create credit topup checkout'
    });
  }
});

/**
 * GET /billing/status
 * Get current subscription status and credit balance
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user's subscription
    const subscription = await getUserSubscription(userId);
    
    // Get credit balance
    const creditBalance = await getCreditBalance(userId);
    
    // Get monthly allowance info
    const monthlyAllowance = await getMonthlyAllowance(userId);
    
    // Get recent credit topups
    const [topups] = await pool.query(`
      SELECT credits_purchased, amount_paid, currency_code, completed_at, payment_status
      FROM credit_topups 
      WHERE user_id = ? AND payment_status = 'completed'
      ORDER BY completed_at DESC 
      LIMIT 5
    `, [userId]);
    
    // Calculate next reset date
    const now = new Date();
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    
    const response = {
      success: true,
      subscription: subscription ? {
        id: subscription.id,
        plan_type: subscription.plan_type,
        status: subscription.status,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        next_billed_at: subscription.next_billed_at,
        monthly_credit_allowance: subscription.monthly_credit_allowance,
        canceled_at: subscription.canceled_at
      } : null,
      credits: {
        balance: creditBalance,
        monthly_allowance: {
          limit: monthlyAllowance.limit,
          used: monthlyAllowance.used,
          remaining: Math.max(0, monthlyAllowance.limit - monthlyAllowance.used),
          next_reset: nextReset.toISOString()
        }
      },
      recent_topups: topups,
      user: {
        id: userId,
        email: req.user.email,
        premium_tier: req.user.premium_tier || 'free'
      }
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Failed to get billing status:', error);
    res.status(500).json({
      error: 'Status retrieval failed',
      message: 'Failed to retrieve billing status'
    });
  }
});

/**
 * GET /billing/usage
 * Get detailed usage statistics
 */
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { months = 3 } = req.query;
    
    // Get monthly usage for last N months
    const [monthlyUsage] = await pool.query(`
      SELECT usage_year, usage_month, credits_consumed, credits_from_subscription, 
             credits_from_topups, emails_10min_count, emails_1hour_count, emails_24hour_count,
             monthly_allowance, allowance_used
      FROM api_usage_monthly 
      WHERE user_id = ? 
      ORDER BY usage_year DESC, usage_month DESC 
      LIMIT ?
    `, [userId, parseInt(months)]);
    
    // Get total stats
    const [totalStats] = await pool.query(`
      SELECT 
        SUM(credits_consumed) as total_credits_used,
        SUM(credits_from_subscription) as total_from_subscription,
        SUM(credits_from_topups) as total_from_topups,
        SUM(emails_10min_count) as total_10min_emails,
        SUM(emails_1hour_count) as total_1hour_emails,
        SUM(emails_24hour_count) as total_24hour_emails
      FROM api_usage_monthly 
      WHERE user_id = ?
    `, [userId]);
    
    res.json({
      success: true,
      monthly_usage: monthlyUsage,
      total_stats: totalStats[0] || {},
      current_balance: await getCreditBalance(userId)
    });
    
  } catch (error) {
    console.error('Failed to get usage statistics:', error);
    res.status(500).json({
      error: 'Usage retrieval failed',
      message: 'Failed to retrieve usage statistics'
    });
  }
});

/**
 * POST /billing/cancel
 * Cancel current subscription
 */
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { immediate = false } = req.body;
    
    // Get current subscription
    const subscription = await getUserSubscription(userId);
    
    if (!subscription || subscription.status !== 'active') {
      return res.status(400).json({
        error: 'No active subscription',
        message: 'You do not have an active subscription to cancel'
      });
    }
    
    // Use Paddle SDK to cancel subscription
    const { paddle } = await import('../services/billing.js');
    
    try {
      await paddle.subscriptions.cancel(subscription.id, {
        effective_from: immediate ? 'immediately' : 'next_billing_period'
      });
      
      // Update local database
      if (immediate) {
        await pool.query(
          'UPDATE subscriptions SET status = ?, canceled_at = NOW() WHERE id = ?',
          ['canceled', subscription.id]
        );
        
        await pool.query(
          'UPDATE users SET premium_tier = ? WHERE id = ?',
          ['free', userId]
        );
      }
      
      res.json({
        success: true,
        message: immediate 
          ? 'Subscription canceled immediately' 
          : 'Subscription will be canceled at the end of the current billing period',
        effective_date: immediate ? new Date().toISOString() : subscription.current_period_end
      });
      
    } catch (paddleError) {
      console.error('Paddle cancellation failed:', paddleError);
      res.status(500).json({
        error: 'Cancellation failed',
        message: 'Failed to cancel subscription with payment provider'
      });
    }
    
  } catch (error) {
    console.error('Failed to cancel subscription:', error);
    res.status(500).json({
      error: 'Cancellation failed',
      message: 'Failed to process cancellation request'
    });
  }
});

/**
 * POST /billing/admin/add-credits
 * Admin endpoint to add credits to a user (for testing/support)
 */
router.post('/admin/add-credits', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({
        error: 'Admin access required',
        message: 'Only administrators can add credits'
      });
    }
    
    const { user_id, amount, reason = 'Admin credit adjustment' } = req.body;
    
    if (!user_id || !amount || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'user_id and positive amount are required'
      });
    }
    
    // Add credits
    const newBalance = await addCredits(user_id, amount, 'admin');
    
    // Log the action
    console.log(`Admin ${req.user.id} added ${amount} credits to user ${user_id}. Reason: ${reason}`);
    
    res.json({
      success: true,
      message: `Successfully added ${amount} credits`,
      new_balance: newBalance,
      added_by: req.user.id,
      reason
    });
    
  } catch (error) {
    console.error('Failed to add admin credits:', error);
    res.status(500).json({
      error: 'Credit addition failed',
      message: 'Failed to add credits'
    });
  }
});

export default router; 