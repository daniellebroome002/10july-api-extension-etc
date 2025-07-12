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
 * Get price information for frontend Paddle.js checkout
 */
router.post('/create-checkout', authenticateToken, async (req, res) => {
  try {
    const { type, plan, credits } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;
    
    console.log(`[Billing] Getting price info for user ${userId}: type=${type}, plan=${plan}, credits=${credits}`);
    
    if (!type || !['subscription', 'credits'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid checkout type. Must be "subscription" or "credits"'
      });
    }
    
    let priceId;
    
    if (type === 'subscription') {
      // Subscription checkout
      if (!plan || !['premium', 'premium_plus'].includes(plan)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid plan. Must be "premium" or "premium_plus"'
        });
      }
      
      // Get Paddle price IDs from environment variables
      priceId = plan === 'premium' 
        ? process.env.PADDLE_PREMIUM_PLAN_ID 
        : process.env.PADDLE_PREMIUM_PLUS_PLAN_ID;
        
      if (!priceId) {
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
      
      // For credits, we need to first check if we have price IDs (not product IDs)
      // If we only have product IDs, we need to get the price IDs from those products
      const creditProductMap = {
        1000: process.env.PADDLE_CREDITS_1K_PRODUCT_ID,
        5000: process.env.PADDLE_CREDITS_5K_PRODUCT_ID,
        20000: process.env.PADDLE_CREDITS_20K_PRODUCT_ID
      };
      
      const productId = creditProductMap[credits];
      
      if (!productId) {
        throw new Error(`Paddle product ID not configured for ${credits} credits`);
      }
      
      // Check if this is actually a price ID (starts with 'pri_') or product ID (starts with 'pro_')
      if (productId.startsWith('pri_')) {
        priceId = productId;
      } else {
        // It's a product ID, we need to get the price ID from Paddle
        try {
          const prices = await paddleApi.listPrices({ product_id: productId });
          if (prices.data && prices.data.length > 0) {
            priceId = prices.data[0].id;
            console.log(`[Billing] Found price ID ${priceId} for product ${productId}`);
          } else {
            throw new Error(`No prices found for product ${productId}. Please create prices in Paddle dashboard.`);
          }
        } catch (error) {
          console.error(`[Billing] Failed to get prices for product ${productId}:`, error);
          throw new Error(`Failed to get price information for ${credits} credits. Please check Paddle configuration.`);
        }
      }
    }

    // Construct URLs for success/cancel
    const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '') || 'https://boomlify.com';
    const successUrl = `${frontendUrl}/billing/success`;
    const cancelUrl = `${frontendUrl}/billing`;
    
    console.log(`[Billing] Returning price info for user ${userId}: ${type} - ${plan || credits}, priceId: ${priceId}`);
    
    // Return price information for frontend Paddle.js integration
    res.json({
      success: true,
      data: {
        priceId: priceId,
        type: type,
        plan: plan,
        credits: credits,
        customerEmail: userEmail,
        successUrl: successUrl,
        cancelUrl: cancelUrl,
        customData: {
          user_id: userId,
          type: type,
          ...(plan && { plan }),
          ...(credits && { credits })
        }
      }
    });
    
  } catch (error) {
    console.error('[Billing] Failed to get checkout info:', error);
    
    // Extract meaningful error message
    let errorMessage = 'Failed to get checkout information';
    let errorDetails = error.message;
    
    if (error.message.includes('not configured')) {
      errorMessage = 'Billing configuration error';
      errorDetails = error.message;
    } else if (error.message.includes('No prices found')) {
      errorMessage = 'Price configuration error';
      errorDetails = 'Please create prices for your products in Paddle dashboard';
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: errorDetails
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
