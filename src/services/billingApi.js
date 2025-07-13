// Paddle Billing API Service
// Handles both Sandbox and Production environments
// Two-step checkout process: Transaction → Checkout

/**
 * Environment Configuration
 * PADDLE_SANDBOX=true → Sandbox environment
 * PADDLE_SANDBOX=false → Production environment
 */
const isSandbox = process.env.PADDLE_SANDBOX === 'true';

// API Base URLs
const API_BASE_URL = isSandbox 
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';

// Checkout Base URLs  
const CHECKOUT_BASE_URL = isSandbox
  ? 'https://sandbox-checkout.paddle.com'
  : 'https://checkout.paddle.com';

// Environment validation
if (!process.env.PADDLE_API_KEY) {
  console.error('[billingApi] PADDLE_API_KEY is required');
}

if (!process.env.PADDLE_WEBHOOK_SECRET) {
  console.warn('[billingApi] PADDLE_WEBHOOK_SECRET is not set - webhook verification will fail');
}

console.log(`[billingApi] Initialized in ${isSandbox ? 'SANDBOX' : 'PRODUCTION'} mode`);
console.log(`[billingApi] API URL: ${API_BASE_URL}`);
console.log(`[billingApi] Checkout URL: ${CHECKOUT_BASE_URL}`);

/**
 * Make authenticated request to Paddle API
 * @param {string} endpoint - API endpoint path (e.g., '/transactions')
 * @param {object} [data] - Request body data
 * @param {string} [method='POST'] - HTTP method
 * @returns {Promise<object>} - Paddle API response
 * @throws {Error} - If request fails or Paddle returns error
 */
export async function paddleRequest(endpoint, data = null, method = 'POST') {
  const url = `${API_BASE_URL}${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(data);
  }

  console.log(`[billingApi] ${method} ${url}`);
  if (data) {
    console.log('[billingApi] Request body:', JSON.stringify(data, null, 2));
  }

  try {
    const response = await fetch(url, options);
    const responseData = await response.json();

    if (!response.ok) {
      const errorMessage = responseData.error?.detail || responseData.error?.message || 'Unknown Paddle API error';
      console.error(`[billingApi] ${response.status} Error:`, responseData);
      throw new Error(`[Paddle ${response.status}] ${JSON.stringify(responseData)}`);
    }

    console.log(`[billingApi] ${response.status} Success:`, JSON.stringify(responseData, null, 2));
    return responseData;
  } catch (error) {
    console.error(`[billingApi] Request failed:`, error);
    
    // Handle network connectivity issues
    if (error.code === 'ENOTFOUND' || error.message.includes('fetch failed')) {
      const environment = isSandbox ? 'sandbox' : 'production';
      const suggestion = isSandbox 
        ? 'Try setting PADDLE_SANDBOX=false to use production API instead'
        : 'Check your network connectivity and DNS resolution';
      
      throw new Error(`Network error: Cannot reach Paddle ${environment} API (${url}). ${suggestion}. Original error: ${error.message}`);
    }
    
    throw error;
  }
}

/**
 * Create a hosted checkout session for a user
 * This is the main function that implements Paddle's two-step checkout process:
 * 1. Create transaction with customer data
 * 2. Create checkout session for the transaction
 * 
 * @param {string} priceId - Paddle price ID
 * @param {string} email - Customer email address
 * @param {object} [user] - User object with additional details
 * @returns {Promise<string>} - Hosted checkout URL
 * @throws {Error} - If checkout creation fails
 */
export async function createCheckoutSession(priceId, email, user = null) {
  try {
    // Step 1: Create transaction
    console.log('[billingApi] Step 1: Creating transaction');
    const transaction = await createTransaction(priceId, email, user);
    
    // Step 2: Create checkout session for the transaction
    console.log('[billingApi] Step 2: Creating checkout session');
    const checkoutUrl = await createCheckout(transaction.data.id, user);
    
    console.log(`[billingApi] ✅ Checkout created successfully: ${checkoutUrl}`);
    return checkoutUrl;
    
  } catch (error) {
    console.error('[billingApi] ❌ Checkout creation failed:', error);
    throw error;
  }
}

/**
 * Step 1: Create a Paddle transaction
 * @param {string} priceId - Paddle price ID
 * @param {string} email - Customer email
 * @param {object} [user] - User object
 * @returns {Promise<object>} - Transaction data
 */
async function createTransaction(priceId, email, user = null) {
  const transactionData = {
    items: [{ 
      price_id: priceId, 
      quantity: 1 
    }],
    // Include custom data to track the user
    custom_data: {
      user_id: user?.id || null,
      user_email: email,
      environment: isSandbox ? 'sandbox' : 'production',
      created_via: 'boomlify_billing',
      created_at: new Date().toISOString()
    }
  };

  console.log('[billingApi] Creating transaction with data:', JSON.stringify(transactionData, null, 2));
  
  const response = await paddleRequest('/transactions', transactionData);
  
  if (!response.data?.id) {
    throw new Error('Transaction creation failed: No transaction ID returned');
  }
  
  console.log(`[billingApi] ✅ Transaction created: ${response.data.id}`);
  return response;
}

/**
 * Step 2: Create a checkout session for the transaction
 * @param {string} transactionId - Transaction ID from step 1
 * @param {object} [user] - User object
 * @returns {Promise<string>} - Checkout URL
 */
async function createCheckout(transactionId, user = null) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  
  const checkoutData = {
    transaction_id: transactionId,
    // Success/cancel URLs
    redirect_url: `${frontendUrl}/billing/success`,
    cancel_url: `${frontendUrl}/billing`,
    // Additional settings
    settings: {
      display_mode: 'overlay',
      theme: 'light',
      locale: 'en'
    }
  };

  console.log('[billingApi] Creating checkout with data:', JSON.stringify(checkoutData, null, 2));
  
  const response = await paddleRequest('/checkouts', checkoutData);
  
  if (!response.data?.url) {
    throw new Error('Checkout creation failed: No checkout URL returned');
  }
  
  const checkoutUrl = response.data.url;
  console.log(`[billingApi] ✅ Checkout URL generated: ${checkoutUrl}`);
  
  return checkoutUrl;
}

/**
 * Get subscription details by ID
 * @param {string} subscriptionId - Paddle subscription ID
 * @returns {Promise<object>} - Subscription data
 */
export async function getSubscription(subscriptionId) {
  return paddleRequest(`/subscriptions/${subscriptionId}`, null, 'GET');
}

/**
 * List all subscriptions (for debugging)
 * @returns {Promise<object>} - Subscriptions list
 */
export async function listSubscriptions() {
  return paddleRequest('/subscriptions', null, 'GET');
}

/**
 * Test Paddle API authentication
 * @returns {Promise<object>} - Event types response
 */
export async function testPaddleAuth() {
  return paddleRequest('/event-types', null, 'GET');
}

/**
 * Get current environment configuration
 * @returns {object} - Environment details
 */
export function getEnvironmentInfo() {
  return {
    environment: isSandbox ? 'sandbox' : 'production',
    apiUrl: API_BASE_URL,
    checkoutUrl: CHECKOUT_BASE_URL,
    hasApiKey: !!process.env.PADDLE_API_KEY,
    hasWebhookSecret: !!process.env.PADDLE_WEBHOOK_SECRET
  };
} 
