import express from 'express';
import { paddleRequest } from '../services/billingApi.js';
import { chargeCredits, syncFromDB } from '../services/billing.js';
import { pool } from '../db/init.js';

const router = express.Router();

// POST /billing/checkout/:priceId -> returns pay link URL
router.post('/checkout/:priceId', async (req, res, next) => {
  try {
    const { priceId } = req.params;
    const user = req.user || req.apiUser;
    
    // Require authentication for checkout
    if (!user || user.isGuest) {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'Please log in to purchase credits or upgrade your plan'
      });
    }
    
    // Log the price ID for debugging
    console.log('Checkout request for price ID:', priceId);
    console.log('Available env vars:', {
      PADDLE_PREMIUM_PRICE_ID: process.env.PADDLE_PREMIUM_PRICE_ID,
      PADDLE_PREMIUM_PLUS_PRICE_ID: process.env.PADDLE_PREMIUM_PLUS_PRICE_ID,
      PADDLE_CREDIT_1K_PRICE_ID: process.env.PADDLE_CREDIT_1K_PRICE_ID,
      PADDLE_CREDIT_5K_PRICE_ID: process.env.PADDLE_CREDIT_5K_PRICE_ID,
      PADDLE_CREDIT_20K_PRICE_ID: process.env.PADDLE_CREDIT_20K_PRICE_ID
    });
    
    // Validate price ID is configured (only if env vars are set)
    const validPriceIds = [
      process.env.PADDLE_PREMIUM_PRICE_ID,
      process.env.PADDLE_PREMIUM_PLUS_PRICE_ID,
      process.env.PADDLE_CREDIT_1K_PRICE_ID,
      process.env.PADDLE_CREDIT_5K_PRICE_ID,
      process.env.PADDLE_CREDIT_20K_PRICE_ID
    ].filter(Boolean);
    
    // Only validate if we have configured price IDs
    if (validPriceIds.length > 0 && !validPriceIds.includes(priceId)) {
      console.error('Invalid price ID:', priceId, 'Valid IDs:', validPriceIds);
      return res.status(400).json({
        error: 'Invalid price ID',
        message: 'The specified price ID is not configured. Please check environment variables.',
        debug: {
          requested: priceId,
          configured: validPriceIds
        }
      });
    }
    
    // If no price IDs are configured, proceed anyway (for testing)
    if (validPriceIds.length === 0) {
      console.warn('No Paddle price IDs configured in environment variables, proceeding with checkout anyway');
    }
    
    const email = user.email || user.user_email;
    const mutation = `mutation CreatePayLink($priceId: ID!, $email: String!) {
      payLinkCreate(input: {
        customer: { email: $email },
        priceId: $priceId,
        quantity: 1
      }) { url }
    }`;
    
    console.log('Creating Paddle checkout for:', { priceId, email });
    const data = await paddleRequest(mutation, { priceId, email });
    res.json({ url: data.payLinkCreate.url });
  } catch (err) {
    console.error('Billing checkout error:', err);
    res.status(500).json({
      error: 'Checkout failed',
      message: 'Failed to create checkout link: ' + err.message,
      debug: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// GET /billing/status -> credits + plan
router.get('/status', async (req, res) => {
  try {
    const user = req.user || req.apiUser;
    
    // Handle guest users
    if (!user || user.isGuest) {
      return res.json({ 
        credit_balance: 0, 
        plan: 'guest',
        message: 'Guest users have no credit balance'
      });
    }
    
    const userId = user.id || user.user_id;
    const email = user.email || user.user_email;
    
    // For authenticated users, sync from DB to get latest balance
    await syncFromDB(userId, pool);
    
    // Get fresh user data from DB (only query existing columns)
    const [userRows] = await pool.query(
      'SELECT credit_balance, premium_tier FROM users WHERE id = ?',
      [userId]
    );
    
    const userData = userRows[0] || {};
    
    // Check if user has an active subscription in the subscriptions table
    const [subscriptionRows] = await pool.query(
      'SELECT id, status, plan_type FROM subscriptions WHERE user_id = ? AND status = ?',
      [userId, 'active']
    );
    
    const activeSubscription = subscriptionRows[0] || null;
    
    res.json({ 
      credit_balance: userData.credit_balance ?? 0, 
      plan: userData.premium_tier ?? 'free',
      subscription_id: activeSubscription ? activeSubscription.id : null,
      subscription_status: activeSubscription ? activeSubscription.status : null,
      subscription_plan: activeSubscription ? activeSubscription.plan_type : null,
      user_id: userId,
      email: email
    });
  } catch (error) {
    console.error('Error fetching billing status:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to fetch billing status'
    });
  }
});

export default router; 
