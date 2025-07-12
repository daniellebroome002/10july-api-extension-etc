// paddleWebhook.js - Paddle Webhook Handler
import express from 'express';
import { 
  verifyPaddleSignature, 
  parsePaddleWebhookEvent, 
  extractUserIdFromEvent,
  determinePlanType,
  getCreditAmountForProduct,
  isEventDuplicate,
  logWebhookEvent
} from '../utils/paddleVerify.js';
import { 
  createOrUpdateSubscription, 
  recordCreditTopup,
  addCredits,
  getUserSubscription
} from '../services/billing.js';
import { pool } from '../db/init.js';

const router = express.Router();

// Middleware to capture raw body for signature verification
router.use('/paddle', express.raw({ type: 'application/json' }));

/**
 * Main Paddle webhook endpoint
 */
router.post('/paddle', async (req, res) => {
  try {
    const signature = req.headers['paddle-signature'];
    const rawBody = req.body.toString('utf8');
    const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
    
    // Verify signature
    if (!verifyPaddleSignature(rawBody, signature, webhookSecret)) {
      console.error('Invalid Paddle webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Parse event data
    const eventData = parsePaddleWebhookEvent(rawBody);
    
    // Check for duplicate events
    if (isEventDuplicate(eventData.eventId)) {
      console.log(`Duplicate webhook event ignored: ${eventData.eventId}`);
      return res.status(200).json({ success: true, message: 'Duplicate event ignored' });
    }
    
    // Process event based on type
    let result = { success: true };
    
    switch (eventData.eventType) {
      case 'subscription.created':
        result = await handleSubscriptionCreated(eventData);
        break;
        
      case 'subscription.updated':
        result = await handleSubscriptionUpdated(eventData);
        break;
        
      case 'subscription.canceled':
        result = await handleSubscriptionCanceled(eventData);
        break;
        
      case 'subscription.past_due':
        result = await handleSubscriptionPastDue(eventData);
        break;
        
      case 'subscription.paused':
        result = await handleSubscriptionPaused(eventData);
        break;
        
      case 'subscription.resumed':
        result = await handleSubscriptionResumed(eventData);
        break;
        
      case 'transaction.completed':
        result = await handleTransactionCompleted(eventData);
        break;
        
      case 'transaction.payment_failed':
        result = await handleTransactionPaymentFailed(eventData);
        break;
        
      default:
        console.log(`Unhandled webhook event type: ${eventData.eventType}`);
        result = { success: true, message: 'Event type not handled' };
    }
    
    // Log the event processing result
    logWebhookEvent(eventData, result.success ? 'success' : 'failed');
    
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Paddle webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * Handle subscription created event
 */
async function handleSubscriptionCreated(eventData) {
  try {
    const subscriptionData = eventData.data;
    const userId = extractUserIdFromEvent(eventData);
    
    if (!userId) {
      throw new Error('User ID not found in subscription data');
    }
    
    // Determine plan type from price ID
    const priceId = subscriptionData.items[0]?.price?.id;
    const planType = determinePlanType(priceId);
    
    if (planType === 'unknown') {
      throw new Error(`Unknown plan type for price ID: ${priceId}`);
    }
    
    // Map plan type to credit allowance
    const creditAllowances = {
      'premium': 3000,
      'premium_plus': 15000
    };
    
    const subscriptionRecord = {
      id: subscriptionData.id,
      user_id: userId,
      paddle_customer_id: subscriptionData.customer_id,
      plan_type: planType,
      status: subscriptionData.status,
      paddle_plan_id: priceId,
      currency_code: subscriptionData.currency_code,
      billing_cycle: subscriptionData.billing_cycle,
      monthly_credit_allowance: creditAllowances[planType],
      started_at: subscriptionData.started_at,
      current_period_start: subscriptionData.current_billing_period.starts_at,
      current_period_end: subscriptionData.current_billing_period.ends_at,
      next_billed_at: subscriptionData.next_billed_at
    };
    
    await createOrUpdateSubscription(subscriptionRecord);
    
    console.log(`Subscription created: ${subscriptionData.id} for user ${userId}`);
    return { success: true, message: 'Subscription created successfully' };
    
  } catch (error) {
    console.error('Error handling subscription created:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle subscription updated event
 */
async function handleSubscriptionUpdated(eventData) {
  try {
    const subscriptionData = eventData.data;
    const userId = extractUserIdFromEvent(eventData);
    
    if (!userId) {
      throw new Error('User ID not found in subscription data');
    }
    
    // Get current subscription from database
    const existingSubscription = await getUserSubscription(userId);
    
    if (!existingSubscription) {
      throw new Error('Subscription not found in database');
    }
    
    // Determine plan type from price ID
    const priceId = subscriptionData.items[0]?.price?.id;
    const planType = determinePlanType(priceId);
    
    const creditAllowances = {
      'premium': 3000,
      'premium_plus': 15000
    };
    
    const subscriptionRecord = {
      id: subscriptionData.id,
      user_id: userId,
      paddle_customer_id: subscriptionData.customer_id,
      plan_type: planType,
      status: subscriptionData.status,
      paddle_plan_id: priceId,
      currency_code: subscriptionData.currency_code,
      billing_cycle: subscriptionData.billing_cycle,
      monthly_credit_allowance: creditAllowances[planType] || 0,
      started_at: subscriptionData.started_at,
      current_period_start: subscriptionData.current_billing_period.starts_at,
      current_period_end: subscriptionData.current_billing_period.ends_at,
      next_billed_at: subscriptionData.next_billed_at
    };
    
    await createOrUpdateSubscription(subscriptionRecord);
    
    console.log(`Subscription updated: ${subscriptionData.id} for user ${userId}`);
    return { success: true, message: 'Subscription updated successfully' };
    
  } catch (error) {
    console.error('Error handling subscription updated:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle subscription canceled event
 */
async function handleSubscriptionCanceled(eventData) {
  try {
    const subscriptionData = eventData.data;
    const userId = extractUserIdFromEvent(eventData);
    
    if (!userId) {
      throw new Error('User ID not found in subscription data');
    }
    
    // Update subscription status
    await pool.query(
      'UPDATE subscriptions SET status = ?, canceled_at = NOW() WHERE id = ?',
      ['canceled', subscriptionData.id]
    );
    
    // Update user's premium tier to free
    await pool.query(
      'UPDATE users SET premium_tier = ? WHERE id = ?',
      ['free', userId]
    );
    
    console.log(`Subscription canceled: ${subscriptionData.id} for user ${userId}`);
    return { success: true, message: 'Subscription canceled successfully' };
    
  } catch (error) {
    console.error('Error handling subscription canceled:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle subscription past due event
 */
async function handleSubscriptionPastDue(eventData) {
  try {
    const subscriptionData = eventData.data;
    
    await pool.query(
      'UPDATE subscriptions SET status = ? WHERE id = ?',
      ['past_due', subscriptionData.id]
    );
    
    console.log(`Subscription past due: ${subscriptionData.id}`);
    return { success: true, message: 'Subscription marked as past due' };
    
  } catch (error) {
    console.error('Error handling subscription past due:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle subscription paused event
 */
async function handleSubscriptionPaused(eventData) {
  try {
    const subscriptionData = eventData.data;
    
    await pool.query(
      'UPDATE subscriptions SET status = ? WHERE id = ?',
      ['paused', subscriptionData.id]
    );
    
    console.log(`Subscription paused: ${subscriptionData.id}`);
    return { success: true, message: 'Subscription paused successfully' };
    
  } catch (error) {
    console.error('Error handling subscription paused:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle subscription resumed event
 */
async function handleSubscriptionResumed(eventData) {
  try {
    const subscriptionData = eventData.data;
    
    await pool.query(
      'UPDATE subscriptions SET status = ? WHERE id = ?',
      ['active', subscriptionData.id]
    );
    
    console.log(`Subscription resumed: ${subscriptionData.id}`);
    return { success: true, message: 'Subscription resumed successfully' };
    
  } catch (error) {
    console.error('Error handling subscription resumed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle transaction completed event (for credit topups)
 */
async function handleTransactionCompleted(eventData) {
  try {
    const transactionData = eventData.data;
    const userId = extractUserIdFromEvent(eventData);
    
    if (!userId) {
      throw new Error('User ID not found in transaction data');
    }
    
    // Check if this is a credit topup transaction
    const customData = transactionData.custom_data || {};
    
    if (customData.type === 'credit_topup') {
      // Get product ID from transaction items
      const productId = transactionData.items[0]?.price?.product_id;
      const creditAmount = getCreditAmountForProduct(productId);
      
      if (creditAmount === 0) {
        throw new Error(`Unknown credit product: ${productId}`);
      }
      
      // Record credit topup
      const topupRecord = {
        user_id: userId,
        paddle_transaction_id: transactionData.id,
        paddle_customer_id: transactionData.customer_id,
        paddle_product_id: productId,
        credits_purchased: creditAmount,
        credits_applied: creditAmount,
        amount_paid: transactionData.details.totals.total,
        currency_code: transactionData.currency_code,
        payment_status: 'completed',
        purchased_at: transactionData.created_at,
        completed_at: transactionData.updated_at,
        applied_at: new Date().toISOString()
      };
      
      await recordCreditTopup(topupRecord);
      
      console.log(`Credit topup completed: ${creditAmount} credits for user ${userId}`);
      return { success: true, message: 'Credit topup processed successfully' };
    }
    
    // Regular subscription transaction - log for reference
    console.log(`Subscription transaction completed: ${transactionData.id}`);
    return { success: true, message: 'Transaction completed' };
    
  } catch (error) {
    console.error('Error handling transaction completed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle transaction payment failed event
 */
async function handleTransactionPaymentFailed(eventData) {
  try {
    const transactionData = eventData.data;
    const userId = extractUserIdFromEvent(eventData);
    
    // Log payment failure
    console.log(`Payment failed for user ${userId}: ${transactionData.id}`);
    
    // If it's a credit topup, mark as failed
    const customData = transactionData.custom_data || {};
    if (customData.type === 'credit_topup') {
      // Update topup record if it exists
      await pool.query(
        'UPDATE credit_topups SET payment_status = ? WHERE paddle_transaction_id = ?',
        ['failed', transactionData.id]
      );
    }
    
    return { success: true, message: 'Payment failure processed' };
    
  } catch (error) {
    console.error('Error handling transaction payment failed:', error);
    return { success: false, error: error.message };
  }
}

export default router; 