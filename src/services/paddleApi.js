import axios from 'axios';

/**
 * Paddle API Service
 *
 * Provides minimal wrapper functions around Paddle REST API.
 * Automatically switches between sandbox and live environments based on
 * the PADDLE_SANDBOX environment variable.
 *
 * Required environment variables:
 *  - PADDLE_API_KEY:   Secret token from Paddle (live or sandbox)
 *  - PADDLE_SANDBOX:   'true' to use sandbox-api.paddle.com, otherwise live
 */

const isSandbox = process.env.PADDLE_SANDBOX === 'true';

const baseURL = isSandbox
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';

const client = axios.create({
  baseURL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.PADDLE_API_KEY}`
  }
});

async function getSubscription(subscriptionId) {
  const { data } = await client.get(`/subscriptions/${subscriptionId}`);
  return data;
}

async function cancelSubscription(subscriptionId) {
  // According to Paddle docs, cancellation is a POST request
  const { data } = await client.post(`/subscriptions/${subscriptionId}/cancel`, {});
  return data;
}

export default {
  getSubscription,
  cancelSubscription
}; 
