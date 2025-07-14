import axios from 'axios';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

class NOWPaymentsService {
  constructor() {
    this.apiKey = process.env.NOWPAYMENTS_API_KEY;
    this.ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
    this.sandbox = process.env.NOWPAYMENTS_SANDBOX === 'true';
    this.backendUrl = process.env.BACKEND_URL || process.env.API_URL || 'http://localhost:3000';
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    // Optional bearer token for NOWPayments Subscriptions API (expires ~5 min)
    // The dashboard shows a second key (often labelled "Public Key" or similar).
    // If provided via NOWPAYMENTS_BEARER_TOKEN, we will automatically attach it
    // as `Authorization: Bearer <token>` when calling subscription endpoints.
    // If not set, we will still call the endpoints but they will likely return
    // 401 AUTH_REQUIRED – in that case the operator must supply / refresh the
    // token in the Render.com environment variables.
    this.bearerToken = process.env.NOWPAYMENTS_BEARER_TOKEN || null;
    
    this.apiUrl = this.sandbox 
      ? 'https://api-sandbox.nowpayments.io/v1'
      : 'https://api.nowpayments.io/v1';
    
    // Enhanced debugging for environment variables
    console.log('NOWPayments Service initialized:', {
      hasApiKey: !!this.apiKey,
      apiKeyLength: this.apiKey?.length,
      apiKeyEnd: this.apiKey?.slice(-4),
      hasIpnSecret: !!this.ipnSecret,
      sandbox: this.sandbox,
      backendUrl: this.backendUrl,
      frontendUrl: this.frontendUrl,
      apiUrl: this.apiUrl,
      hasBearerToken: !!this.bearerToken,
      bearerTokenLength: this.bearerToken?.length,
      bearerTokenEnd: this.bearerToken?.slice(-4)
    });
    
    if (!this.bearerToken) {
      console.log(
        '💡 NOWPAYMENTS_BEARER_TOKEN is not set. ' +
        'Using payment-based subscriptions instead of NOWPayments subscription API. ' +
        'This is the recommended approach for single-merchant applications.'
      );
    }
    
    if (!this.apiKey) {
      throw new Error('NOWPAYMENTS_API_KEY is required in environment variables');
    }
    
    if (!this.ipnSecret) {
      console.warn('NOWPAYMENTS_IPN_SECRET is missing - webhook signature validation will be skipped');
    }
    
    // Initialize axios instance with all possible headers
    this.api = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    // Add request/response interceptors for logging
    this.api.interceptors.request.use(this.logRequest.bind(this));
    this.api.interceptors.response.use(this.logResponse.bind(this), this.logError.bind(this));
  }
  
  // Logging interceptors
  logRequest(config) {
    console.log('NOWPayments API Request:', {
      method: config.method?.toUpperCase(),
      url: config.url,
      headers: {
        'x-api-key': config.headers['x-api-key'] ? '***' + config.headers['x-api-key'].slice(-4) : 'NOT SET',
        'Content-Type': config.headers['Content-Type'],
        'Authorization': config.headers['Authorization'] ? 'Bearer ***' : undefined
      },
      data: config.data ? JSON.stringify(config.data) : undefined
    });
    return config;
  }
  
  logResponse(response) {
    console.log('NOWPayments API Response:', {
      status: response.status,
      url: response.config.url,
      data: response.data
    });
    return response;
  }
  
  logError(error) {
    console.error('NOWPayments API Error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      url: error.config?.url,
      data: error.response?.data
    });
    return Promise.reject(error);
  }
  
  // ==================== SUBSCRIPTION MANAGEMENT ====================
  
  /**
   * Create a subscription plan in NOWPayments
   * @param {Object} planData - Plan configuration
   * @returns {Object} Created plan data
   */
  /**
   * Get available subscription plans (now using local definitions instead of NOWPayments plans)
   * @returns {Array} Available plans
   */
  getAvailablePlans() {
    return [
      {
        id: '183275633',
        name: 'Premium Monthly',
        amount: 9.00,
        currency: 'USD',
        credits: 3000,
        description: '3,000 credits monthly + API access',
        interval: 'monthly'
      },
      {
        id: '1502143114', 
        name: 'Premium Plus Monthly',
        amount: 29.00,
        currency: 'USD',
        credits: 15000,
        description: '15,000 credits monthly + priority support',
        interval: 'monthly'
      }
    ];
  }
  
  /**
   * Create a subscription-like payment using NOWPayments invoice (works with API key only)
   * @param {string} userId - User ID
   * @param {string} planId - Internal plan ID
   * @param {string} customerEmail - Customer email
   * @returns {Object} Payment data with payment link
   */
  async createSubscription(userId, planId, customerEmail) {
    try {
      // Map internal plan IDs to prices (since we can't use NOWPayments subscription plans)
      const planPrices = {
        '183275633': { amount: 9.00, name: 'Premium Monthly', credits: 3000 },
        '1502143114': { amount: 29.00, name: 'Premium Plus Monthly', credits: 15000 }
      };
      
      const plan = planPrices[planId];
      if (!plan) {
        throw new Error(`Unknown plan ID: ${planId}`);
      }
      
      const orderId = `sub_${userId}_${Date.now()}`;
      
      console.log('Creating subscription payment via invoice:', {
        planId,
        userId,
        customerEmail,
        amount: plan.amount,
        orderId
      });
      
      // Use createPayment instead of subscriptions endpoint (works with API key only)
      const response = await this.createPayment({
        price_amount: plan.amount,
        price_currency: 'usd',
        order_id: orderId,
        order_description: `${plan.name} - ${plan.credits} credits monthly`,
        success_url: `${this.frontendUrl}/billing?success=1&plan=${planId}`,
        cancel_url: `${this.frontendUrl}/billing?cancelled=1`,
        customer_email: customerEmail,
        ipn_callback_url: `${this.backendUrl}/webhooks/nowpayments`
      });
      
      console.log('Subscription payment created successfully:', {
        paymentId: response.payment_id,
        orderId,
        paymentUrl: response.pay_url
      });
      
             // Return in subscription-like format for compatibility
       return {
         id: response.payment_id,
         plan_id: planId,
         customer_email: customerEmail,
         order_id: orderId,
         payment_url: response.pay_url,
         pay_url: response.pay_url, // Alternative field name for compatibility
         status: 'pending',
         amount: plan.amount,
         currency: 'USD',
         credits: plan.credits
       };
      
    } catch (error) {
      console.error('Subscription creation failed:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        planId,
        customerEmail
      });
      throw new Error(`Failed to create subscription: ${error.message}`);
    }
  }
  
  /**
   * Get payment details (replaces subscription details since we use payments now)
   * @param {string} paymentId - NOWPayments payment ID
   * @returns {Object} Payment data
   */
  async getSubscription(paymentId) {
    try {
      // Use getPaymentStatus instead since we're using payments, not subscriptions
      return await this.getPaymentStatus(paymentId);
    } catch (error) {
      throw new Error(`Failed to get payment details: ${error.message}`);
    }
  }
  
  /**
   * Cancel a payment (limited functionality since crypto payments are irreversible)
   * @param {string} paymentId - NOWPayments payment ID
   * @returns {Object} Cancellation result
   */
  async cancelSubscription(paymentId) {
    try {
      // Note: Crypto payments can't be cancelled once initiated
      // This is mainly for UI compatibility
      console.log(`Cancel requested for payment ${paymentId} - crypto payments cannot be cancelled once initiated`);
      
      return {
        id: paymentId,
        status: 'cancel_requested',
        message: 'Crypto payments cannot be cancelled once initiated. Contact support if needed.'
      };
    } catch (error) {
      throw new Error(`Failed to cancel payment: ${error.message}`);
    }
  }
  
  // ==================== ONE-TIME PAYMENTS (CREDIT PACKS) ====================
  
  /**
   * Create a one-time payment for credit packs
   * @param {Object} orderData - Payment configuration
   * @returns {Object} Payment data with payment link
   */
  async createPayment(orderData) {
    try {
      // Debug API key issue
      console.log('Creating payment with API key:', {
        hasApiKey: !!this.apiKey,
        apiKeyLength: this.apiKey?.length,
        apiKeyEnd: this.apiKey?.slice(-4),
        sandbox: this.sandbox,
        apiUrl: this.apiUrl
      });
      
      const orderId = `credit_${orderData.userId}_${Date.now()}_${uuidv4().slice(0, 8)}`;
      
      const response = await this.api.post('/payment', {
        price_amount: orderData.amount,
        price_currency: orderData.currency || 'usd',
        order_id: orderId,
        order_description: `Boomlify Credits: ${orderData.credits} credits`,
        ipn_callback_url: `${this.backendUrl}/webhooks/nowpayments`,
        success_url: `${this.frontendUrl}/billing?success=1&order=${orderId}`,
        cancel_url: `${this.frontendUrl}/billing?cancelled=1&order=${orderId}`,
        is_fee_paid_by_user: false, // We pay the fees
        // Custom fields for our tracking
        case: JSON.stringify({
          userId: orderData.userId,
          credits: orderData.credits,
          type: 'credit_purchase'
        })
      });
      
      return {
        ...response.data,
        order_id: orderId
      };
    } catch (error) {
      throw new Error(`Failed to create payment: ${error.response?.data?.message || error.message}`);
    }
  }
  
  /**
   * Get payment status
   * @param {string} paymentId - NOWPayments payment ID
   * @returns {Object} Payment status data
   */
  async getPaymentStatus(paymentId) {
    try {
      const response = await this.api.get(`/payment/${paymentId}`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get payment status: ${error.response?.data?.message || error.message}`);
    }
  }
  
  // ==================== UTILITY METHODS ====================
  
  /**
   * Verify NOWPayments webhook signature
   * @param {Object} payload - Webhook payload
   * @param {string} signature - Received signature
   * @returns {boolean} True if signature is valid
   */
  verifyWebhookSignature(payload, signature) {
    if (!this.ipnSecret) {
      console.warn('NOWPayments IPN secret not configured, skipping signature verification');
      return true; // Allow in development
    }
    
    try {
      // NOWPayments signature calculation
      const sortedPayload = JSON.stringify(payload, Object.keys(payload).sort());
      const expectedSignature = crypto
        .createHmac('sha512', this.ipnSecret)
        .update(sortedPayload)
        .digest('hex');
      
      return expectedSignature === signature;
    } catch (error) {
      console.error('Error verifying webhook signature:', error);
      return false;
    }
  }
  
  /**
   * Get list of available currencies for payments
   * @returns {Array} List of supported currencies
   */
  async getAvailableCurrencies() {
    try {
      const response = await this.api.get('/currencies');
      return response.data.currencies || [];
    } catch (error) {
      console.error('Failed to get available currencies:', error);
      return ['btc', 'eth', 'ltc', 'usdt']; // Fallback currencies
    }
  }
  
  /**
   * Get estimated price for a payment
   * @param {number} amount - Amount in USD
   * @param {string} currency - Target cryptocurrency
   * @returns {Object} Price estimation
   */
  async getEstimatedPrice(amount, currency) {
    try {
      const response = await this.api.get('/estimate', {
        params: {
          amount: amount,
          currency_from: 'usd',
          currency_to: currency
        }
      });
      return response.data;
    } catch (error) {
      console.error('Failed to get estimated price:', error);
      return null;
    }
  }
  
  /**
   * Get minimum payment amount for a currency
   * @param {string} currency - Cryptocurrency symbol
   * @returns {number} Minimum payment amount
   */
  async getMinimumPaymentAmount(currency) {
    try {
      const response = await this.api.get('/min-amount', {
        params: {
          currency_from: 'usd',
          currency_to: currency
        }
      });
      return response.data.min_amount || 0;
    } catch (error) {
      console.error('Failed to get minimum payment amount:', error);
      return 0;
    }
  }
}

// Export singleton instance
export default new NOWPaymentsService(); 
