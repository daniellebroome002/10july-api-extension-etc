import axios from 'axios';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

class NOWPaymentsService {
  constructor() {
    this.apiKey = process.env.NOWPAYMENTS_API_KEY;
    this.ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
    this.sandbox = process.env.NOWPAYMENTS_SANDBOX === 'true';
    this.apiUrl = this.sandbox 
      ? 'https://api-sandbox.nowpayments.io/v1'
      : 'https://api.nowpayments.io/v1';
    
    if (!this.apiKey) {
      throw new Error('NOWPAYMENTS_API_KEY is required');
    }
    
    // Initialize axios instance with default headers
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
  async createSubscriptionPlan(planData) {
    try {
      const response = await this.api.post('/subscriptions/plans', {
        title: planData.title,
        amount: planData.amount,
        currency: planData.currency || 'usd',
        interval_day: planData.interval_day || 30,
        trial_period_day: planData.trial_period_day || 0,
        is_active: true
      });
      
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create subscription plan: ${error.response?.data?.message || error.message}`);
    }
  }
  
  /**
   * Create a subscription for a user
   * @param {string} userId - User ID
   * @param {string} planId - NOWPayments plan ID
   * @param {string} customerEmail - Customer email
   * @returns {Object} Subscription data with payment link
   */
  async createSubscription(userId, planId, customerEmail) {
    try {
      const response = await this.api.post('/subscriptions', {
        plan_id: planId,
        customer_email: customerEmail,
        ipn_callback_url: `${process.env.BACKEND_URL}/webhooks/nowpayments`,
        success_url: `${process.env.FRONTEND_URL}/billing?success=1`,
        cancel_url: `${process.env.FRONTEND_URL}/billing?cancelled=1`,
        order_id: `sub_${userId}_${Date.now()}` // Unique order ID
      });
      
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create subscription: ${error.response?.data?.message || error.message}`);
    }
  }
  
  /**
   * Get subscription details
   * @param {string} subscriptionId - NOWPayments subscription ID
   * @returns {Object} Subscription data
   */
  async getSubscription(subscriptionId) {
    try {
      const response = await this.api.get(`/subscriptions/${subscriptionId}`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get subscription: ${error.response?.data?.message || error.message}`);
    }
  }
  
  /**
   * Cancel a subscription
   * @param {string} subscriptionId - NOWPayments subscription ID
   * @returns {Object} Cancellation result
   */
  async cancelSubscription(subscriptionId) {
    try {
      const response = await this.api.delete(`/subscriptions/${subscriptionId}`);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to cancel subscription: ${error.response?.data?.message || error.message}`);
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
      const orderId = `credit_${orderData.userId}_${Date.now()}_${uuidv4().slice(0, 8)}`;
      
      const response = await this.api.post('/payment', {
        price_amount: orderData.amount,
        price_currency: orderData.currency || 'usd',
        order_id: orderId,
        order_description: `Boomlify Credits: ${orderData.credits} credits`,
        ipn_callback_url: `${process.env.BACKEND_URL}/webhooks/nowpayments`,
        success_url: `${process.env.FRONTEND_URL}/billing?success=1&order=${orderId}`,
        cancel_url: `${process.env.FRONTEND_URL}/billing?cancelled=1&order=${orderId}`,
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