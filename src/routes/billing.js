import express from 'express';
import { createCheckoutSession, getEnvironmentInfo } from '../services/billingApi.js';
import { chargeCredits, syncFromDB } from '../services/billing.js';
import { pool } from '../db/init.js';

const router = express.Router();

// GET /billing/info -> environment and configuration info
router.get('/info', (req, res) => {
  const envInfo = getEnvironmentInfo();
  
  // Available price IDs
  const priceIds = {
    premium: process.env.PADDLE_PREMIUM_PRICE_ID,
    premiumPlus: process.env.PADDLE_PREMIUM_PLUS_PRICE_ID,
    credit1k: process.env.PADDLE_CREDIT_1K_PRICE_ID,
    credit5k: process.env.PADDLE_CREDIT_5K_PRICE_ID,
    credit20k: process.env.PADDLE_CREDIT_20K_PRICE_ID,
  };
  
  // Filter out undefined/null values
  const configuredPrices = Object.entries(priceIds)
    .filter(([_, id]) => id && id !== 'undefined')
    .reduce((acc, [key, id]) => ({ ...acc, [key]: id }), {});
  
  res.json({
    ...envInfo,
    priceIds: configuredPrices,
    priceCount: Object.keys(configuredPrices).length,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173'
  });
});

// POST /billing/checkout/:priceId -> create checkout session and return URL
router.post('/checkout/:priceId', async (req, res) => {
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
    
    // Log environment info
    const envInfo = getEnvironmentInfo();
    console.log(`[billing] Checkout request - Environment: ${envInfo.environment}`);
    console.log(`[billing] API URL: ${envInfo.apiUrl}`);
    console.log(`[billing] Checkout URL: ${envInfo.checkoutUrl}`);
    
    // Log the price ID request
    console.log(`[billing] Checkout request for price ID: ${priceId}`);
    console.log(`[billing] User: ${user.email || user.user_email} (ID: ${user.id})`);
    
    // Validate price ID is configured
    const validPriceIds = [
      process.env.PADDLE_PREMIUM_PRICE_ID,
      process.env.PADDLE_PREMIUM_PLUS_PRICE_ID,
      process.env.PADDLE_CREDIT_1K_PRICE_ID,
      process.env.PADDLE_CREDIT_5K_PRICE_ID,
      process.env.PADDLE_CREDIT_20K_PRICE_ID
    ].filter(Boolean);
    
    if (validPriceIds.length > 0 && !validPriceIds.includes(priceId)) {
      console.error(`[billing] Invalid price ID: ${priceId}`);
      console.error(`[billing] Valid price IDs: ${validPriceIds.join(', ')}`);
      return res.status(400).json({
        error: 'Invalid price ID',
        message: `The specified price ID "${priceId}" is not configured.`,
        validPriceIds: validPriceIds
      });
    }
    
    // If no price IDs are configured, proceed anyway (for testing)
    if (validPriceIds.length === 0) {
      console.warn('[billing] No Paddle price IDs configured, proceeding with checkout anyway');
    }
    
    // Get user email
    const email = user.email || user.user_email;
    if (!email) {
      return res.status(400).json({
        error: 'Missing email',
        message: 'User email is required for checkout'
      });
    }
    
    console.log(`[billing] Creating checkout session for:`, { 
      priceId, 
      email, 
      userId: user.id,
      environment: envInfo.environment
    });
    
    // Create checkout session using the new two-step process
    const checkoutUrl = await createCheckoutSession(priceId, email, user);
    
    console.log(`[billing] ✅ Checkout session created successfully`);
    console.log(`[billing] Checkout URL: ${checkoutUrl}`);
    
    res.json({ 
      success: true,
      url: checkoutUrl,
      environment: envInfo.environment,
      priceId: priceId
    });
    
  } catch (err) {
    console.error('[billing] ❌ Checkout creation failed:', err);
    
    // Parse Paddle error if available
    let errorMessage = 'Failed to create checkout link';
    let errorCode = 'CHECKOUT_FAILED';
    
    if (err.message.includes('[Paddle')) {
      try {
        const paddleError = JSON.parse(err.message.split('] ')[1]);
        errorMessage = paddleError.error?.detail || paddleError.error?.message || errorMessage;
        errorCode = paddleError.error?.code || errorCode;
      } catch (parseError) {
        // If parsing fails, use the original error message
        errorMessage = err.message;
      }
    } else {
      errorMessage = err.message;
    }
    
    res.status(500).json({
      error: errorCode,
      message: errorMessage,
      debug: process.env.NODE_ENV === 'development' ? {
        stack: err.stack,
        fullError: err.message
      } : undefined
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
        credits: 0, 
        plan: 'free',
        isGuest: true,
        message: 'Guest users have limited access'
      });
    }
    
    // Sync credits from database
    await syncFromDB(user.id);
    
    // Get current subscription status
    const [subscriptions] = await pool.query(`
      SELECT s.plan_type, s.status, s.current_period_end, s.monthly_credit_allowance
      FROM subscriptions s 
      WHERE s.user_id = ? AND s.status IN ('active', 'trialing', 'past_due')
      ORDER BY s.created_at DESC 
      LIMIT 1
    `, [user.id]);
    
    const subscription = subscriptions[0];
    const plan = subscription?.plan_type || user.premium_tier || 'free';
    
    // Get current credit balance
    const [creditRows] = await pool.query('SELECT credit_balance FROM users WHERE id = ?', [user.id]);
    const credits = creditRows[0]?.credit_balance || 0;
    
    console.log(`[billing] Status check for user ${user.id}: ${credits} credits, ${plan} plan`);
    
    res.json({
      credits: credits,
      plan: plan,
      subscription: subscription ? {
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        monthlyAllowance: subscription.monthly_credit_allowance
      } : null,
      isGuest: false
    });
    
  } catch (err) {
    console.error('[billing] Status check failed:', err);
    res.status(500).json({
      error: 'Failed to get billing status',
      message: err.message
    });
  }
});

// POST /billing/charge -> charge credits for API usage
router.post('/charge', async (req, res) => {
  try {
    const { amount } = req.body;
    const user = req.user || req.apiUser;
    
    if (!user || user.isGuest) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    // Charge credits
    chargeCredits(user.id, amount);
    
    // Get updated balance
    await syncFromDB(user.id);
    const [creditRows] = await pool.query('SELECT credit_balance FROM users WHERE id = ?', [user.id]);
    const newBalance = creditRows[0]?.credit_balance || 0;
    
    console.log(`[billing] Charged ${amount} credits from user ${user.id}, new balance: ${newBalance}`);
    
    res.json({
      success: true,
      charged: amount,
      newBalance: newBalance
    });
    
  } catch (err) {
    if (err.message === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({
        error: 'Insufficient credits',
        message: 'Not enough credits to complete this action'
      });
    }
    
    console.error('[billing] Credit charge failed:', err);
    res.status(500).json({
      error: 'Failed to charge credits',
      message: err.message
    });
  }
});

export default router; 
