import express from 'express';
import crypto from 'crypto';
import { pool } from '../db/init.js';
import billingService from '../services/billing.js';

const router = express.Router();

/**
 * Paddle Webhook Handler
 * 
 * Handles webhooks from Paddle for:
 * - Subscription lifecycle events
 * - Transaction completion (credit purchases)
 * - Payment failures and updates
 */

/**
 * Verify Paddle webhook signature
 * @param {string} body - Raw request body
 * @param {string} signature - Paddle signature header
 * @param {string} secret - Webhook secret from environment
 * @returns {boolean} Whether signature is valid
 */
function verifyPaddleSignature(body, signature, secret) {
  if (!signature || !secret) {
    console.error('[Paddle Webhook] Missing signature or secret');
    return false;
  }
  
  try {
    // Paddle Billing signature format: "ts=timestamp;h1=signature"
    // Extract the actual signature from the header
    let actualSignature = signature;
    if (signature.includes('h1=')) {
      const parts = signature.split(';');
      const h1Part = parts.find(part => part.startsWith('h1='));
      if (h1Part) {
        actualSignature = h1Part.substring(3); // Remove 'h1=' prefix
      }
    }
    
    // Paddle uses HMAC-SHA256 for signature verification
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    
    // Compare signatures (constant-time comparison to prevent timing attacks)
    return crypto.timingSafeEqual(
      Buffer.from(actualSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch (error) {
    console.error('[Paddle Webhook] Signature verification failed:', error);
    return false;
  }
}

/**
 * Process subscription created event
 */
async function handleSubscriptionCreated(data) {
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
    } = data;
    
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
    const paddlePlanId = items[0]?.price?.id;
    
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
      paddlePlanId,
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
async function handleSubscriptionUpdated(data) {
  const connection = await pool.getConnection();
  
  try {
    const {
      id: subscriptionId,
      status,
      current_billing_period,
      next_billed_at,
      canceled_at
    } = data;
    
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
async function handleTransactionCompleted(data) {
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
    } = data;
    
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
    const productId = items[0]?.price?.product?.id;
    
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
      productId,
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
async function handleSubscriptionRenewed(data) {
  const connection = await pool.getConnection();
  
  try {
    const {
      id: subscriptionId,
      current_billing_period,
      next_billed_at
    } = data;
    
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
router.post('/paddle', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['paddle-signature'];
    const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
      console.error('[Paddle Webhook] PADDLE_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    
        // Convert body to string for signature verification
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
    
    // Verify signature
    if (!verifyPaddleSignature(rawBody, signature, webhookSecret)) {
      console.error('[Paddle Webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody);
    const { event_type, data } = event;
    
    console.log(`[Paddle Webhook] Received event: ${event_type}`);
    
    // Process different event types
    switch (event_type) {
      case 'subscription.created':
        await handleSubscriptionCreated(data);
        break;
        
      case 'subscription.updated':
        await handleSubscriptionUpdated(data);
        break;
        
      case 'subscription.canceled':
        await handleSubscriptionUpdated(data); // Same logic as updated
        break;
        
      case 'transaction.completed':
        await handleTransactionCompleted(data);
        break;
        
      case 'subscription.payment_succeeded':
        await handleSubscriptionRenewed(data);
        break;
        
      case 'subscription.payment_failed':
        console.log(`[Paddle Webhook] Payment failed for subscription: ${data.id}`);
        // Could implement retry logic or notifications here
        break;
        
      default:
        console.log(`[Paddle Webhook] Unhandled event type: ${event_type}`);
    }
    
    // Always respond with 200 to acknowledge receipt
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('[Paddle Webhook] Error processing webhook:', error);
    
    // Return 500 to signal Paddle to retry
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

/**
 * Health check endpoint for webhook
 */
router.get('/paddle/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    webhookSecret: !!process.env.PADDLE_WEBHOOK_SECRET
  });
});

export default router; 
