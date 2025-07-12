import { Paddle, Environment } from '@paddle/paddle-node-sdk';

/**
 * Paddle API Service - Official SDK Implementation
 *
 * Uses the official Paddle Node SDK for Paddle Billing API.
 * Automatically switches between sandbox and live environments.
 *
 * Required environment variables:
 *  - PADDLE_API_KEY: Your Paddle API key (live or sandbox)
 *  - PADDLE_SANDBOX: 'true' to use sandbox environment, otherwise live
 *  - PADDLE_WEBHOOK_SECRET: Webhook secret for signature verification
 */

const isSandbox = process.env.PADDLE_SANDBOX === 'true';
const environment = isSandbox ? Environment.sandbox : Environment.production;

// Initialize Paddle SDK
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: environment
});

console.log(`[Paddle API] Initialized with ${isSandbox ? 'sandbox' : 'live'} environment`);

/**
 * Create a checkout session for subscriptions or one-time purchases
 * @param {Object} checkoutData - Checkout configuration
 * @returns {Promise<Object>} Checkout session data
 */
async function createCheckout(checkoutData) {
  try {
    console.log('[Paddle API] Creating checkout session:', JSON.stringify(checkoutData, null, 2));
    
    // Use the transactions API to create a checkout
    const transaction = await paddle.transactions.create(checkoutData);
    
    console.log('[Paddle API] Checkout created successfully:', transaction.id);
    
    return {
      data: {
        id: transaction.id,
        url: transaction.checkout?.url || null,
        status: transaction.status
      }
    };
  } catch (error) {
    console.error('[Paddle API] Failed to create checkout:', error);
    
    // Re-throw with more context
    if (error.code) {
      throw new Error(`Paddle API Error (${error.code}): ${error.detail || error.message}`);
    }
    throw error;
  }
}

/**
 * Get subscription details
 * @param {string} subscriptionId - Subscription ID
 * @returns {Promise<Object>} Subscription data
 */
async function getSubscription(subscriptionId) {
  try {
    const subscription = await paddle.subscriptions.get(subscriptionId);
    return subscription;
  } catch (error) {
    console.error('[Paddle API] Failed to get subscription:', error);
    throw error;
  }
}

/**
 * Cancel a subscription
 * @param {string} subscriptionId - Subscription ID
 * @param {Object} options - Cancellation options
 * @returns {Promise<Object>} Updated subscription data
 */
async function cancelSubscription(subscriptionId, options = {}) {
  try {
    const effectiveFrom = options.immediately ? 'immediately' : 'next_billing_period';
    
    const subscription = await paddle.subscriptions.cancel(subscriptionId, {
      effective_from: effectiveFrom
    });
    
    console.log(`[Paddle API] Subscription ${subscriptionId} cancelled (${effectiveFrom})`);
    return subscription;
  } catch (error) {
    console.error('[Paddle API] Failed to cancel subscription:', error);
    throw error;
  }
}

/**
 * Update a subscription
 * @param {string} subscriptionId - Subscription ID
 * @param {Object} updateData - Update data
 * @returns {Promise<Object>} Updated subscription data
 */
async function updateSubscription(subscriptionId, updateData) {
  try {
    const subscription = await paddle.subscriptions.update(subscriptionId, updateData);
    console.log(`[Paddle API] Subscription ${subscriptionId} updated`);
    return subscription;
  } catch (error) {
    console.error('[Paddle API] Failed to update subscription:', error);
    throw error;
  }
}

/**
 * Get customer details
 * @param {string} customerId - Customer ID
 * @returns {Promise<Object>} Customer data
 */
async function getCustomer(customerId) {
  try {
    const customer = await paddle.customers.get(customerId);
    return customer;
  } catch (error) {
    console.error('[Paddle API] Failed to get customer:', error);
    throw error;
  }
}

/**
 * Create a customer
 * @param {Object} customerData - Customer data
 * @returns {Promise<Object>} Customer data
 */
async function createCustomer(customerData) {
  try {
    const customer = await paddle.customers.create(customerData);
    console.log(`[Paddle API] Customer created: ${customer.id}`);
    return customer;
  } catch (error) {
    console.error('[Paddle API] Failed to create customer:', error);
    throw error;
  }
}

/**
 * Verify webhook signature and parse event
 * @param {string} rawBody - Raw webhook body
 * @param {string} signature - Paddle-Signature header
 * @param {string} secretKey - Webhook secret key
 * @returns {Promise<Object>} Parsed webhook event
 */
async function verifyWebhook(rawBody, signature, secretKey) {
  try {
    const event = await paddle.webhooks.unmarshal(rawBody, secretKey, signature);
    console.log(`[Paddle API] Webhook verified: ${event.eventType}`);
    return event;
  } catch (error) {
    console.error('[Paddle API] Webhook verification failed:', error);
    throw new Error('Invalid webhook signature');
  }
}

/**
 * List products
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Products list
 */
async function listProducts(options = {}) {
  try {
    const products = await paddle.products.list(options);
    return products;
  } catch (error) {
    console.error('[Paddle API] Failed to list products:', error);
    throw error;
  }
}

/**
 * List prices for a product
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Prices list
 */
async function listPrices(options = {}) {
  try {
    const prices = await paddle.prices.list(options);
    return prices;
  } catch (error) {
    console.error('[Paddle API] Failed to list prices:', error);
    throw error;
  }
}

export default {
  createCheckout,
  getSubscription,
  cancelSubscription,
  updateSubscription,
  getCustomer,
  createCustomer,
  verifyWebhook,
  listProducts,
  listPrices,
  // Expose the paddle instance for advanced usage
  paddle
}; 