import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import nowPaymentsService from '../../services/billing/nowPaymentsService.js';
import creditManager from '../../services/billing/creditManager.js';
import { pool } from '../../db/init.js';

const router = express.Router();

// Raw body parser middleware for signature verification
router.use('/webhook', express.raw({ type: 'application/json' }));

/**
 * NOWPayments webhook endpoint
 */
router.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  let webhookId = uuidv4();
  
  try {
    // Parse webhook payload
    const payload = JSON.parse(req.body.toString());
    const signature = req.headers['x-nowpayments-sig'] || req.headers['x-signature'];
    
    console.log('NOWPayments webhook received:', {
      webhookId,
      eventType: payload.payment_status || 'unknown',
      paymentId: payload.payment_id,
      subscriptionId: payload.subscription_id,
      orderId: payload.order_id
    });
    
    // Verify webhook signature
    if (!nowPaymentsService.verifyWebhookSignature(payload, signature)) {
      console.error('Invalid webhook signature:', { webhookId, signature });
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Store webhook event for debugging and idempotency
    webhookId = await storeWebhookEvent(payload, signature);
    
    // Check if already processed (idempotency)
    const existingEvent = await getWebhookEvent(webhookId);
    if (existingEvent && existingEvent.processed) {
      console.log('Webhook already processed:', { webhookId });
      return res.status(200).json({ status: 'already_processed' });
    }
    
    // Process webhook based on type
    let processResult;
    if (payload.subscription_id) {
      processResult = await processSubscriptionWebhook(payload, webhookId);
    } else if (payload.payment_id) {
      processResult = await processPaymentWebhook(payload, webhookId);
    } else {
      throw new Error('Unknown webhook type - no subscription_id or payment_id');
    }
    
    // Mark webhook as processed
    await markWebhookProcessed(webhookId, processResult);
    
    const processingTime = Date.now() - startTime;
    console.log('Webhook processed successfully:', {
      webhookId,
      processingTime: `${processingTime}ms`,
      result: processResult
    });
    
    res.status(200).json({
      status: 'success',
      webhookId,
      processingTime,
      result: processResult
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Webhook processing error:', {
      webhookId,
      error: error.message,
      stack: error.stack,
      processingTime: `${processingTime}ms`
    });
    
    // Store error for debugging
    await storeWebhookError(webhookId, error);
    
    // Return 500 to trigger NOWPayments retry
    res.status(500).json({
      error: 'Webhook processing failed',
      webhookId,
      message: error.message
    });
  }
});

// ==================== SUBSCRIPTION WEBHOOK PROCESSING ====================

/**
 * Process subscription-related webhooks
 * @param {Object} payload - Webhook payload
 * @param {string} webhookId - Webhook ID
 * @returns {Object} Processing result
 */
async function processSubscriptionWebhook(payload, webhookId) {
  const { subscription_id, payment_status, outcome, customer_email } = payload;
  
  console.log('Processing subscription webhook:', {
    webhookId,
    subscriptionId: subscription_id,
    paymentStatus: payment_status,
    outcome
  });
  
  // Get subscription from database
  const subscription = await getSubscriptionById(subscription_id);
  if (!subscription) {
    throw new Error(`Subscription not found: ${subscription_id}`);
  }
  
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    let result = { action: 'none', subscription: subscription_id };
    
    switch (payment_status) {
      case 'finished':
      case 'confirmed':
        // Subscription payment successful
        result = await activateSubscription(connection, subscription, payload);
        break;
        
      case 'expired':
      case 'failed':
        // Subscription payment failed
        result = await handleSubscriptionPaymentFailure(connection, subscription, payload);
        break;
        
      case 'partially_paid':
        // Partial payment - keep as pending
        await updateSubscriptionStatus(connection, subscription_id, 'pending');
        result = { action: 'partial_payment', subscription: subscription_id };
        break;
        
      default:
        console.log('Unhandled subscription payment status:', payment_status);
        result = { action: 'unhandled', status: payment_status };
    }
    
    await connection.commit();
    return result;
    
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Activate subscription after successful payment
 */
async function activateSubscription(connection, subscription, payload) {
  const userId = subscription.user_id;
  const planType = subscription.plan_type;
  
  // Update subscription status
  await connection.execute(`
    UPDATE nowpayments_subscriptions 
    SET status = 'active', 
        last_payment_date = NOW(),
        next_billing_date = DATE_ADD(NOW(), INTERVAL 30 DAY),
        pay_currency = ?,
        updated_at = NOW()
    WHERE id = ?
  `, [payload.pay_currency || null, subscription.id]);
  
  // Initialize monthly usage for this user
  const monthYear = new Date().toISOString().slice(0, 7);
  await connection.execute(`
    INSERT INTO monthly_usage (
      user_id, month_year, subscription_allowance, allowance_reset_at
    ) VALUES (?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      subscription_allowance = VALUES(subscription_allowance),
      allowance_reset_at = NOW()
  `, [userId, monthYear, subscription.monthly_credits]);
  
  // Update user tier in users table
  await connection.execute(
    'UPDATE users SET premium_tier = ? WHERE id = ?',
    [planType, userId]
  );
  
  // Clear caches
  creditManager.subscriptionCache.del(`subscription_${userId}`);
  creditManager.monthlyUsageCache.del(`usage_${userId}_${monthYear}`);
  
  console.log('Subscription activated:', {
    userId,
    subscriptionId: subscription.id,
    planType,
    monthlyCredits: subscription.monthly_credits
  });
  
  return {
    action: 'subscription_activated',
    subscription: subscription.id,
    user: userId,
    plan: planType,
    monthlyCredits: subscription.monthly_credits
  };
}

/**
 * Handle subscription payment failure
 */
async function handleSubscriptionPaymentFailure(connection, subscription, payload) {
  // Mark subscription as expired
  await connection.execute(`
    UPDATE nowpayments_subscriptions 
    SET status = 'expired',
        updated_at = NOW()
    WHERE id = ?
  `, [subscription.id]);
  
  // Downgrade user to free tier
  await connection.execute(
    'UPDATE users SET premium_tier = ? WHERE id = ?',
    ['free', subscription.user_id]
  );
  
  // Clear caches
  creditManager.subscriptionCache.del(`subscription_${subscription.user_id}`);
  
  console.log('Subscription expired due to payment failure:', {
    userId: subscription.user_id,
    subscriptionId: subscription.id
  });
  
  return {
    action: 'subscription_expired',
    subscription: subscription.id,
    user: subscription.user_id,
    reason: 'payment_failure'
  };
}

// ==================== PAYMENT WEBHOOK PROCESSING ====================

/**
 * Process payment-related webhooks (credit purchases)
 * @param {Object} payload - Webhook payload
 * @param {string} webhookId - Webhook ID
 * @returns {Object} Processing result
 */
async function processPaymentWebhook(payload, webhookId) {
  const { payment_id, payment_status, outcome, order_id, pay_amount, pay_currency } = payload;
  
  console.log('Processing payment webhook:', {
    webhookId,
    paymentId: payment_id,
    paymentStatus: payment_status,
    outcome,
    orderId: order_id
  });
  
  // Get credit purchase from database
  const purchase = await getCreditPurchaseByOrderId(order_id) || 
                   await getCreditPurchaseByPaymentId(payment_id);
  
  if (!purchase) {
    throw new Error(`Credit purchase not found: order_id=${order_id}, payment_id=${payment_id}`);
  }
  
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    let result = { action: 'none', purchase: purchase.id };
    
    switch (payment_status) {
      case 'finished':
      case 'confirmed':
        // Payment successful - add credits
        result = await completeCreditPurchase(connection, purchase, payload);
        break;
        
      case 'expired':
      case 'failed':
        // Payment failed
        result = await failCreditPurchase(connection, purchase, payload);
        break;
        
      case 'refunded':
        // Payment refunded - remove credits
        result = await refundCreditPurchase(connection, purchase, payload);
        break;
        
      case 'partially_paid':
        // Partial payment - update status but don't add credits yet
        await updateCreditPurchaseStatus(connection, purchase.id, 'partially_paid', payload);
        result = { action: 'partial_payment', purchase: purchase.id };
        break;
        
      default:
        console.log('Unhandled payment status:', payment_status);
        result = { action: 'unhandled', status: payment_status };
    }
    
    await connection.commit();
    return result;
    
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Complete credit purchase and add credits to user
 */
async function completeCreditPurchase(connection, purchase, payload) {
  const userId = purchase.user_id;
  const credits = purchase.credits_purchased;
  
  // Update purchase status
  await connection.execute(`
    UPDATE credit_purchases 
    SET status = 'finished',
        pay_amount = ?,
        pay_currency = ?,
        payment_status = ?,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ?
  `, [
    payload.pay_amount || null,
    payload.pay_currency || null,
    payload.payment_status,
    purchase.id
  ]);
  
  // Add credits to user wallet
  await connection.execute(
    'UPDATE users SET credit_balance = credit_balance + ? WHERE id = ?',
    [credits, userId]
  );
  
  // Clear credit balance cache
  creditManager.creditWalletCache.del(`balance_${userId}`);
  
  console.log('Credit purchase completed:', {
    userId,
    purchaseId: purchase.id,
    credits,
    paymentId: payload.payment_id
  });
  
  return {
    action: 'credits_added',
    purchase: purchase.id,
    user: userId,
    credits,
    paymentId: payload.payment_id
  };
}

/**
 * Fail credit purchase
 */
async function failCreditPurchase(connection, purchase, payload) {
  await connection.execute(`
    UPDATE credit_purchases 
    SET status = 'failed',
        payment_status = ?,
        updated_at = NOW()
    WHERE id = ?
  `, [payload.payment_status, purchase.id]);
  
  console.log('Credit purchase failed:', {
    userId: purchase.user_id,
    purchaseId: purchase.id,
    paymentId: payload.payment_id
  });
  
  return {
    action: 'purchase_failed',
    purchase: purchase.id,
    user: purchase.user_id,
    reason: payload.payment_status
  };
}

/**
 * Handle credit purchase refund
 */
async function refundCreditPurchase(connection, purchase, payload) {
  const userId = purchase.user_id;
  const credits = purchase.credits_purchased;
  
  // Update purchase status
  await connection.execute(`
    UPDATE credit_purchases 
    SET status = 'refunded',
        payment_status = ?,
        updated_at = NOW()
    WHERE id = ?
  `, [payload.payment_status, purchase.id]);
  
  // Remove credits from user wallet (if they have enough)
  const [userRows] = await connection.execute(
    'SELECT credit_balance FROM users WHERE id = ?',
    [userId]
  );
  
  if (userRows.length > 0) {
    const currentBalance = userRows[0].credit_balance || 0;
    const newBalance = Math.max(0, currentBalance - credits);
    
    await connection.execute(
      'UPDATE users SET credit_balance = ? WHERE id = ?',
      [newBalance, userId]
    );
    
    // Clear credit balance cache
    creditManager.creditWalletCache.del(`balance_${userId}`);
  }
  
  console.log('Credit purchase refunded:', {
    userId,
    purchaseId: purchase.id,
    creditsRemoved: credits,
    paymentId: payload.payment_id
  });
  
  return {
    action: 'credits_refunded',
    purchase: purchase.id,
    user: userId,
    credits,
    paymentId: payload.payment_id
  };
}

// ==================== DATABASE HELPERS ====================

/**
 * Store webhook event
 */
async function storeWebhookEvent(payload, signature) {
  const webhookId = payload.payment_id ? 
    `webhook_${payload.payment_id}_${Date.now()}` :
    `webhook_${payload.subscription_id}_${Date.now()}`;
  
  try {
    await pool.execute(`
      INSERT INTO nowpayments_webhooks (
        id, payment_id, subscription_id, order_id,
        event_type, payment_status, outcome,
        payload, signature_verified, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      webhookId,
      payload.payment_id || null,
      payload.subscription_id || null,
      payload.order_id || null,
      payload.payment_status || 'unknown',
      payload.payment_status || null,
      payload.outcome || null,
      JSON.stringify(payload),
      true
    ]);
    
    return webhookId;
  } catch (error) {
    console.error('Error storing webhook event:', error);
    return webhookId; // Return ID even if storage fails
  }
}

/**
 * Get webhook event
 */
async function getWebhookEvent(webhookId) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM nowpayments_webhooks WHERE id = ?',
      [webhookId]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting webhook event:', error);
    return null;
  }
}

/**
 * Mark webhook as processed
 */
async function markWebhookProcessed(webhookId, result) {
  try {
    await pool.execute(`
      UPDATE nowpayments_webhooks 
      SET processed = TRUE, 
          processed_at = NOW(),
          processing_error = NULL
      WHERE id = ?
    `, [webhookId]);
  } catch (error) {
    console.error('Error marking webhook as processed:', error);
  }
}

/**
 * Store webhook processing error
 */
async function storeWebhookError(webhookId, error) {
  try {
    await pool.execute(`
      UPDATE nowpayments_webhooks 
      SET processing_error = ?,
          retry_count = retry_count + 1
      WHERE id = ?
    `, [error.message, webhookId]);
  } catch (err) {
    console.error('Error storing webhook error:', err);
  }
}

/**
 * Get subscription by ID
 */
async function getSubscriptionById(subscriptionId) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM nowpayments_subscriptions WHERE id = ?',
      [subscriptionId]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting subscription:', error);
    return null;
  }
}

/**
 * Get credit purchase by order ID
 */
async function getCreditPurchaseByOrderId(orderId) {
  if (!orderId) return null;
  
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM credit_purchases WHERE order_id = ?',
      [orderId]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting credit purchase by order ID:', error);
    return null;
  }
}

/**
 * Get credit purchase by payment ID
 */
async function getCreditPurchaseByPaymentId(paymentId) {
  if (!paymentId) return null;
  
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM credit_purchases WHERE nowpayments_payment_id = ?',
      [paymentId]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting credit purchase by payment ID:', error);
    return null;
  }
}

/**
 * Update subscription status
 */
async function updateSubscriptionStatus(connection, subscriptionId, status) {
  await connection.execute(
    'UPDATE nowpayments_subscriptions SET status = ?, updated_at = NOW() WHERE id = ?',
    [status, subscriptionId]
  );
}

/**
 * Update credit purchase status
 */
async function updateCreditPurchaseStatus(connection, purchaseId, status, payload) {
  await connection.execute(`
    UPDATE credit_purchases 
    SET status = ?,
        payment_status = ?,
        pay_amount = ?,
        pay_currency = ?,
        updated_at = NOW()
    WHERE id = ?
  `, [
    status,
    payload.payment_status || null,
    payload.pay_amount || null,
    payload.pay_currency || null,
    purchaseId
  ]);
}

export default router; 