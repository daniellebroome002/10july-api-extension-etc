import express from 'express';
import { paddleRequest } from '../services/billingApi.js';
import { chargeCredits } from '../services/billing.js';

const router = express.Router();

// POST /billing/checkout/:priceId -> returns pay link URL
router.post('/checkout/:priceId', async (req, res, next) => {
  try {
    const { priceId } = req.params;
    const email = req.user?.email || 'guest@example.com';
    const mutation = `mutation CreatePayLink($priceId: ID!, $email: String!) {
      payLinkCreate(input: {
        customer: { email: $email },
        priceId: $priceId,
        quantity: 1
      }) { url }
    }`;
    const data = await paddleRequest(mutation, { priceId, email });
    res.json({ url: data.payLinkCreate.url });
  } catch (err) {
    next(err);
  }
});

// GET /billing/status -> credits + plan (stub)
router.get('/status', async (req, res) => {
  const user = req.user || {};
  res.json({ credit_balance: user.credit_balance ?? 0, plan: user.tier ?? 'guest' });
});

export default router; 
