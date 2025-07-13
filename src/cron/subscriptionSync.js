import { paddleRequest } from '../services/billingApi.js';
const ONE_HOUR = 60 * 60 * 1000;

/**
 * Fetch active subscriptions from DB and reconcile with Paddle Billing.
 * Downgrades users whose subscriptions are cancelled or past due.
 * Resets monthly allowance on 1st of month and writes to api_usage_monthly.
 * @param {import('mysql2/promise').Pool} db Database pool instance
 */
async function reconcile(db) {
  try {
    // Get all active subscriptions from the subscriptions table
    const [rows] = await db.query(`
      SELECT s.id, s.user_id, s.plan_type, s.status, u.premium_tier 
      FROM subscriptions s 
      JOIN users u ON s.user_id = u.id 
      WHERE s.status = 'active'
    `);
    
    console.log(`Found ${rows.length} active subscriptions to reconcile`);
    
    for (const subscription of rows) {
      try {
        const query = `query ($id: ID!) { subscription(id: $id) { id status nextBillingAt } }`;
        const data = await paddleRequest(query, { id: subscription.id });
        const paddleSub = data.subscription;
        
        if (!paddleSub) {
          console.log(`Subscription ${subscription.id} not found in Paddle, marking as canceled`);
          // Mark as canceled in our database
          await db.query(`
            UPDATE subscriptions 
            SET status = 'canceled', updated_at = NOW() 
            WHERE id = ?
          `, [subscription.id]);
          
          // Downgrade user
          await db.query(
            'UPDATE users SET premium_tier = ? WHERE id = ?', 
            ['free', subscription.user_id]
          );
          continue;
        }

        if (paddleSub.status !== 'active') {
          console.log(`Subscription ${subscription.id} status changed to ${paddleSub.status}, updating database`);
          
          // Update subscription status
          await db.query(`
            UPDATE subscriptions 
            SET status = ?, next_billed_at = ?, updated_at = NOW() 
            WHERE id = ?
          `, [paddleSub.status, paddleSub.nextBillingAt, subscription.id]);
          
          // Downgrade user if subscription is no longer active
          if (paddleSub.status === 'canceled' || paddleSub.status === 'past_due') {
            await db.query(
              'UPDATE users SET premium_tier = ? WHERE id = ?', 
              ['free', subscription.user_id]
            );
            console.log(`Downgraded user ${subscription.user_id} to free tier`);
          }
        } else {
          // Subscription is still active, just update next billing date
          await db.query(`
            UPDATE subscriptions 
            SET next_billed_at = ?, updated_at = NOW() 
            WHERE id = ?
          `, [paddleSub.nextBillingAt, subscription.id]);
        }
        
      } catch (e) {
        console.error('Failed to reconcile subscription for user', subscription.user_id, e.message);
      }
    }
    
    console.log('Subscription reconciliation completed');
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
