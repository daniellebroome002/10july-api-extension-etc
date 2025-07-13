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
    
    // Update user's subscription and tier
    for (const item of items) {
      const priceId = item.price.id;
      const tier = PRICE_TO_TIER[priceId];
      
      if (tier) {
        await pool.query(
          'UPDATE users SET subscription_id = ?, premium_tier = ? WHERE id = ?',
          [data.id, tier, userId]
        );
        
        // Add initial monthly credits
        const monthlyCredits = PRICE_TO_CREDITS[priceId];
        if (monthlyCredits) {
          addCredits(userId, monthlyCredits);
          console.log(`Added ${monthlyCredits} monthly credits to user ${userId} for new subscription`);
        }
        
        console.log(`Updated user ${userId} to tier ${tier} with subscription ${data.id}`);
      }
    }
  } catch (error) {
    console.error('Failed to process subscription created:', error);
  }
}

async function handleSubscriptionUpdated(data) {
  try {
    const { customer } = data;
    
    // Find user by customer email
    const [userRows] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [customer.email]
    );
    
    if (userRows.length === 0) {
      console.error('User not found for subscription update:', customer.email);
      return;
    }
    
    const userId = userRows[0].id;
    
    // Update subscription status based on the new status
    if (data.status === 'active') {
      console.log(`Subscription ${data.id} is active for user ${userId}`);
    } else if (data.status === 'canceled' || data.status === 'past_due') {
      // Downgrade user to free tier
      await pool.query(
        'UPDATE users SET subscription_id = NULL, premium_tier = ? WHERE id = ?',
        ['free', userId]
      );
      console.log(`Downgraded user ${userId} to free tier due to subscription status: ${data.status}`);
    }
  } catch (error) {
    console.error('Failed to process subscription updated:', error);
  }
}

async function handleSubscriptionCanceled(data) {
  try {
    const { customer } = data;
    
    // Find user by customer email
    const [userRows] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [customer.email]
    );
    
    if (userRows.length === 0) {
      console.error('User not found for subscription cancellation:', customer.email);
      return;
    }
    
    const userId = userRows[0].id;
    
    // Downgrade user to free tier
    await pool.query(
      'UPDATE users SET subscription_id = NULL, premium_tier = ? WHERE id = ?',
      ['free', userId]
    );
    
    console.log(`Downgraded user ${userId} to free tier due to subscription cancellation`);
  } catch (error) {
    console.error('Failed to process subscription canceled:', error);
  }
}

export default router; 