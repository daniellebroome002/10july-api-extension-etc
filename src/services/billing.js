const { paddleRequest } = require('./billingApi');
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

async function syncFromDB(userId, db) {
  // placeholder: implement actual DB read
  const row = await db('users').where({ id: userId }).first('credit_balance');
  const entry = getCache(userId);
  entry.balance = row ? row.credit_balance : 0;
  entry.lastSync = Date.now();
  entry.dirty = false;
}

async function flushDirty(db) {
  const updates = [];
  cache.forEach((entry, userId) => {
    if (entry.dirty) {
      updates.push(
        db('users').where({ id: userId }).update({ credit_balance: entry.balance })
      );
      entry.dirty = false;
    }
  });
  if (updates.length) await Promise.all(updates);
}

function chargeCredits(userId, amount, db) {
  const entry = getCache(userId);
  if (entry.balance < amount) {
    throw new Error('INSUFFICIENT_CREDITS');
  }
  entry.balance -= amount;
  entry.dirty = true;
}

function addCredits(userId, amount, db) {
  const entry = getCache(userId);
  entry.balance += amount;
  entry.dirty = true;
}

setInterval(() => {
  // flush every 5 minutes using a provided knex instance stored globally
  if (global._knex) {
    flushDirty(global._knex).catch(console.error);
  }
}, FLUSH_INTERVAL_MS);

module.exports = {
  chargeCredits,
  addCredits,
  syncFromDB,
  flushDirty,
}; 