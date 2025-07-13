import { paddleRequest } from './billingApi.js';
import { pool } from '../db/init.js';

const cache = new Map(); // userId => { balance, lastSync, dirty }

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

function getCache(userId) {
  let entry = cache.get(userId);
  if (!entry) {
    entry = { balance: 0, lastSync: 0, dirty: false };
    cache.set(userId, entry);
  }
  return entry;
}

async function syncFromDB(userId, db = pool) {
  try {
    // Use raw SQL query with mysql2 pool
    const [rows] = await db.query('SELECT credit_balance FROM users WHERE id = ?', [userId]);
    const entry = getCache(userId);
    entry.balance = rows.length > 0 ? (rows[0].credit_balance || 0) : 0;
    entry.lastSync = Date.now();
    entry.dirty = false;
    console.log(`Synced credits for user ${userId}: ${entry.balance}`);
  } catch (error) {
    console.error(`Failed to sync credits for user ${userId}:`, error);
  }
}

async function flushDirty(db = pool) {
  const updates = [];
  const userIds = [];
  
  cache.forEach((entry, userId) => {
    if (entry.dirty) {
      updates.push([entry.balance, userId]);
      userIds.push(userId);
    }
  });
  
  if (updates.length > 0) {
    try {
      // Use batch update for better performance
      for (const [balance, userId] of updates) {
        await db.query('UPDATE users SET credit_balance = ? WHERE id = ?', [balance, userId]);
      }
      
      // Mark as clean after successful update
      userIds.forEach(userId => {
        const entry = cache.get(userId);
        if (entry) {
          entry.dirty = false;
        }
      });
      
      console.log(`Flushed ${updates.length} credit balance updates to database`);
    } catch (error) {
      console.error('Failed to flush credit updates:', error);
    }
  }
}

function chargeCredits(userId, amount, db = pool) {
  const entry = getCache(userId);
  if (entry.balance < amount) {
    throw new Error('INSUFFICIENT_CREDITS');
  }
  entry.balance -= amount;
  entry.dirty = true;
  console.log(`Charged ${amount} credits from user ${userId}, new balance: ${entry.balance}`);
}

function addCredits(userId, amount, db = pool) {
  const entry = getCache(userId);
  entry.balance += amount;
  entry.dirty = true;
  console.log(`Added ${amount} credits to user ${userId}, new balance: ${entry.balance}`);
}

// Initialize periodic flushing
setInterval(() => {
  flushDirty().catch(console.error);
}, FLUSH_INTERVAL_MS);

export { chargeCredits, addCredits, syncFromDB, flushDirty }; 