import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import billingService from '../services/billing.js';
import { pool } from '../db/init.js';
import paddleApi from '../services/paddleApi.js';

const router = express.Router();

/**
 * Billing Routes - Paddle Integration
 * 
 * Features:
 * - Create checkout URLs for subscriptions and credit packs
 * - Get user's current billing status
 * - Handle subscription management
 */

/**
 * GET /api/billing/status
 * Get user's current billing status, credit balance, and subscription info
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get comprehensive credit information
    const creditInfo = await billingService.getUserCreditInfo(userId);
    
    // Get billing service statistics for admin users
    const stats = req.user.is_admin ? billingService.getStats() : null;
    
    res.json({
      success: true,
      data: {
        userId,
        creditBalance: creditInfo.creditBalance,
        premiumTier: creditInfo.premiumTier,
        subscription: creditInfo.subscription,
        monthlyUsage: creditInfo.monthlyUsage,
        creditCosts: {
          '10min': billingService.calculateCreditCost('10min'),
          '1hour': billingService.calculateCreditCost('1hour'),
          '24hour': billingService.calculateCreditCost('24hour')
        },
        ...(stats && { serviceStats: stats })
      }
    });
    
  } catch (error) {
    console.error('Failed to get billing status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve billing status'
    });
  }
});

/**
 * POST /api/billing/create-checkout
 * Create Paddle checkout URL for subscriptions or credit packs
 */
router.post('/create-checkout', authenticateToken, async (req, res) => {
  try {
    const { type, plan, credits } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;
    
    if (!type || !['subscription', 'credits'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid checkout type. Must be "subscription" or "credits"'
      });
    }
    
    let paddleProductId;
    
    if (type === 'subscription') {
      // Subscription checkout
      if (!plan || !['premium', 'premium_plus'].includes(plan)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid plan. Must be "premium" or "premium_plus"'
        });
      }
      
      // Get Paddle plan IDs from environment variables
      paddleProductId = plan === 'premium' 
        ? process.env.PADDLE_PREMIUM_PLAN_ID 
        : process.env.PADDLE_PREMIUM_PLUS_PLAN_ID;
        
      if (!paddleProductId) {
        throw new Error(`Paddle plan ID not configured for ${plan}`);
      }
      
    } else if (type === 'credits') {
      // Credit pack checkout
      if (!credits || ![1000, 5000, 20000].includes(credits)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid credit amount. Must be 1000, 5000, or 20000'
        });
      }
      
      // Get Paddle product IDs for credit packs
      const creditProductMap = {
        1000: process.env.PADDLE_CREDITS_1K_PRODUCT_ID,
        5000: process.env.PADDLE_CREDITS_5K_PRODUCT_ID,
        20000: process.env.PADDLE_CREDITS_20K_PRODUCT_ID
      };
      
      paddleProductId = creditProductMap[credits];
      
      if (!paddleProductId) {
        throw new Error(`Paddle product ID not configured for ${credits} credits`);
      }
    }
    
    // Create Paddle Billing checkout session via API
    const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '') || 'https://boomlify.com';
    const checkoutData = {
      items: [{
        price_id: paddleProductId,
        quantity: 1
      }],
      customer_id: userId, // Use customer ID if exists
      customer_email: userEmail,
      custom_data: {
        user_id: userId,
        type: type,
        ...(plan && { plan }),
        ...(credits && { credits })
      },
      success_url: `${frontendUrl}/billing/success?transaction_id={checkout.id}`,
      cancel_url: `${frontendUrl}/billing`,
      settings: {
        display_mode: "inline",
        theme: "light",
        locale: "en",
        custom_data: {
          user_id: userId
        }
      }
    };

    // Call Paddle API to create checkout
    const response = await fetch('https://api.paddle.com/checkout/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(checkoutData)
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('[Billing] Failed to create checkout:', error);
      throw new Error('Failed to create checkout');
    }

    const checkoutResponse = await response.json();
    
    // Return the checkout URL
    res.json({
      success: true,
      data: {
        checkoutUrl: checkoutResponse.data.url
      }
    });
    
  } catch (error) {
    console.error('Failed to create checkout:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create checkout URL'
    });
  }
});

/**
 * POST /api/billing/add-credits
 * Manually add credits to user account (admin only)
 */
router.post('/add-credits', authenticateToken, async (req, res) => {
  try {
    if (!req.user.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
    const { userId, credits, reason } = req.body;
    
    if (!userId || !credits || credits <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid userId and positive credits amount required'
      });
    }
    
    // Add credits to user account
    await billingService.addCredits(userId, credits, reason || 'admin_manual');
    
    // Log the action
    console.log(`[Admin] Added ${credits} credits to user ${userId} by admin ${req.user.id}. Reason: ${reason || 'manual'}`);
    
    // Get updated credit info
    const creditInfo = await billingService.getUserCreditInfo(userId);
    
    res.json({
      success: true,
      data: {
        creditsAdded: credits,
        newBalance: creditInfo.creditBalance,
        reason: reason || 'admin_manual'
      }
    });
    
  } catch (error) {
    console.error('Failed to add credits:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add credits'
    });
  }
});

/**
 * GET /api/billing/usage-history
 * Get user's billing and usage history
 */
router.get('/usage-history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { months = '3' } = req.query;
    
    // Ensure months is a valid integer between 1 and 12
    const monthsLimit = Math.min(Math.max(parseInt(months) || 3, 1), 12);
    
    const connection = await pool.getConnection();
    
    try {
      // Get monthly usage history
      const [usageHistory] = await connection.execute(`
        SELECT 
          usage_month,
          usage_year,
          emails_10min_count,
          emails_1hour_count,
          emails_24hour_count,
          credits_consumed,
          credits_from_subscription,
          credits_from_topups,
          monthly_allowance,
          allowance_used
        FROM api_usage_monthly
        WHERE user_id = ?
        ORDER BY usage_year DESC, usage_month DESC
        LIMIT ${monthsLimit}
      `, [userId]);
      
      // Get credit topup history
      const [topupHistory] = await connection.execute(`
        SELECT 
          credits_purchased,
          amount_paid,
          currency_code,
          payment_status,
          purchased_at,
          completed_at
        FROM credit_topups
        WHERE user_id = ? AND payment_status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 10
      `, [userId]);
      
      res.json({
        success: true,
        data: {
          monthlyUsage: usageHistory,
          creditTopups: topupHistory
        }
      });
      
    } finally {
      connection.release();
    }
    
  } catch (error) {
    console.error('Failed to get usage history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve usage history'
    });
  }
});

/**
 * POST /api/billing/cancel-subscription
 * Cancel user's active subscription
 */
router.post('/cancel-subscription', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const connection = await pool.getConnection();
    
    try {
      // Get user's active subscription
      const [subscriptions] = await connection.execute(`
        SELECT id, paddle_customer_id, status
        FROM subscriptions
        WHERE user_id = ? AND status = 'active'
        LIMIT 1
      `, [userId]);
      
      if (subscriptions.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No active subscription found'
        });
      }
      
      const subscription = subscriptions[0];
      
      // Cancel the subscription in Paddle first
      try {
        await paddleApi.cancelSubscription(subscription.id);
      } catch (apiError) {
        console.error(`[Billing] Paddle cancel failed for subscription ${subscription.id}:`, apiError?.response?.data || apiError);
        return res.status(502).json({
          success: false,
          error: 'Failed to cancel subscription with Paddle'
        });
      }

      // Mark as canceled in our database
      await connection.execute(`
        UPDATE subscriptions 
        SET status = 'canceled', canceled_at = NOW()
        WHERE id = ?
      `, [subscription.id]);
      
      console.log(`[Billing] Canceled subscription ${subscription.id} for user ${userId}`);
      
      res.json({
        success: true,
        data: {
          subscriptionId: subscription.id,
          status: 'canceled',
          canceledAt: new Date().toISOString()
        }
      });
      
    } finally {
      connection.release();
    }
    
  } catch (error) {
    console.error('Failed to cancel subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel subscription'
    });
  }
});

export default router; 
