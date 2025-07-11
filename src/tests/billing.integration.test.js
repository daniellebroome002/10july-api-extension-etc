const request = require('supertest');
const crypto = require('crypto');
const app = require('../index');
const pool = require('../db/init');
const billingService = require('../services/billing');

/**
 * Billing System Integration Tests
 * 
 * Tests:
 * - Paddle signature verification
 * - Credit charging and debit/credit race conditions
 * - Webhook processing flow
 * - High RPM rate limiting scenarios
 * - Subscription lifecycle
 */

describe('Billing System Integration Tests', () => {
  let testUser;
  let authToken;
  let testApiKey;

  beforeAll(async () => {
    // Create test user
    const [userResult] = await pool.execute(`
      INSERT INTO users (id, email, password, premium_tier, credit_balance, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, ['test-user-123', 'test@example.com', 'hashedpassword', 'premium', 1000]);

    testUser = {
      id: 'test-user-123',
      email: 'test@example.com',
      premium_tier: 'premium',
      credit_balance: 1000
    };

    // Create test API key
    const [apiKeyResult] = await pool.execute(`
      INSERT INTO premium_settings (user_id, api_key, created_at)
      VALUES (?, ?, NOW())
    `, [testUser.id, 'api_test123456789']);

    testApiKey = 'api_test123456789';

    // Mock auth token (in real app, this would come from JWT)
    authToken = 'mock-jwt-token';
  });

  afterAll(async () => {
    // Cleanup test data
    await pool.execute('DELETE FROM users WHERE id = ?', [testUser.id]);
    await pool.execute('DELETE FROM premium_settings WHERE user_id = ?', [testUser.id]);
    await pool.execute('DELETE FROM subscriptions WHERE user_id = ?', [testUser.id]);
    await pool.execute('DELETE FROM credit_topups WHERE user_id = ?', [testUser.id]);
    await pool.execute('DELETE FROM api_usage_monthly WHERE user_id = ?', [testUser.id]);
  });

  describe('Paddle Signature Verification', () => {
    const webhookSecret = 'test-webhook-secret';
    const originalSecret = process.env.PADDLE_WEBHOOK_SECRET;

    beforeAll(() => {
      process.env.PADDLE_WEBHOOK_SECRET = webhookSecret;
    });

    afterAll(() => {
      process.env.PADDLE_WEBHOOK_SECRET = originalSecret;
    });

    test('should accept valid Paddle signature', async () => {
      const payload = JSON.stringify({
        event_type: 'transaction.completed',
        data: {
          id: 'txn_test123',
          customer_id: 'ctm_test123',
          custom_data: {
            user_id: testUser.id,
            credits: 1000
          },
          status: 'completed',
          items: [{ price: { product: { id: 'prod_123' } } }],
          details: {
            totals: {
              total: 100, // $1.00 in cents
              currency_code: 'USD'
            }
          },
          billed_at: new Date().toISOString()
        }
      });

      const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(payload)
        .digest('hex');

      const response = await request(app)
        .post('/api/webhook/paddle')
        .set('Content-Type', 'application/json')
        .set('paddle-signature', signature)
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.received).toBe(true);
    });

    test('should reject invalid Paddle signature', async () => {
      const payload = JSON.stringify({
        event_type: 'transaction.completed',
        data: { id: 'test' }
      });

      const response = await request(app)
        .post('/api/webhook/paddle')
        .set('Content-Type', 'application/json')
        .set('paddle-signature', 'invalid-signature')
        .send(payload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid signature');
    });

    test('should reject missing signature', async () => {
      const payload = JSON.stringify({
        event_type: 'transaction.completed',
        data: { id: 'test' }
      });

      const response = await request(app)
        .post('/api/webhook/paddle')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(response.status).toBe(401);
    });
  });

  describe('Credit Charging and Race Conditions', () => {
    beforeEach(async () => {
      // Reset user credit balance
      await pool.execute(`
        UPDATE users SET credit_balance = 1000 WHERE id = ?
      `, [testUser.id]);
      
      // Clear billing cache
      await billingService.flushCacheToDatabase();
    });

    test('should charge credits correctly for API email creation', async () => {
      const response = await request(app)
        .post('/api/v1/emails/create')
        .set('X-API-Key', testApiKey)
        .send({
          duration: '1hour',
          domain: 'boomlify.com'
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);

      // Check that credits were deducted (1hour = 2 credits)
      const creditInfo = await billingService.getUserCreditInfo(testUser.id);
      expect(creditInfo.creditBalance).toBe(998); // 1000 - 2
    });

    test('should handle insufficient credits gracefully', async () => {
      // Set user balance to 1 credit
      await pool.execute(`
        UPDATE users SET credit_balance = 1 WHERE id = ?
      `, [testUser.id]);

      const response = await request(app)
        .post('/api/v1/emails/create')
        .set('X-API-Key', testApiKey)
        .send({
          duration: '24hour', // Requires 3 credits
          domain: 'boomlify.com'
        });

      expect(response.status).toBe(402);
      expect(response.body.error).toBe('Insufficient credits');
      expect(response.body.required).toBe(3);
      expect(response.body.available).toBe(1);
    });

    test('should handle concurrent credit charges without race conditions', async () => {
      // Create multiple concurrent requests
      const promises = Array(10).fill().map(() =>
        request(app)
          .post('/api/v1/emails/create')
          .set('X-API-Key', testApiKey)
          .send({
            duration: '10min', // 1 credit each
            domain: 'boomlify.com'
          })
      );

      const responses = await Promise.all(promises);

      // All should succeed (1000 credits available, 10 requests * 1 credit = 10 credits)
      responses.forEach(response => {
        expect(response.status).toBe(201);
      });

      // Check final balance
      const creditInfo = await billingService.getUserCreditInfo(testUser.id);
      expect(creditInfo.creditBalance).toBe(990); // 1000 - 10
    });

    test('should handle concurrent requests when approaching credit limit', async () => {
      // Set balance to 5 credits
      await pool.execute(`
        UPDATE users SET credit_balance = 5 WHERE id = ?
      `, [testUser.id]);

      // Make 10 concurrent requests for 1 credit each
      const promises = Array(10).fill().map(() =>
        request(app)
          .post('/api/v1/emails/create')
          .set('X-API-Key', testApiKey)
          .send({
            duration: '10min',
            domain: 'boomlify.com'
          })
      );

      const responses = await Promise.all(promises);

      // Only 5 should succeed, 5 should fail
      const successful = responses.filter(r => r.status === 201);
      const failed = responses.filter(r => r.status === 402);

      expect(successful.length).toBe(5);
      expect(failed.length).toBe(5);

      // Final balance should be 0
      const creditInfo = await billingService.getUserCreditInfo(testUser.id);
      expect(creditInfo.creditBalance).toBe(0);
    });
  });

  describe('Webhook Processing Flow', () => {
    const webhookSecret = 'test-webhook-secret';

    beforeAll(() => {
      process.env.PADDLE_WEBHOOK_SECRET = webhookSecret;
    });

    test('should process subscription creation webhook', async () => {
      const payload = {
        event_type: 'subscription.created',
        data: {
          id: 'sub_test123',
          customer_id: 'ctm_test123',
          custom_data: {
            user_id: testUser.id,
            plan: 'premium'
          },
          status: 'active',
          started_at: new Date().toISOString(),
          current_billing_period: {
            starts_at: new Date().toISOString(),
            ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          },
          next_billed_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          billing_cycle: { frequency: 1, interval: 'month' },
          items: [{ price: { id: 'price_123' } }]
        }
      };

      const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(payload))
        .digest('hex');

      const response = await request(app)
        .post('/api/webhook/paddle')
        .set('Content-Type', 'application/json')
        .set('paddle-signature', signature)
        .send(payload);

      expect(response.status).toBe(200);

      // Check that subscription was created
      const [subscriptions] = await pool.execute(`
        SELECT * FROM subscriptions WHERE id = ?
      `, ['sub_test123']);

      expect(subscriptions.length).toBe(1);
      expect(subscriptions[0].user_id).toBe(testUser.id);
      expect(subscriptions[0].plan_type).toBe('premium');
    });

    test('should process credit purchase webhook', async () => {
      const payload = {
        event_type: 'transaction.completed',
        data: {
          id: 'txn_test456',
          customer_id: 'ctm_test123',
          custom_data: {
            user_id: testUser.id,
            credits: 5000
          },
          status: 'completed',
          items: [{ price: { product: { id: 'prod_5k' } } }],
          details: {
            totals: {
              total: 425, // $4.25 in cents
              currency_code: 'USD'
            }
          },
          billed_at: new Date().toISOString()
        }
      };

      const initialBalance = (await billingService.getUserCreditInfo(testUser.id)).creditBalance;

      const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(payload))
        .digest('hex');

      const response = await request(app)
        .post('/api/webhook/paddle')
        .set('Content-Type', 'application/json')
        .set('paddle-signature', signature)
        .send(payload);

      expect(response.status).toBe(200);

      // Check that credits were added
      const finalBalance = (await billingService.getUserCreditInfo(testUser.id)).creditBalance;
      expect(finalBalance).toBe(initialBalance + 5000);

      // Check credit topup record
      const [topups] = await pool.execute(`
        SELECT * FROM credit_topups WHERE paddle_transaction_id = ?
      `, ['txn_test456']);

      expect(topups.length).toBe(1);
      expect(topups[0].credits_purchased).toBe(5000);
      expect(topups[0].amount_paid).toBe(4.25);
    });

    test('should handle duplicate webhook events', async () => {
      const payload = {
        event_type: 'transaction.completed',
        data: {
          id: 'txn_duplicate',
          customer_id: 'ctm_test123',
          custom_data: {
            user_id: testUser.id,
            credits: 1000
          },
          status: 'completed',
          items: [{ price: { product: { id: 'prod_1k' } } }],
          details: {
            totals: {
              total: 100,
              currency_code: 'USD'
            }
          },
          billed_at: new Date().toISOString()
        }
      };

      const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(payload))
        .digest('hex');

      const initialBalance = (await billingService.getUserCreditInfo(testUser.id)).creditBalance;

      // Send webhook twice
      await request(app)
        .post('/api/webhook/paddle')
        .set('Content-Type', 'application/json')
        .set('paddle-signature', signature)
        .send(payload);

      await request(app)
        .post('/api/webhook/paddle')
        .set('Content-Type', 'application/json')
        .set('paddle-signature', signature)
        .send(payload);

      // Credits should only be added once
      const finalBalance = (await billingService.getUserCreditInfo(testUser.id)).creditBalance;
      expect(finalBalance).toBe(initialBalance + 1000); // Not +2000
    });
  });

  describe('Rate Limiting Scenarios', () => {
    test('should respect tier-based rate limits', async () => {
      // Premium users get 120 requests per minute
      const promises = Array(130).fill().map((_, index) =>
        request(app)
          .get('/api/v1/emails')
          .set('X-API-Key', testApiKey)
          .then(response => ({ index, status: response.status }))
      );

      const responses = await Promise.all(promises);

      // First 120 should succeed, rest should be rate limited
      const successful = responses.filter(r => r.status === 200);
      const rateLimited = responses.filter(r => r.status === 429);

      expect(successful.length).toBeLessThanOrEqual(120);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    test('should include correct rate limit headers', async () => {
      const response = await request(app)
        .get('/api/v1/emails')
        .set('X-API-Key', testApiKey);

      expect(response.headers['x-ratelimit-limit']).toBe('120'); // Premium tier limit
      expect(response.headers['x-user-tier']).toBe('premium');
      expect(response.headers['x-credit-balance']).toBeDefined();
    });
  });

  describe('Billing API Endpoints', () => {
    test('should get billing status', async () => {
      const response = await request(app)
        .get('/api/billing/status')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.userId).toBe(testUser.id);
      expect(response.body.data.creditBalance).toBeDefined();
      expect(response.body.data.premiumTier).toBe('premium');
    });

    test('should create checkout URL for subscription', async () => {
      process.env.PADDLE_PREMIUM_PLAN_ID = 'plan_premium_123';

      const response = await request(app)
        .post('/api/billing/create-checkout')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          type: 'subscription',
          plan: 'premium'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.checkoutUrl).toContain('checkout.paddle.com');
      expect(response.body.data.type).toBe('subscription');
      expect(response.body.data.plan).toBe('premium');
    });

    test('should create checkout URL for credits', async () => {
      process.env.PADDLE_CREDITS_1K_PRODUCT_ID = 'prod_1k_123';

      const response = await request(app)
        .post('/api/billing/create-checkout')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          type: 'credits',
          credits: 1000
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.checkoutUrl).toContain('checkout.paddle.com');
      expect(response.body.data.type).toBe('credits');
      expect(response.body.data.credits).toBe(1000);
    });

    test('should reject invalid checkout requests', async () => {
      const response = await request(app)
        .post('/api/billing/create-checkout')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          type: 'invalid',
          plan: 'premium'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('Subscription Management', () => {
    test('should cancel active subscription', async () => {
      // Create test subscription
      await pool.execute(`
        INSERT INTO subscriptions (
          id, user_id, paddle_customer_id, plan_type, status,
          monthly_credit_allowance, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NOW())
      `, ['sub_cancel_test', testUser.id, 'ctm_test', 'premium', 'active', 3000]);

      const response = await request(app)
        .post('/api/billing/cancel-subscription')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('canceled');

      // Verify subscription was canceled in database
      const [subscriptions] = await pool.execute(`
        SELECT status FROM subscriptions WHERE id = ?
      `, ['sub_cancel_test']);

      expect(subscriptions[0].status).toBe('canceled');
    });

    test('should handle cancel request with no active subscription', async () => {
      // Ensure no active subscriptions
      await pool.execute(`
        UPDATE subscriptions SET status = 'canceled' WHERE user_id = ?
      `, [testUser.id]);

      const response = await request(app)
        .post('/api/billing/cancel-subscription')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('No active subscription found');
    });
  });

  describe('Usage History', () => {
    test('should get usage history', async () => {
      // Create test usage data
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();

      await pool.execute(`
        INSERT INTO api_usage_monthly (
          user_id, usage_month, usage_year, emails_10min_count,
          emails_1hour_count, emails_24hour_count, credits_consumed,
          monthly_allowance, allowance_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [testUser.id, currentMonth, currentYear, 50, 30, 10, 120, 3000, 120]);

      const response = await request(app)
        .get('/api/billing/usage-history')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.monthlyUsage).toBeDefined();
      expect(response.body.data.monthlyUsage.length).toBeGreaterThan(0);
    });
  });
});

module.exports = {
  // Export test utilities for other test files
  createTestUser: async (userData) => {
    const [result] = await pool.execute(`
      INSERT INTO users (id, email, password, premium_tier, credit_balance, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [userData.id, userData.email, userData.password, userData.tier, userData.balance]);
    return result;
  },
  
  cleanupTestUser: async (userId) => {
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await pool.execute('DELETE FROM premium_settings WHERE user_id = ?', [userId]);
    await pool.execute('DELETE FROM subscriptions WHERE user_id = ?', [userId]);
    await pool.execute('DELETE FROM credit_topups WHERE user_id = ?', [userId]);
    await pool.execute('DELETE FROM api_usage_monthly WHERE user_id = ?', [userId]);
  },
  
  createPaddleSignature: (payload, secret) => {
    return crypto
      .createHmac('sha256', secret)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
  }
}; 