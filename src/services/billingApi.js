// Using global fetch available in Node 18+

const BASE_URL = process.env.PADDLE_SANDBOX === 'true'
  ? 'https://sandbox-api.paddle.com/graphql'
  : 'https://api.paddle.com/graphql';

if (!process.env.PADDLE_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn('[billingApi] PADDLE_API_KEY is not set – Paddle requests will fail');
}

/**
 * Minimal helper to call the Paddle Billing GraphQL endpoint.
 * @param {string} query GraphQL query or mutation string
 * @param {object} [variables] Variables for the GraphQL operation
 * @returns {Promise<any>} Resolved data field from Paddle response
 * @throws {Error} If Paddle returns errors or network fails
 */
export async function paddleRequest(query, variables = {}) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Paddle ${process.env.PADDLE_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[Paddle ${res.status}] ${text}`);
  }

  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error(body.errors[0].message || 'Unknown Paddle error');
  }
  return body.data;
} 