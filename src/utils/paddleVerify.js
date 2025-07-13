import crypto from 'crypto';

function verify(rawBody, signatureHeader) {
  if (!process.env.PADDLE_WEBHOOK_SECRET) {
    throw new Error('PADDLE_WEBHOOK_SECRET not set');
  }
  const [tsPart, sigPart] = signatureHeader.split(';');
  const expectedSig = sigPart.split('=')[1];
  const ts = tsPart.split('=')[1];
  const payload = `${ts}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET);
  hmac.update(payload);
  const calculated = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(expectedSig));
}

export { verify }; 