import express from 'express';
import { paddleRequest } from '../services/billingApi.js';
import { chargeCredits, syncFromDB } from '../services/billing.js';
import { pool } from '../db/init.js';

const router = express.Router();

// POST /billing/checkout/:priceId -> returns pay link URL
router.post('/checkout/:priceId', async (req, res, next) => {
  try {
    const { priceId } = req.params;
    const user = req.user;
    
    // Require authentication for checkout
    if (!user || user.isGuest) {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'Please log in to purchase credits or upgrade your plan'
      });
    }
    
    const email = user.email;
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
    next(err);
  }
});

// GET /billing/status -> credits + plan (stub)
router.get('/status', async (req, res) => {
  try {
    const user = req.user;
    
    // Handle guest users
    if (!user || user.isGuest) {
      return res.json({ 
        credit_balance: 0, 
        plan: 'guest',
        message: 'Guest users have no credit balance'
      });
    }
    
    // For authenticated users, sync from DB to get latest balance
    await syncFromDB(user.id, pool);
    
    // Get fresh user data from DB
    const [userRows] = await pool.query(
      'SELECT credit_balance, premium_tier FROM users WHERE id = ?',
      [user.id]
    );
    
    const userData = userRows[0] || {};
    
    res.json({ 
      credit_balance: userData.credit_balance ?? 0, 
      plan: userData.premium_tier ?? 'free',
      user_id: user.id,
      email: user.email
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