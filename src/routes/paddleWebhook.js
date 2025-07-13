const express = require('express');
const bodyParser = require('body-parser');
const { verify } = require('../utils/paddleVerify');
const { addCredits } = require('../services/billing');

const router = express.Router();

// Raw body needed
router.post('/paddle', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.get('Paddle-Signature');
  const isValid = verify(req.body, sig);
  if (!isValid) return res.status(400).send('invalid');
  const event = JSON.parse(req.body);

  try {
    if (event.event_type === 'payment_succeeded') {
      const { customer_id, items } = event.data;
      const credits = items.reduce((sum, item) => sum + (item.quantity || 1) * 1000, 0); // simplistic mapping
      await addCredits(customer_id, credits, global._knex);
    }
    // handle subscription events similarly (omitted)
    res.json({ received: true });
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});

module.exports = router; 