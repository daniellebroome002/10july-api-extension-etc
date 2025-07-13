import express from 'express';
import bodyParser from 'body-parser';
import { verify } from '../utils/paddleVerify.js';
import { addCredits } from '../services/billing.js';
import { pool } from '../db/init.js';

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
        
      default:
        console.log(`Unhandled webhook event type: ${event.event_type}`);
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Paddle webhook error:', error);
    res.status(500).send('Webhook processing failed');
  }
});

async function handlePaymentSucceeded(data) {
  try {
    const { customer, items } = data;
    
    // Find user by customer email
    const [userRows] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [customer.email]
    );
    
    if (userRows.length === 0) {
      console.error('User not found for payment:', customer.email);
      return;
    }
    
    const userId = userRows[0].id;
    
    // Process each item in the payment
    for (const item of items) {
      const priceId = item.price.id;
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
    const { customer, items } = data;
    
    // Find user by customer email
    const [userRows] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [customer.email]
    );
    
    if (userRows.length === 0) {
      console.error('User not found for subscription:', customer.email);
      return;
    }
    
    const userId = userRows[0].id;
    
    // Process subscription items
    for (const item of items) {
      const priceId = item.price.id;
      const tier = PRICE_TO_TIER[priceId];
      
      if (tier) {
        // Update user's premium tier
        await pool.query(
          'UPDATE users SET premium_tier = ? WHERE id = ?',
          [tier, userId]
        );
        
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
          customer.id,
          tier,
          data.status || 'active',
          priceId,
          data.currency_code || 'USD',
          JSON.stringify(data.billing_cycle || { frequency: 'monthly', interval: 1 }),
          PRICE_TO_CREDITS[priceId] || 0,
          1, // credits reset on 1st of month
          data.started_at || new Date().toISOString(),
          data.current_period_start || new Date().toISOString(),
          data.current_period_end || new Date(Date.now() + 30*24*60*60*1000).toISOString(),
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

export default router; 
