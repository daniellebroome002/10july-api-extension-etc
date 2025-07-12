import express from 'express';
import { pool } from '../db/init.js';
import billingService from '../services/billing.js';
import paddleApi from '../services/paddleApi.js';

const router = express.Router();

// Configure raw body parser for webhook signature verification
router.use(express.raw({
  type: 'application/json',
  verify: (req, res, buf) => {
    if (buf && buf.length) {
      req.rawBody = buf;
    }
  }
}));

/**
 * Process subscription created event
 */
async function handleSubscriptionCreated(eventData) {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      id: subscriptionId,
      customer_id: paddleCustomerId,
      custom_data,
      status,
      started_at,
      current_billing_period,
      next_billed_at,
      billing_cycle,
      items
    } = eventData;
    
    // Extract user ID from custom data
    const userId = custom_data?.user_id;
    const planType = custom_data?.plan;
    
    if (!userId || !planType) {
      throw new Error('Missing user_id or plan in subscription custom_data');
    }
    
    // Determine monthly credit allowance based on plan
    const monthlyAllowance = billingService.PLAN_ALLOWANCES[planType];
    if (!monthlyAllowance) {
      throw new Error(`Unknown plan type: ${planType}`);
    }
    
    // Get the price ID from the first item
    const paddlePriceId = items[0]?.price?.id;
    
    // Insert subscription record
    await connection.execute(`
      INSERT INTO subscriptions (
        id, user_id, paddle_customer_id, plan_type, status,
        paddle_plan_id, currency_code, billing_cycle,
        monthly_credit_allowance, credits_reset_day,
        started_at, current_period_start, current_period_end, next_billed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      subscriptionId,
      userId,
      paddleCustomerId,
      planType,
      status,
      paddlePriceId,
      'USD', // Default currency
      JSON.stringify(billing_cycle),
      monthlyAllowance,
      1, // Reset on 1st of month
      started_at,
      current_billing_period.starts_at,
      current_billing_period.ends_at,
      next_billed_at
    ]);
    
    // Update user's premium tier
    await connection.execute(`
      UPDATE users 
      SET premium_tier = ?
      WHERE id = ?
    `, [planType, userId]);
    
    await connection.commit();
    
    console.log(`[Paddle Webhook] Subscription created: ${subscriptionId} for user ${userId} (${planType})`);
    
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Process subscription updated event
 */
async function handleSubscriptionUpdated(eventData) {
  const connection = await pool.getConnection();
  
  try {
    const {
      id: subscriptionId,
      status,
      current_billing_period,
      next_billed_at,
      canceled_at
    } = eventData;
    
    // Update subscription status and dates
    await connection.execute(`
      UPDATE subscriptions 
      SET 
        status = ?,
        current_period_start = ?,
        current_period_end = ?,
        next_billed_at = ?,
        canceled_at = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [
      status,
      current_billing_period?.starts_at,
      current_billing_period?.ends_at,
      next_billed_at,
      canceled_at,
      subscriptionId
    ]);
    
    // If subscription is canceled, update user tier to free
    if (status === 'canceled') {
      const [subscription] = await connection.execute(`
        SELECT user_id FROM subscriptions WHERE id = ?
      `, [subscriptionId]);
      
      if (subscription.length > 0) {
        await connection.execute(`
          UPDATE users 
          SET premium_tier = 'free'
          WHERE id = ?
        `, [subscription[0].user_id]);
      }
    }
    
    console.log(`[Paddle Webhook] Subscription updated: ${subscriptionId} -> ${status}`);
    
  } finally {
    connection.release();
  }
}

/**
 * Process transaction completed event (credit purchases)
 */
async function handleTransactionCompleted(eventData) {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      id: transactionId,
      customer_id: paddleCustomerId,
      custom_data,
      status,
      items,
      details,
      billed_at
    } = eventData;
    
    // Check if this is a credit purchase
    const creditAmount = custom_data?.credits;
    const userId = custom_data?.user_id;
    
    if (!creditAmount || !userId) {
      console.log(`[Paddle Webhook] Transaction ${transactionId} is not a credit purchase, skipping`);
      return;
    }
    
    // Get transaction details
    const amountPaid = parseFloat(details.totals.total) / 100; // Convert from cents
    const currencyCode = details.totals.currency_code;
    const priceId = items[0]?.price?.id;
    
    // Check if we already processed this transaction
    const [existing] = await connection.execute(`
      SELECT id FROM credit_topups WHERE paddle_transaction_id = ?
    `, [transactionId]);
    
    if (existing.length > 0) {
      console.log(`[Paddle Webhook] Transaction ${transactionId} already processed, skipping`);
      return;
    }
    
    // Insert credit topup record
    await connection.execute(`
      INSERT INTO credit_topups (
        user_id, paddle_transaction_id, paddle_customer_id, paddle_product_id,
        credits_purchased, credits_applied, amount_paid, currency_code,
        payment_status, purchased_at, completed_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      userId,
      transactionId,
      paddleCustomerId,
      priceId,
      creditAmount,
      creditAmount, // Applied amount = purchased amount
      amountPaid,
      currencyCode,
      'completed',
      billed_at,
      billed_at
    ]);
    
    // Add credits to user's balance via billing service
    await billingService.addCredits(userId, creditAmount, 'paddle_purchase');
    
    await connection.commit();
    
    console.log(`[Paddle Webhook] Credit purchase completed: ${creditAmount} credits for user ${userId} (transaction: ${transactionId})`);
    
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Process subscription renewal event
 */
async function handleSubscriptionRenewed(eventData) {
  const connection = await pool.getConnection();
  
  try {
    const {
      id: subscriptionId,
      current_billing_period,
      next_billed_at
    } = eventData;
    
    // Update subscription billing period
    await connection.execute(`
      UPDATE subscriptions 
      SET 
        current_period_start = ?,
        current_period_end = ?,
        next_billed_at = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [
      current_billing_period.starts_at,
      current_billing_period.ends_at,
      next_billed_at,
      subscriptionId
    ]);
    
    // Reset monthly allowance usage
    const [subscription] = await connection.execute(`
      SELECT user_id, monthly_credit_allowance FROM subscriptions WHERE id = ?
    `, [subscriptionId]);
    
    if (subscription.length > 0) {
      const { user_id: userId, monthly_credit_allowance: allowance } = subscription[0];
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      
      // Reset monthly usage
      await connection.execute(`
        INSERT INTO api_usage_monthly (
          user_id, usage_month, usage_year, monthly_allowance, 
          allowance_used, allowance_reset_at
        ) VALUES (?, ?, ?, ?, 0, NOW())
        ON DUPLICATE KEY UPDATE 
          allowance_used = 0,
          allowance_reset_at = NOW()
      `, [userId, currentMonth, currentYear, allowance]);
      
      console.log(`[Paddle Webhook] Monthly allowance reset for user ${userId}: ${allowance} credits`);
    }
    
    console.log(`[Paddle Webhook] Subscription renewed: ${subscriptionId}`);
    
  } finally {
    connection.release();
  }
}

/**
 * Main webhook endpoint
 * POST /api/webhook/paddle
 */
router.post('/', async (req, res) => {
  console.log('[Paddle Webhook] Received webhook');
  
  const signature = req.get('paddle-signature');
  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
  const rawBody = req.rawBody?.toString();

  if (!signature || !webhookSecret || !rawBody) {
    console.error('[Paddle Webhook] Missing signature, secret, or body');
    return res.status(400).json({ error: 'Missing required webhook data' });
  }

  try {
    // Verify webhook signature using Paddle SDK
    const event = await paddleApi.verifyWebhook(rawBody, signature, webhookSecret);
    
    console.log(`[Paddle Webhook] Processing event: ${event.eventType}`);
    
    // Process different event types
    switch (event.eventType) {
      case 'subscription.created':
        await handleSubscriptionCreated(event.data);
        break;
        
      case 'subscription.updated':
        await handleSubscriptionUpdated(event.data);
        break;
        
      case 'subscription.canceled':
        await handleSubscriptionUpdated(event.data);
        break;
        
      case 'transaction.completed':
        await handleTransactionCompleted(event.data);
        break;
        
      case 'subscription.payment_succeeded':
        await handleSubscriptionRenewed(event.data);
        break;
        
      case 'subscription.payment_failed':
        console.log(`[Paddle Webhook] Payment failed for subscription: ${event.data.id}`);
        break;
        
      default:
        console.log(`[Paddle Webhook] Unhandled event type: ${event.eventType}`);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('[Paddle Webhook] Error processing webhook:', error);
    
    if (error.message === 'Invalid webhook signature') {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Health check endpoint for webhook
 */
router.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    webhookSecret: !!process.env.PADDLE_WEBHOOK_SECRET,
    paddleApiKey: !!process.env.PADDLE_API_KEY
  });
});

export default router; 