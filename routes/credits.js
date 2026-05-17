const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { protect, authorize, blockRestrictedUser } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const PlatformSettings = require('../models/PlatformSettings');

// ⭐ NEW: Razorpay instance — reads keys from Railway environment variables
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ⭐ UPDATED: Credit packs with better pricing
const CREDIT_PACKS = [
  { 
    id: 'starter',
    credits: 15, 
    price: 100,
    pricePerCredit: 6.67,
    savings: 0,
    popular: false
  },
  { 
    id: 'basic',
    credits: 40, 
    price: 250,
    pricePerCredit: 6.25,
    savings: 6,
    popular: false
  },
  { 
    id: 'popular',
    credits: 180, 
    price: 1000,
    pricePerCredit: 5.56,
    savings: 17,
    popular: true
  },
  { 
    id: 'pro',
    credits: 500, 
    price: 2500,
    pricePerCredit: 5.00,
    savings: 25,
    popular: false
  }
];

async function getCreditPacks() {
  try {
    const settings = await PlatformSettings.findOne({ singleton: true }).lean();
    const packs = settings && settings.creditPacks && settings.creditPacks.length
      ? settings.creditPacks
      : CREDIT_PACKS;
    return packs
      .filter(p => p.active !== false)
      .map(p => {
        const credits = parseInt(p.credits, 10) || 0;
        const price = parseInt(p.price, 10) || 0;
        return {
          id: p.id,
          label: p.label || p.id,
          credits,
          price,
          pricePerCredit: credits ? +(price / credits).toFixed(2) : 0,
          savings: p.savings || 0,
          popular: p.popular || p.id === 'popular',
          active: p.active !== false
        };
      });
  } catch(e) {
    return CREDIT_PACKS;
  }
}

// Get credit balance
router.get('/balance', protect, authorize('expert'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ 
      success: true, 
      credits: user.credits 
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching balance' 
    });
  }
});

// Get available credit packs
router.get('/packs', async (req, res) => {
  const packs = await getCreditPacks();
  res.json({ 
    success: true, 
    packs
  });
});

// Get transaction history
router.get('/transactions', protect, authorize('expert'), async (req, res) => {
  try {
    const { 
      type,
      page = 1,
      limit = 50
    } = req.query;
    
    const query = { user: req.user.id };
    if (type) query.type = type;
    
    const skip = (page - 1) * limit;
    
    const CreditTransaction = require('../models/CreditTransaction');
    const transactions = await CreditTransaction.find(query)
      .sort('-createdAt')
      .skip(skip)
      .limit(parseInt(limit))
      .populate('relatedApproach')
      .populate('relatedClient', 'name email')
      .populate('relatedRequest', 'title service')
      .lean();
    
    const total = await CreditTransaction.countDocuments(query);
    
    res.json({ 
      success: true, 
      count: transactions.length,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      transactions 
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching transactions' 
    });
  }
});

// ⭐ REAL: Create Razorpay order — frontend will open Razorpay checkout with this
router.get('/ledger', protect, authorize('expert'), async (req, res) => {
  try {
    const CreditTransaction = require('../models/CreditTransaction');
    const transactions = await CreditTransaction.find({ user: req.user.id })
      .sort('createdAt')
      .populate('relatedClient', 'name email')
      .populate('relatedRequest', 'title service')
      .lean();

    const byDate = new Map();
    transactions.forEach((tx) => {
      const date = tx.createdAt
        ? new Date(tx.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
        : 'unknown';
      if (!byDate.has(date)) {
        byDate.set(date, {
          date,
          opening: tx.balanceBefore || 0,
          purchase: 0,
          spent: 0,
          refund: 0,
          bonus: 0,
          inviteBonus: 0,
          closing: tx.balanceAfter || 0,
          count: 0
        });
      }
      const row = byDate.get(date);
      const amount = Number(tx.amount || 0);
      const desc = String(tx.description || '').toLowerCase();
      if (tx.type === 'purchase') row.purchase += amount;
      else if (tx.type === 'spent') row.spent += Math.abs(amount);
      else if (tx.type === 'refund') row.refund += amount;
      else if (tx.type === 'bonus' && desc.includes('invite')) row.inviteBonus += amount;
      else if (tx.type === 'bonus') row.bonus += amount;
      row.closing = tx.balanceAfter ?? row.closing;
      row.count += 1;
    });

    const ledger = Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
    res.json({ success: true, ledger, transactions });
  } catch (error) {
    console.error('Get ledger error:', error);
    res.status(500).json({ success: false, message: 'Error fetching credit ledger' });
  }
});

router.post('/purchase/initiate', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const { packId } = req.body;

    const creditPacks = await getCreditPacks();
    const pack = creditPacks.find(p => p.id === packId);
    if (!pack) {
      return res.status(400).json({ success: false, message: 'Invalid pack selected' });
    }

    // Create order on Razorpay (amount must be in paise: ₹1000 = 100000 paise)
    const order = await razorpay.orders.create({
      amount: pack.price * 100,
      currency: 'INR',
      receipt: `wi_${Date.now().toString().slice(-10)}`,
      notes: {
        userId: String(req.user.id),
        packId: pack.id,
        credits: String(pack.credits)
      }
    });

    // Save a pending transaction so we can credit the user after verification
    const transaction = await Transaction.create({
      user: req.user.id,
      type: 'credit_purchase',
      amount: pack.price,
      credits: pack.credits,
      paymentStatus: 'pending',
      paymentMethod: 'razorpay',
      description: `Purchase of ${pack.credits} credits`,
      metadata: {
        packId: pack.id,
        pricePerCredit: pack.pricePerCredit,
        razorpayOrderId: order.id
      }
    });

    res.json({
      success: true,
      orderId: order.id,             // Razorpay order id — frontend passes to checkout
      amount: order.amount,          // in paise
      currency: order.currency,
      transactionId: transaction._id, // our DB transaction id — frontend sends back on verify
      keyId: process.env.RAZORPAY_KEY_ID,
      prefill: {
        credits: pack.credits,
        packName: pack.id
      }
    });
  } catch (error) {
    console.error('Initiate payment error:', error);
    res.status(500).json({ success: false, message: 'Error initiating payment' });
  }
});

// ⭐ REAL: Verify Razorpay payment using cryptographic signature check
// Scenario covered: payment succeeded → verify signature → credit user
router.post('/purchase/verify', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, transactionId } = req.body;

    // ── SECURITY: Verify the payment signature ──────────────────────────────
    // Razorpay signs: order_id|payment_id with your key_secret
    // If signature doesn't match → payment is forged/tampered → reject
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.error('❌ Razorpay signature mismatch — possible fraud attempt');
      return res.status(400).json({ success: false, message: 'Payment verification failed: invalid signature' });
    }
    // ────────────────────────────────────────────────────────────────────────

    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    if (transaction.user.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    // Idempotency guard: if already credited (e.g. user clicked twice), just return success
    if (transaction.paymentStatus === 'success') {
      const user = await User.findById(req.user.id);
      return res.json({
        success: true,
        message: 'Payment already processed',
        newBalance: user.credits,
        transaction: { id: transaction._id, credits: transaction.credits, amount: transaction.amount, status: 'success' }
      });
    }

    // Fetch payment method details from Razorpay
    let paymentMethod = 'razorpay';
    let paymentInstrument = '';
    try {
      const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
      paymentMethod = paymentDetails.method || 'razorpay'; // upi / card / netbanking / wallet / emi
      if (paymentDetails.method === 'upi') {
        paymentInstrument = paymentDetails.vpa || ''; // e.g. user@oksbi
        // Detect UPI app from VPA
        const vpa = (paymentDetails.vpa || '').toLowerCase();
        if (vpa.includes('okhdfcbank') || vpa.includes('okaxis') || vpa.includes('oksbi') || vpa.includes('okicici')) {
          paymentInstrument = 'Google Pay (' + paymentDetails.vpa + ')';
        } else if (vpa.includes('paytm')) {
          paymentInstrument = 'Paytm (' + paymentDetails.vpa + ')';
        } else if (vpa.includes('ybl') || vpa.includes('axl') || vpa.includes('ibl')) {
          paymentInstrument = 'PhonePe (' + paymentDetails.vpa + ')';
        } else if (vpa.includes('apl')) {
          paymentInstrument = 'Amazon Pay (' + paymentDetails.vpa + ')';
        } else if (paymentDetails.vpa) {
          paymentInstrument = paymentDetails.vpa;
        }
      } else if (paymentDetails.method === 'card') {
        const card = paymentDetails.card || {};
        paymentInstrument = (card.network || '') + ' ' + (card.type || '') + (card.last4 ? ' ••••' + card.last4 : '');
        paymentInstrument = paymentInstrument.trim();
      } else if (paymentDetails.method === 'netbanking') {
        paymentInstrument = paymentDetails.bank || '';
      } else if (paymentDetails.method === 'wallet') {
        paymentInstrument = paymentDetails.wallet || '';
      } else if (paymentDetails.method === 'emi') {
        const card = paymentDetails.card || {};
        paymentInstrument = 'EMI — ' + (card.network || '') + (card.last4 ? ' ••••' + card.last4 : '');
      }
    } catch (e) { console.error('Failed to fetch Razorpay payment details:', e.message); }

    // Mark transaction as successful and store Razorpay IDs for future reference/refunds
    transaction.paymentStatus = 'success';
    transaction.paymentVerifiedAt = Date.now();
    transaction.metadata = {
      ...transaction.metadata,
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      razorpaySignature: razorpay_signature,
      paymentMethod: paymentMethod,
      paymentInstrument: paymentInstrument
    };
    await transaction.save();

    // Credit the user
    const user = await User.findById(req.user.id);
    const oldBalance = user.credits;
    user.credits += transaction.credits;
    await user.save();

 // ── Audit log: payment success ──
    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.user.id, role: 'expert', name: user.name },
        'credit_purchase',
        { type: 'user', id: String(user._id), name: user.name },
        {
          credits: transaction.credits,
          amountPaid: transaction.amount,
          razorpayPaymentId: razorpay_payment_id,
          razorpayOrderId: razorpay_order_id,
          paymentMethod: 'razorpay',
          packId: transaction.metadata && transaction.metadata.packId
        }
      ).catch(function() {});
    } catch (e) {}
    
    // Log to CreditTransaction for admin panel visibility
    try {
      const CreditTx = require('../models/CreditTransaction');
      await CreditTx.create({
        user: user._id,
        type: 'purchase',
        amount: transaction.credits,
        balanceBefore: oldBalance,
        balanceAfter: user.credits,
        description: `Credit purchase: ${transaction.credits} credits for ₹${transaction.amount}`,
        purchaseDetails: {
          packageSize: transaction.credits,
          amountPaid: transaction.amount,
          paymentMethod: 'razorpay',
          transactionId: String(transaction._id),
          razorpayPaymentId: razorpay_payment_id
        },
        initiatedBy: 'user',
        status: 'completed'
      });
    } catch (e) { console.error('CreditTx log failed:', e.message); }

    // Email expert
    try {
      const { sendExpertCreditsPurchased } = require('../utils/notificationEmailService');
      sendExpertCreditsPurchased({
        to: user.email, name: user.name,
        creditsPurchased: transaction.credits,
        amountPaid: transaction.amount,
        newBalance: user.credits, userId: user._id
      }).catch(() => {});
    } catch (e) {}

    res.json({
      success: true,
      message: `${transaction.credits} credits added successfully!`,
      newBalance: user.credits,
      transaction: {
        id: transaction._id,
        credits: transaction.credits,
        amount: transaction.amount,
        status: 'success',
        razorpayPaymentId: razorpay_payment_id
      }
    });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ success: false, message: 'Error verifying payment' });
  }
});

// ⭐ UPDATED: Manual credit addition (for testing/admin)
router.post('/add', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const { credits } = req.body;
    
    if (!credits || credits <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid credit amount' 
      });
    }
    
    const user = await User.findById(req.user.id);
    user.credits += credits;
    await user.save();
    
        await Transaction.create({
      user: req.user.id,
      type: 'credit_purchase',
      amount: 0,
      credits: credits,
      paymentStatus: 'success',
      paymentMethod: 'manual',
      description: 'Manual credit addition (test/demo)'
    });

    try {
      const CreditTx = require('../models/CreditTransaction');
      await CreditTx.create({
        user: user._id,
        type: 'purchase',
        amount: credits,
        balanceBefore: user.credits - credits,
        balanceAfter: user.credits,
        description: 'Manual credit addition: ' + credits + ' credits',
        // In /credits/add route, change purchaseDetails to:
purchaseDetails: {
  packageSize: credits,
  amountPaid: req.body.amountPaid || 0,  // ← accept from request
  paymentMethod: 'manual'
},
        initiatedBy: 'user',
        status: 'completed'
      });
    } catch(e) { console.error('CreditTx log failed:', e.message); }

     // Email expert: credits added
    try {
      const { sendExpertCreditsPurchased } = require('../utils/notificationEmailService');
      sendExpertCreditsPurchased({
        to: user.email, name: user.name,
        creditsPurchased: credits,
        amountPaid: req.body.amountPaid || 0,
        newBalance: user.credits, userId: user._id
      }).catch(() => {});
    } catch(e) {}
    
    res.json({ 
      success: true, 
      message: `${credits} credits added`, 
      newBalance: user.credits 
    });
  } catch (error) {
    console.error('Add credits error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding credits' 
    });
  }
});

// ⭐ NEW: Deduct credits (used when expert sends approach)
router.post('/deduct', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const { credits, approachId, description } = req.body;
    
    if (!credits || credits <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid credit amount' 
      });
    }
    
    const user = await User.findById(req.user.id);
    
    if (user.credits < credits) {
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient credits' 
      });
    }
    
        const oldBal = user.credits;
    user.credits -= credits;
    await user.save();

    // Log to CreditTransaction for admin panel
    try {
      const CreditTx = require('../models/CreditTransaction');
      await CreditTx.create({
        user: user._id,
        type: 'spent',
        amount: -credits,
        balanceBefore: oldBal,
        balanceAfter: user.credits,
        description: description || 'Credits spent on approach',
        relatedApproach: approachId || null,
        initiatedBy: 'user',
        status: 'completed'
      });
    } catch(e) { console.error('CreditTx log failed:', e.message); }

    await Transaction.create({
      user: req.user.id,
      type: 'approach_sent',
      amount: 0,
      credits: -credits,
      paymentStatus: 'success',
      description: description || 'Credits spent on approach',
      relatedApproach: approachId
    });
    
    res.json({ 
      success: true, 
      message: `${credits} credits deducted`, 
      newBalance: user.credits 
    });
  } catch (error) {
    console.error('Deduct credits error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deducting credits' 
    });
  }
});

// ⭐ NEW: Get credit statistics
router.get('/stats', protect, authorize('expert'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    const transactions = await Transaction.find({ user: req.user.id });
    
    const stats = {
      currentBalance: user.credits,
      totalPurchased: 0,
      totalSpent: 0,
      totalTransactions: transactions.length
    };
    
    transactions.forEach(t => {
      if (t.type === 'credit_purchase' && t.paymentStatus === 'success') {
        stats.totalPurchased += t.credits;
      } else if (t.type === 'approach_sent') {
        stats.totalSpent += Math.abs(t.credits);
      }
    });
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching statistics' 
    });
  }
});

// ═══════════════════════════════════════════════════════════
// ⭐ RAZORPAY WEBHOOK
// Handles all async payment events from Razorpay's servers
// Register URL in Razorpay Dashboard → Settings → Webhooks:
//   https://<your-railway-backend-url>/api/credits/webhook
//
// Scenarios covered:
//   payment.captured  → backup credit (if user closed browser before verify)
//   payment.failed    → mark transaction failed, log for admin
//   refund.processed  → deduct credits back when refund is confirmed
// ═══════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-razorpay-signature'];

    // Verify webhook authenticity — req.body is raw Buffer here (set up in server.js)
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.body)
      .digest('hex');

    if (expectedSignature !== receivedSignature) {
      console.error('❌ Webhook signature invalid');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const event = JSON.parse(req.body.toString());
    console.log(`📩 Razorpay webhook received: ${event.event}`);

    // ── EVENT: payment.captured ──────────────────────────────────────────────
    // Fires when payment succeeds on Razorpay's end.
    // This is a SAFETY NET for the case where:
    //   - User paid successfully on Razorpay
    //   - But their browser crashed/closed BEFORE our /verify route was called
    //   - Result: money deducted from user, but no credits given → we must fix this
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;

      const transaction = await Transaction.findOne({ 'metadata.razorpayOrderId': orderId });

      if (transaction && transaction.paymentStatus === 'pending') {
        console.log(`🔄 Webhook: crediting user for missed verify — order ${orderId}`);

        // Fetch payment method details from Razorpay
        let paymentMethod = payment.method || 'razorpay';
        let paymentInstrument = '';
        try {
          const vpa = (payment.vpa || '').toLowerCase();
          if (payment.method === 'upi') {
            if (vpa.includes('okhdfcbank') || vpa.includes('okaxis') || vpa.includes('oksbi') || vpa.includes('okicici')) {
              paymentInstrument = 'Google Pay (' + payment.vpa + ')';
            } else if (vpa.includes('paytm')) {
              paymentInstrument = 'Paytm (' + payment.vpa + ')';
            } else if (vpa.includes('ybl') || vpa.includes('axl') || vpa.includes('ibl')) {
              paymentInstrument = 'PhonePe (' + payment.vpa + ')';
            } else if (vpa.includes('apl')) {
              paymentInstrument = 'Amazon Pay (' + payment.vpa + ')';
            } else if (payment.vpa) {
              paymentInstrument = payment.vpa;
            }
          } else if (payment.method === 'card') {
            const card = payment.card || {};
            paymentInstrument = ((card.network || '') + ' ' + (card.type || '') + (card.last4 ? ' ••••' + card.last4 : '')).trim();
          } else if (payment.method === 'netbanking') {
            paymentInstrument = payment.bank || '';
          } else if (payment.method === 'wallet') {
            paymentInstrument = payment.wallet || '';
          }
        } catch (e) {}

        transaction.paymentStatus = 'success';
        transaction.paymentVerifiedAt = Date.now();
        transaction.metadata = {
          ...transaction.metadata,
          razorpayPaymentId: payment.id,
          creditedVia: 'webhook',
          paymentMethod: paymentMethod,
          paymentInstrument: paymentInstrument
        };
        await transaction.save();

        const user = await User.findById(transaction.user);
        if (user) {
          const oldBalance = user.credits;
          user.credits += transaction.credits;
          await user.save();

          try {
            const CreditTx = require('../models/CreditTransaction');
            await CreditTx.create({
              user: user._id,
              type: 'purchase',
              amount: transaction.credits,
              balanceBefore: oldBalance,
              balanceAfter: user.credits,
              description: `[Webhook recovery] ${transaction.credits} credits for ₹${transaction.amount}`,
              purchaseDetails: {
                packageSize: transaction.credits,
                amountPaid: transaction.amount,
                paymentMethod: 'razorpay',
                transactionId: String(transaction._id),
                razorpayPaymentId: payment.id
              },
              initiatedBy: 'system',
              status: 'completed'
            });
          } catch (e) { console.error('Webhook CreditTx log failed:', e.message); }

          try {
            const { sendExpertCreditsPurchased } = require('../utils/notificationEmailService');
            sendExpertCreditsPurchased({
              to: user.email, name: user.name,
              creditsPurchased: transaction.credits,
              amountPaid: transaction.amount,
              newBalance: user.credits, userId: user._id
            }).catch(() => {});
          } catch (e) {}

          try {
            const { logAudit } = require('../utils/audit');
            logAudit(
              { id: String(user._id), role: 'expert', name: user.name },
              'credit_purchase',
              { type: 'user', id: String(user._id), name: user.name },
              {
                credits: transaction.credits,
                amountPaid: transaction.amount,
                razorpayPaymentId: payment.id,
                paymentMethod: 'razorpay',
                creditedVia: 'webhook'
              }
            ).catch(function() {});
          } catch (e) {}
        }
      }
      // If paymentStatus is already 'success', do nothing — already credited via /verify
    }

    // ── EVENT: payment.failed ────────────────────────────────────────────────
    // Fires when a payment attempt fails (wrong UPI PIN, bank declined, timeout etc.)
    // We mark the transaction failed so the user can try again with a fresh order
    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;

      const transaction = await Transaction.findOne({ 'metadata.razorpayOrderId': orderId });

      if (transaction && transaction.paymentStatus === 'pending') {
        transaction.paymentStatus = 'failed';
        transaction.metadata = {
          ...transaction.metadata,
          failureReason: payment.error_description || 'Unknown error',
          failureCode: payment.error_code || '',
          razorpayPaymentId: payment.id
        };
        await transaction.save();
        console.log(`❌ Payment failed for order ${orderId}: ${payment.error_description}`);

        // Optional: log to FailedPayment model if you have one
        try {
          const FailedPayment = require('../models/FailedPayment');
          await FailedPayment.create({
            user: transaction.user,
            amount: transaction.amount,
            reason: payment.error_description || 'Unknown error',
            razorpayOrderId: orderId,
            razorpayPaymentId: payment.id
          });
        } catch (e) { /* FailedPayment model may not exist yet — safe to ignore */ }
      }
    }

    // ── EVENT: refund.processed ──────────────────────────────────────────────
    // Fires when you issue a refund from Razorpay dashboard or via API
    // We deduct the credits back from the user's balance
    if (event.event === 'refund.processed') {
      const refund = event.payload.refund.entity;
      const paymentId = refund.payment_id;
      const refundAmount = refund.amount / 100; // paise → rupees

      // Find the original transaction by razorpay payment id
      const transaction = await Transaction.findOne({ 'metadata.razorpayPaymentId': paymentId });

      if (transaction && transaction.paymentStatus === 'success') {
        transaction.paymentStatus = 'refunded';
        transaction.metadata = {
          ...transaction.metadata,
          refundId: refund.id,
          refundAmount: refundAmount,
          refundedAt: new Date()
        };
        await transaction.save();

        const user = await User.findById(transaction.user);
        if (user) {
          const oldBalance = user.credits;
          // Don't go below 0 in case user has spent some credits already
          user.credits = Math.max(0, user.credits - transaction.credits);
          await user.save();

          try {
            const CreditTx = require('../models/CreditTransaction');
            await CreditTx.create({
              user: user._id,
              type: 'refund',
              amount: -transaction.credits,
              balanceBefore: oldBalance,
              balanceAfter: user.credits,
              description: `Refund processed: ₹${refundAmount} — ${transaction.credits} credits removed`,
              initiatedBy: 'system',
              status: 'completed'
            });
          } catch (e) { console.error('Refund CreditTx log failed:', e.message); }

          console.log(`💸 Refund processed for user ${user._id}: ₹${refundAmount}, credits deducted: ${transaction.credits}`);
        }
      }
    }

    // Always respond 200 quickly — Razorpay retries if it doesn't get 200
    res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    // Still return 200 to stop Razorpay retrying — log the error for manual investigation
    res.status(200).json({ success: true });
  }
});

module.exports = router;
