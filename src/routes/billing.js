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
    
    // Validate price ID is configured
    const validPriceIds = [
      process.env.PADDLE_PREMIUM_PRICE_ID,
      process.env.PADDLE_PREMIUM_PLUS_PRICE_ID,
      process.env.PADDLE_CREDIT_1K_PRICE_ID,
      process.env.PADDLE_CREDIT_5K_PRICE_ID,
      process.env.PADDLE_CREDIT_20K_PRICE_ID
    ].filter(Boolean);
    
    if (!validPriceIds.includes(priceId)) {
      return res.status(400).json({
        error: 'Invalid price ID',
        message: 'The specified price ID is not valid'
      });
    }
    
    const email = user.email || user.user_email;
    const mutation = `mutation CreatePayLink($priceId: ID!, $email: String!) {
      payLinkCreate(input: {
        customer: { email: $email },
        priceId: $priceId,
        quantity: 1
      }) { url }
    }`;
    
    const data = await paddleRequest(mutation, { priceId, email });
    res.json({ url: data.payLinkCreate.url });
  } catch (err) {
    console.error('Billing checkout error:', err);
    res.status(500).json({
      error: 'Checkout failed',
      message: 'Failed to create checkout link. Please try again.'
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
    
    // Get fresh user data from DB
    const [userRows] = await pool.query(
      'SELECT credit_balance, premium_tier, subscription_id FROM users WHERE id = ?',
      [userId]
    );
    
    const userData = userRows[0] || {};
    
    res.json({ 
      credit_balance: userData.credit_balance ?? 0, 
      plan: userData.premium_tier ?? 'free',
      subscription_id: userData.subscription_id || null,
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