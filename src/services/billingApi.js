// Using global fetch available in Node 18+

const BASE_URL = process.env.PADDLE_SANDBOX === 'true'
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';

if (!process.env.PADDLE_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn('[billingApi] PADDLE_API_KEY is not set – Paddle requests will fail');
}

/**
 * Helper to call the Paddle Billing REST API.
 * @param {string} endpoint API endpoint path (e.g., '/checkout-sessions')
 * @param {object} [data] Request body data
 * @param {string} [method] HTTP method (default: 'POST')
 * @returns {Promise<any>} Resolved response data from Paddle
 * @throws {Error} If Paddle returns errors or network fails
 */
export async function paddleRequest(endpoint, data = null, method = 'POST') {
  const url = `${BASE_URL}${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
    },
  };

  if (data && method !== 'GET') {
    options.body = JSON.stringify(data);
  }

  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[Paddle ${res.status}] ${text}`);
  }

  const body = await res.json();
  return body;
}

/**
 * Create a Paddle transaction and get checkout URL
 * @param {string} priceId Paddle price ID
 * @param {string} email Customer email
 * @returns {Promise<string>} Checkout URL
 */
export async function createCheckoutSession(priceId, email) {
  const requestData = {
    items: [{ 
      price_id: priceId, 
      quantity: 1 
    }]
  };
  
  console.log('Paddle transaction request data:', JSON.stringify(requestData, null, 2));
  
  const data = await paddleRequest('/transactions', requestData);
  
  console.log('Paddle transaction response:', JSON.stringify(data, null, 2));
  
  // The checkout URL is in the response data
  if (data && data.data && data.data.checkout && data.data.checkout.url) {
    return data.data.checkout.url;
  }
  
  throw new Error('No checkout URL returned from Paddle transaction');
}

/**
 * Get subscription details by ID
 * @param {string} subscriptionId Paddle subscription ID
 * @returns {Promise<object>} Subscription data
 */
export async function getSubscription(subscriptionId) {
  return paddleRequest(`/subscriptions/${subscriptionId}`, null, 'GET');
}

/**
 * List all subscriptions for debugging
 * @returns {Promise<object>} Subscriptions list
 */
export async function listSubscriptions() {
  return paddleRequest('/subscriptions', null, 'GET');
}

/**
 * Test Paddle API authentication
 * @returns {Promise<object>} Event types response
 */
export async function testPaddleAuth() {
  return paddleRequest('/event-types', null, 'GET');
} 
