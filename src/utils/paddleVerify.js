// paddleVerify.js - Paddle Webhook Signature Verification Utility
import crypto from 'crypto';

/**
 * Verify Paddle webhook signature using HMAC-SHA256
 * @param {string} rawBody - Raw webhook body as string
 * @param {string} signature - Paddle-Signature header value
 * @param {string} secret - Webhook secret key
 * @returns {boolean} - True if signature is valid
 */
export function verifyPaddleSignature(rawBody, signature, secret) {
  try {
    if (!rawBody || !signature || !secret) {
      console.error('Missing required parameters for signature verification');
      return false;
    }
    
    // Parse signature header format: "ts=1234567890;h1=abc123..."
    const sigElements = signature.split(';');
    const sigMap = {};
    
    for (const element of sigElements) {
      const [key, value] = element.split('=');
      if (key && value) {
        sigMap[key] = value;
      }
    }
    
    const timestamp = sigMap.ts;
    const hash = sigMap.h1;
    
    if (!timestamp || !hash) {
      console.error('Invalid signature format');
      return false;
    }
    
    // Check timestamp freshness (within 5 minutes)
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const webhookTimestamp = parseInt(timestamp);
    
    if (Math.abs(currentTimestamp - webhookTimestamp) > 300) {
      console.error('Webhook timestamp too old');
      return false;
    }
    
    // Create payload for verification: timestamp + ":" + raw body
    const payload = `${timestamp}:${rawBody}`;
    
    // Compute HMAC-SHA256 signature
    const computedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex');
    
    // Compare signatures using constant-time comparison
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(computedSignature, 'hex')
    );
    
  } catch (error) {
    console.error('Error verifying Paddle signature:', error);
    return false;
  }
}

/**
 * Parse Paddle webhook event data
 * @param {string} rawBody - Raw webhook body
 * @returns {object} - Parsed event data
 */
export function parsePaddleWebhookEvent(rawBody) {
  try {
    const eventData = JSON.parse(rawBody);
    
    // Validate required fields
    if (!eventData.event_type || !eventData.data) {
      throw new Error('Invalid webhook event format');
    }
    
    return {
      eventType: eventData.event_type,
      eventId: eventData.event_id,
      occurredAt: eventData.occurred_at,
      data: eventData.data,
      raw: eventData
    };
    
  } catch (error) {
    console.error('Error parsing Paddle webhook event:', error);
    throw error;
  }
}

/**
 * Extract user ID from Paddle webhook custom data
 * @param {object} eventData - Parsed event data
 * @returns {string|null} - User ID or null if not found
 */
export function extractUserIdFromEvent(eventData) {
  try {
    // Check various locations where user_id might be stored
    const locations = [
      eventData.data?.custom_data?.user_id,
      eventData.data?.customer?.custom_data?.user_id,
      eventData.data?.subscription?.custom_data?.user_id,
      eventData.data?.transaction?.custom_data?.user_id
    ];
    
    for (const userId of locations) {
      if (userId && typeof userId === 'string') {
        return userId;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting user ID from event:', error);
    return null;
  }
}

/**
 * Determine plan type from Paddle price ID
 * @param {string} priceId - Paddle price ID
 * @returns {string} - Plan type (premium, premium_plus, or unknown)
 */
export function determinePlanType(priceId) {
  const planMappings = {
    [process.env.PADDLE_PREMIUM_PLAN_ID]: 'premium',
    [process.env.PADDLE_PREMIUM_PLUS_PLAN_ID]: 'premium_plus'
  };
  
  return planMappings[priceId] || 'unknown';
}

/**
 * Get credit amount for product ID
 * @param {string} productId - Paddle product ID
 * @returns {number} - Credit amount
 */
export function getCreditAmountForProduct(productId) {
  const creditMappings = {
    [process.env.PADDLE_CREDITS_1K_PRODUCT_ID]: 1000,
    [process.env.PADDLE_CREDITS_5K_PRODUCT_ID]: 5000,
    [process.env.PADDLE_CREDITS_20K_PRODUCT_ID]: 20000
  };
  
  return creditMappings[productId] || 0;
}

/**
 * Check if event is a duplicate (simple in-memory cache)
 */
const processedEvents = new Set();
const EVENT_CACHE_MAX_SIZE = 1000;

export function isEventDuplicate(eventId) {
  if (processedEvents.has(eventId)) {
    return true;
  }
  
  // Add to processed events
  processedEvents.add(eventId);
  
  // Clean up cache if it gets too large
  if (processedEvents.size > EVENT_CACHE_MAX_SIZE) {
    const eventsArray = Array.from(processedEvents);
    processedEvents.clear();
    // Keep last 500 events
    eventsArray.slice(-500).forEach(id => processedEvents.add(id));
  }
  
  return false;
}

/**
 * Log webhook event for debugging
 * @param {object} eventData - Parsed event data
 * @param {string} result - Processing result
 */
export function logWebhookEvent(eventData, result = 'processed') {
  console.log(`Paddle webhook: ${eventData.eventType} - ${result}`, {
    eventId: eventData.eventId,
    occurredAt: eventData.occurredAt,
    timestamp: new Date().toISOString()
  });
} 