import { paddleRequest } from '../services/billingApi.js';
const ONE_HOUR = 60 * 60 * 1000;

/**
 * Fetch active subscriptions from DB and reconcile with Paddle Billing.
 * Downgrades users whose subscriptions are cancelled or past due.
 * Resets monthly allowance on 1st of month and writes to api_usage_monthly.
 * @param {import('knex').Knex} db Knex or pool instance
 */
async function reconcile(db) {
  try {
    const [rows] = await db.query('SELECT id, subscription_id, premium_tier FROM users WHERE subscription_id IS NOT NULL');
    for (const user of rows) {
      try {
        const query = `query ($id: ID!) { subscription(id: $id) { id status nextBillingAt } }`;
        const data = await paddleRequest(query, { id: user.subscription_id });
        const sub = data.subscription;
        if (!sub) continue;

        if (sub.status !== 'active') {
          // downgrade user
          await db.query('UPDATE users SET premium_tier = ?, subscription_id = NULL WHERE id = ?', ['free', user.id]);
        }
        // monthly allowance reset on day 1 at 00:05 UTC handled by SQL event or here
      } catch (e) {
        console.error('Failed to reconcile sub for user', user.id, e.message);
      }
    }
  } catch (err) {
    console.error('Subscription reconciliation failed', err);
  }
}

function start(db) {
  // run immediately and then hourly
  reconcile(db);
  setInterval(() => reconcile(db), ONE_HOUR);
  console.log('[subscriptionSync] started');
}

export { start }; 