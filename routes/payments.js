const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { protect, authorize } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════

const INSTAMOJO_API_KEY   = process.env.INSTAMOJO_API_KEY;
const INSTAMOJO_AUTH_TOKEN = process.env.INSTAMOJO_AUTH_TOKEN;
const INSTAMOJO_SALT      = process.env.INSTAMOJO_SALT;

// Switch to 'https://api.instamojo.com' after KYC approval
const INSTAMOJO_BASE_URL  = process.env.INSTAMOJO_BASE_URL || 'https://test.instamojo.com';

const BACKEND_URL  = process.env.BACKEND_URL  || 'https://workindex-production.up.railway.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://workindex.co.in';

// Credit packs — must match credits.js
const DEFAULT_CREDIT_PACKS = [
  { id: 'starter', label: 'Starter', credits: 15,  price: 100,  active: true },
  { id: 'basic',   label: 'Basic',   credits: 40,  price: 250,  active: true },
  { id: 'popular', label: 'Popular', credits: 180, price: 1000, active: true },
  { id: 'pro',     label: 'Pro',     credits: 500, price: 2500, active: true },
];

async function getCreditPacks() {
  try {
    const PlatformSettings = require('../models/PlatformSettings');
    const settings = await PlatformSettings.findOne({ singleton: true }).lean();
    const packs = settings && settings.creditPacks && settings.creditPacks.length
      ? settings.creditPacks
      : DEFAULT_CREDIT_PACKS;
    return packs.filter(p => p.active !== false);
  } catch(e) {
    return DEFAULT_CREDIT_PACKS;
  }
}

// ═══════════════════════════════════════════════════════════
// HELPER — Instamojo headers
// ═══════════════════════════════════════════════════════════

function instamojoHeaders() {
  return {
    'X-Api-Key': INSTAMOJO_API_KEY,
    'X-Auth-Token': INSTAMOJO_AUTH_TOKEN,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

// ═══════════════════════════════════════════════════════════
// HELPER — Verify Instamojo webhook signature
// ═══════════════════════════════════════════════════════════

function verifyWebhookSignature(data) {
  // Instamojo signs: amount|buyer|buyer_name|currency|fees|
  //                  mac|payment_id|payment_request_id|purpose|
  //                  shorturl|status (sorted keys, pipe-separated)
  const { mac, ...rest } = data;
  const message = Object.keys(rest)
    .sort()
    .map(k => rest[k])
    .join('|');
  const hmac = crypto
    .createHmac('sha1', INSTAMOJO_SALT)
    .update(message)
    .digest('hex');
  return hmac === mac;
}

// ═══════════════════════════════════════════════════════════
// POST /api/payment/create-order
// Called when expert clicks "Buy Credits"
// ═══════════════════════════════════════════════════════════

router.post('/create-order', protect, authorize('expert'), async (req, res) => {
  try {
    const { packId } = req.body;

    const creditPacks = await getCreditPacks();
    const pack = creditPacks.find(p => p.id === packId);
    if (!pack) {
      return res.status(400).json({ success: false, message: 'Invalid pack selected' });
    }

    const user = await User.findById(req.user.id);

    // Build form body for Instamojo
    const params = new URLSearchParams({
      purpose:      `WorkIndex ${pack.credits} Credits`,
      amount:       pack.price.toString(),
      buyer_name:   user.name || 'WorkIndex User',
      email:        user.email,
      phone:        user.phone || '',
      redirect_url: `${FRONTEND_URL}/payment-success.html`,
      webhook:      `${BACKEND_URL}/api/payment/webhook`,
      allow_repeated_payments: 'false',
      send_email:   'false',
      send_sms:     'false',
    });

    const response = await fetch(`${INSTAMOJO_BASE_URL}/api/1.1/payment-requests/`, {
      method: 'POST',
      headers: instamojoHeaders(),
      body: params.toString(),
    });

    const result = await response.json();

    if (!result.success) {
      console.error('Instamojo create error:', result);
      return res.status(500).json({ success: false, message: 'Failed to create payment request' });
    }

    const paymentRequest = result.payment_request;

    // Save pending transaction in DB
    await Transaction.create({
      user: req.user.id,
      type: 'credit_purchase',
      amount: pack.price,
      credits: pack.credits,
      paymentStatus: 'pending',
      paymentMethod: 'instamojo',
      description: `Purchase of ${pack.credits} credits`,
      metadata: {
        packId: pack.id,
        instamojoRequestId: paymentRequest.id,
      },
    });

    res.json({
      success: true,
      paymentUrl: paymentRequest.longurl,   // redirect user here
      requestId:  paymentRequest.id,
    });

  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ success: false, message: 'Error creating payment order' });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/payment/webhook
// Instamojo calls this automatically after payment
// ═══════════════════════════════════════════════════════════

router.post('/webhook', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const data = req.body;

    console.log('📩 Instamojo webhook received:', JSON.stringify(data));

    // 1. Verify signature
    if (!verifyWebhookSignature(data)) {
      console.error('❌ Webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    // 2. Only process successful payments
    if (data.status !== 'Credit') {
      console.log(`ℹ️ Payment status: ${data.status} — skipping`);
      return res.status(200).send('OK');
    }

    const paymentRequestId = data.payment_request_id;
    const paymentId        = data.payment_id;

    // 3. Find the pending transaction
    const transaction = await Transaction.findOne({
      'metadata.instamojoRequestId': paymentRequestId,
      paymentStatus: 'pending',
    });

    if (!transaction) {
      console.error('❌ No pending transaction found for requestId:', paymentRequestId);
      return res.status(200).send('OK'); // Always 200 to Instamojo
    }

    // 4. Prevent double-processing
    if (transaction.paymentStatus === 'success') {
      return res.status(200).send('OK');
    }

    // 5. Mark transaction successful
    transaction.paymentStatus    = 'success';
    transaction.paymentId        = paymentId;
    transaction.paymentVerifiedAt = new Date();
    await transaction.save();

    // 6. Add credits to user
    const user = await User.findById(transaction.user);
    const oldBalance = user.credits;
    user.credits += transaction.credits;
    await user.save();

    console.log(`✅ Added ${transaction.credits} credits to ${user.email}. New balance: ${user.credits}`);

    // 7. Log to CreditTransaction for admin panel
    try {
      const CreditTx = require('../models/CreditTransaction');
      await CreditTx.create({
        user:          user._id,
        type:          'purchase',
        amount:        transaction.credits,
        balanceBefore: oldBalance,
        balanceAfter:  user.credits,
        description:   `Credit purchase: ${transaction.credits} credits for ₹${transaction.amount}`,
        purchaseDetails: {
          packageSize:   transaction.credits,
          amountPaid:    transaction.amount,
          paymentMethod: 'instamojo',
          transactionId: paymentId,
        },
        initiatedBy: 'user',
        status: 'completed',
      });
    } catch (e) {
      console.error('CreditTx log failed:', e.message);
    }

    // 8. Send confirmation email to expert
    try {
      const { sendExpertCreditsPurchased } = require('../utils/notificationEmailService');
      sendExpertCreditsPurchased({
        to:               user.email,
        name:             user.name,
        creditsPurchased: transaction.credits,
        amountPaid:       transaction.amount,
        newBalance:       user.credits,
        userId:           user._id,
      }).catch(() => {});
    } catch (e) {}

    res.status(200).send('OK');

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).send('OK'); // Always 200 — Instamojo retries on failure
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/payment/status/:requestId
// Frontend polls this after redirect to confirm payment
// ═══════════════════════════════════════════════════════════

router.get('/status/:requestId', protect, authorize('expert'), async (req, res) => {
  try {
    const { requestId } = req.params;

    const transaction = await Transaction.findOne({
      'metadata.instamojoRequestId': requestId,
      user: req.user.id,
    });

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const user = await User.findById(req.user.id);

    res.json({
      success: true,
      status:     transaction.paymentStatus,
      credits:    transaction.credits,
      amount:     transaction.amount,
      newBalance: user.credits,
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ success: false, message: 'Error checking payment status' });
  }
});

module.exports = router;
