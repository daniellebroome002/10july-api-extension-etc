import express from 'express';
import bodyParser from 'body-parser';
import { verify } from '../utils/paddleVerify.js';
import { addCredits } from '../services/billing.js';
import { pool } from '../db/init.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Price ID to credit mapping - using backend environment variables
const PRICE_TO_CREDITS = {
  // Credit packs
  [process.env.PADDLE_CREDIT_1K_PRICE_ID]: 1000,
  [process.env.PADDLE_CREDIT_5K_PRICE_ID]: 5000,
  [process.env.PADDLE_CREDIT_20K_PRICE_ID]: 20000,
  // Premium plans get monthly credits
  [process.env.PADDLE_PREMIUM_PRICE_ID]: 3000,
  [process.env.PADDLE_PREMIUM_PLUS_PRICE_ID]: 15000,
};

// Premium plan tier mapping
const PRICE_TO_TIER = {
  [process.env.PADDLE_PREMIUM_PRICE_ID]: 'premium',
  [process.env.PADDLE_PREMIUM_PLUS_PRICE_ID]: 'premium_plus',
};

// Raw body needed for signature verification
router.post('/paddle', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.get('Paddle-Signature');
    const isValid = verify(req.body, sig);
    
    if (!isValid) {
      console.error('Invalid Paddle webhook signature');
      return res.status(400).send('Invalid signature');
    }
    
    const event = JSON.parse(req.body);
    console.log('Received Paddle webhook event:', event.event_type);
    
    switch (event.event_type) {
      case 'payment.succeeded':
        await handlePaymentSucceeded(event.data);
        break;
        
      case 'subscription.created':
        await handleSubscriptionCreated(event.data);
        break;
        
      case 'subscription.updated':
        await handleSubscriptionUpdated(event.data);
        break;
        
      case 'subscription.canceled':
        await handleSubscriptionCanceled(event.data);
        break;
        
      case 'subscription.activated':
        await handleSubscriptionActivated(event.data);
        break;
        
      case 'transaction.paid':
        await handleTransactionPaid(event.data);
        break;
        
      case 'transaction.completed':
        await handleTransactionCompleted(event.data);
        break;
        
      case 'transaction.updated':
        // This is usually handled by other events, but we can log it
        console.log(`Transaction updated: ${event.data.id}`);
        break;
        
      default:
        console.log(`Unhandled webhook event type: ${event.event_type}`);
        console.log('Full event payload:', JSON.stringify(event, null, 2));
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Paddle webhook error:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// Helper to find user by Paddle customer_id
async function findUserIdByCustomerId(customerId) {
  if (!customerId) return null;
  
  // First, try to find user through existing subscriptions
  const [subRows] = await pool.query('SELECT user_id FROM subscriptions WHERE paddle_customer_id = ? ORDER BY created_at DESC LIMIT 1', [customerId]);
  if (subRows.length > 0) return subRows[0].user_id;
  
  // If no subscription found, this might be a new customer
  // We'll need to create a user record or find by other means
  // For now, return null and let the calling function handle it
  console.log(`No existing subscription found for customer_id: ${customerId}`);
  return null;
}

async function handlePaymentSucceeded(data) {
  try {
    let userId = null;
    let email = null;
    if (data.customer && data.customer.email) {
      email = data.customer.email;
      const [userRows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
      if (userRows.length > 0) userId = userRows[0].id;
    }
    if (!userId && data.customer_id) {
      userId = await findUserIdByCustomerId(data.customer_id);
    }
    if (!userId) {
      console.error('User not found for payment. Data:', JSON.stringify(data, null, 2));
      return;
    }
    // Process each item in the payment
    for (const item of data.items || []) {
      const priceId = item.price?.id || item.price_id;
      const quantity = item.quantity || 1;
      const creditsPerItem = PRICE_TO_CREDITS[priceId];
      if (creditsPerItem) {
        const totalCredits = creditsPerItem * quantity;
        addCredits(userId, totalCredits);
        console.log(`Added ${totalCredits} credits to user ${userId} for price ${priceId}`);
      } else {
        console.warn(`Unknown price ID in payment: ${priceId}`);
      }
    }
  } catch (error) {
    console.error('Failed to process payment succeeded:', error);
  }
}

async function handleSubscriptionCreated(data) {
  try {
    let userId = null;
    let email = null;
    
    // Try to find user by email first
    if (data.customer && data.customer.email) {
      email = data.customer.email;
      const [userRows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
      if (userRows.length > 0) userId = userRows[0].id;
    }
    
    // If no user found by email, try by customer_id
    if (!userId && data.customer_id) {
      userId = await findUserIdByCustomerId(data.customer_id);
    }
    
    // If still no user found, this might be a new customer
    // We'll create a temporary user record for now
    if (!userId && data.customer_id) {
      console.log(`Creating temporary user record for new customer: ${data.customer_id}`);
      
      // Create a temporary user with the customer_id as email (will be updated later)
      const tempEmail = `temp_${data.customer_id}@paddle.temp`;
      const generatedUserId = uuidv4();
      await pool.query(`
        INSERT INTO users (id, email, premium_tier, created_at) 
        VALUES (?, ?, 'free', NOW())
      `, [generatedUserId, tempEmail]);
      
      userId = generatedUserId;
      console.log(`Created temporary user ${userId} for customer ${data.customer_id}`);
    }
    
    if (!userId) {
      console.error('Could not create or find user for subscription. Data:', JSON.stringify(data, null, 2));
      return;
    }
    // Process subscription items
    for (const item of data.items || []) {
      const priceId = item.price?.id || item.price_id;
      const tier = PRICE_TO_TIER[priceId];
      if (tier) {
        // Update user's premium tier
        await pool.query('UPDATE users SET premium_tier = ? WHERE id = ?', [tier, userId]);
        // Insert subscription record in subscriptions table
        await pool.query(`
          INSERT INTO subscriptions (
            id, user_id, paddle_customer_id, plan_type, status,
            paddle_plan_id, currency_code, billing_cycle,
            monthly_credit_allowance, credits_reset_day,
            started_at, current_period_start, current_period_end,
            next_billed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            plan_type = VALUES(plan_type),
            updated_at = NOW()
        `, [
          data.id,
          userId,
          data.customer_id || null,
          tier,
          data.status || 'active',
          priceId,
          data.currency_code || 'USD',
          JSON.stringify(data.billing_cycle || { frequency: 'monthly', interval: 1 }),
          PRICE_TO_CREDITS[priceId] || 0,
          1, // credits reset on 1st of month
          data.started_at || new Date().toISOString(),
          data.current_billing_period?.starts_at || new Date().toISOString(),
          data.current_billing_period?.ends_at || new Date(Date.now() + 30*24*60*60*1000).toISOString(),
          data.next_billed_at || null
        ]);
        // Add initial monthly credits
        const monthlyCredits = PRICE_TO_CREDITS[priceId];
        if (monthlyCredits) {
          addCredits(userId, monthlyCredits);
          console.log(`Added ${monthlyCredits} monthly credits to user ${userId} for new subscription`);
        }
        console.log(`Created subscription ${data.id} for user ${userId} with tier ${tier}`);
      }
    }
  } catch (error) {
    console.error('Failed to process subscription created:', error);
  }
}

async function handleSubscriptionUpdated(data) {
  try {
    // Update subscription record in subscriptions table
    await pool.query(`
      UPDATE subscriptions 
      SET status = ?, current_period_start = ?, current_period_end = ?, 
          next_billed_at = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      data.status,
      data.current_period_start || null,
      data.current_period_end || null,
      data.next_billed_at || null,
      data.id
    ]);
    
    // If subscription is no longer active, downgrade user
    if (data.status === 'canceled' || data.status === 'past_due') {
      // Get user ID from subscription
      const [subRows] = await pool.query(
        'SELECT user_id FROM subscriptions WHERE id = ?',
        [data.id]
      );
      
      if (subRows.length > 0) {
        const userId = subRows[0].user_id;
        await pool.query(
          'UPDATE users SET premium_tier = ? WHERE id = ?',
          ['free', userId]
        );
        console.log(`Downgraded user ${userId} to free tier due to subscription status: ${data.status}`);
      }
    }
    
    console.log(`Updated subscription ${data.id} with status: ${data.status}`);
  } catch (error) {
    console.error('Failed to process subscription updated:', error);
  }
}

async function handleSubscriptionCanceled(data) {
  try {
    // Update subscription status in subscriptions table
    await pool.query(`
      UPDATE subscriptions 
      SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
      WHERE id = ?
    `, [data.id]);
    
    // Get user ID and downgrade to free tier
    const [subRows] = await pool.query(
      'SELECT user_id FROM subscriptions WHERE id = ?',
      [data.id]
    );
    
    if (subRows.length > 0) {
      const userId = subRows[0].user_id;
      await pool.query(
        'UPDATE users SET premium_tier = ? WHERE id = ?',
        ['free', userId]
      );
      console.log(`Downgraded user ${userId} to free tier due to subscription cancellation`);
    }
    
    console.log(`Canceled subscription ${data.id}`);
  } catch (error) {
    console.error('Failed to process subscription canceled:', error);
  }
}

async function handleSubscriptionActivated(data) {
  try {
    // This is similar to subscription.created but for when a subscription becomes active
    let userId = null;
    
    // Try to find user by email first
    if (data.customer && data.customer.email) {
      const [userRows] = await pool.query('SELECT id FROM users WHERE email = ?', [data.customer.email]);
      if (userRows.length > 0) userId = userRows[0].id;
    }
    
    // If no user found by email, try by customer_id
    if (!userId && data.customer_id) {
      userId = await findUserIdByCustomerId(data.customer_id);
    }
    
    // If still no user found, this might be a new customer
    if (!userId && data.customer_id) {
      console.log(`Creating temporary user record for new customer activation: ${data.customer_id}`);
      
      // Create a temporary user with the customer_id as email (will be updated later)
      const tempEmail = `temp_${data.customer_id}@paddle.temp`;
      const generatedUserId = uuidv4();
      await pool.query(`
        INSERT INTO users (id, email, premium_tier, created_at) 
        VALUES (?, ?, 'free', NOW())
      `, [generatedUserId, tempEmail]);
      
      userId = generatedUserId;
      console.log(`Created temporary user ${userId} for customer activation ${data.customer_id}`);
    }
    
    if (!userId) {
      console.error('Could not create or find user for subscription activation. Data:', JSON.stringify(data, null, 2));
      return;
    }
    
    // Process subscription items
    for (const item of data.items || []) {
      const priceId = item.price?.id || item.price_id;
      const tier = PRICE_TO_TIER[priceId];
      if (tier) {
        // Update user's premium tier
        await pool.query('UPDATE users SET premium_tier = ? WHERE id = ?', [tier, userId]);
        
        // Update or insert subscription record
        await pool.query(`
          INSERT INTO subscriptions (
            id, user_id, paddle_customer_id, plan_type, status,
            paddle_plan_id, currency_code, billing_cycle,
            monthly_credit_allowance, credits_reset_day,
            started_at, current_period_start, current_period_end,
            next_billed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            plan_type = VALUES(plan_type),
            current_period_start = VALUES(current_period_start),
            current_period_end = VALUES(current_period_end),
            next_billed_at = VALUES(next_billed_at),
            updated_at = NOW()
        `, [
          data.id,
          userId,
          data.customer_id || null,
          tier,
          data.status || 'active',
          priceId,
          data.currency_code || 'USD',
          JSON.stringify(data.billing_cycle || { frequency: 'monthly', interval: 1 }),
          PRICE_TO_CREDITS[priceId] || 0,
          1, // credits reset on 1st of month
          data.started_at || new Date().toISOString(),
          data.current_billing_period?.starts_at || new Date().toISOString(),
          data.current_billing_period?.ends_at || new Date(Date.now() + 30*24*60*60*1000).toISOString(),
          data.next_billed_at || null
        ]);
        
        // Add monthly credits for activated subscription
        const monthlyCredits = PRICE_TO_CREDITS[priceId];
        if (monthlyCredits) {
          addCredits(userId, monthlyCredits);
          console.log(`Added ${monthlyCredits} monthly credits to user ${userId} for activated subscription`);
        }
        
        console.log(`Activated subscription ${data.id} for user ${userId} with tier ${tier}`);
      }
    }
  } catch (error) {
    console.error('Failed to process subscription activated:', error);
  }
}

async function handleTransactionPaid(data) {
  try {
    // For transaction.paid, we need to handle one-time purchases (credit topups)
    // This is different from subscription payments which are handled by subscription events
    
    let userId = null;
    if (data.customer_id) {
      userId = await findUserIdByCustomerId(data.customer_id);
    }
    
    // If no user found, this might be a new customer making a one-time purchase
    if (!userId && data.customer_id) {
      console.log(`Creating temporary user record for new customer transaction: ${data.customer_id}`);
      
      // Create a temporary user with the customer_id as email (will be updated later)
      const tempEmail = `temp_${data.customer_id}@paddle.temp`;
      const generatedUserId = uuidv4();
      await pool.query(`
        INSERT INTO users (id, email, premium_tier, created_at) 
        VALUES (?, ?, 'free', NOW())
      `, [generatedUserId, tempEmail]);
      
      userId = generatedUserId;
      console.log(`Created temporary user ${userId} for customer transaction ${data.customer_id}`);
    }
    
    if (!userId) {
      console.error('Could not create or find user for transaction paid. Data:', JSON.stringify(data, null, 2));
      return;
    }
    
    // Check if this is a one-time purchase (not a subscription)
    if (!data.subscription_id) {
      // Process each item as a one-time credit purchase
      for (const item of data.items || []) {
        const priceId = item.price?.id || item.price_id;
        const quantity = item.quantity || 1;
        const creditsPerItem = PRICE_TO_CREDITS[priceId];
        
        if (creditsPerItem) {
          const totalCredits = creditsPerItem * quantity;
          
          // Record the credit topup
          await pool.query(`
            INSERT INTO credit_topups (
              id, user_id, paddle_transaction_id, paddle_customer_id, paddle_product_id,
              credits_purchased, credits_applied, amount_paid, currency_code, payment_status,
              purchased_at, completed_at, applied_at
            ) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, NOW(), NOW())
          `, [
            userId,
            data.id,
            data.customer_id,
            item.product?.id || 'unknown',
            totalCredits,
            totalCredits,
            data.details?.totals?.total || 0,
            data.currency_code || 'USD',
            data.created_at || new Date().toISOString()
          ]);
          
          // Add credits to user balance
          addCredits(userId, totalCredits);
          console.log(`Added ${totalCredits} credits to user ${userId} for one-time purchase ${data.id}`);
        }
      }
    }
  } catch (error) {
    console.error('Failed to process transaction paid:', error);
  }
}

async function handleTransactionCompleted(data) {
  try {
    // This is similar to transaction.paid but for completed transactions
    // Usually this is the final state after transaction.paid
    console.log(`Transaction completed: ${data.id} for customer ${data.customer_id}`);
    
    // For now, we'll just log it since the main processing happens in transaction.paid
    // You can add additional logic here if needed
  } catch (error) {
    console.error('Failed to process transaction completed:', error);
  }
}

export default router; 
