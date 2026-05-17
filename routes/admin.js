// routes/admin.js
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const Admin    = require('../models/Admin');
const { attachExpertScores } = require('../utils/expertMetrics');
const Notification = require('../models/Notification');  // ← ADD THIS


const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ success: false, message: 'Not admin' });
    req.admin = await Admin.findById(decoded.id);
    if (!req.admin || !req.admin.isActive) return res.status(403).json({ success: false, message: 'Admin not found' });
    next();
  } catch (e) { res.status(401).json({ success: false, message: 'Invalid token' }); }
};

function cp(module, action) {
  return function(req, res, next) {
    if (req.admin.role === 'super_admin') return next();
    if (!req.admin.can(module, action)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: requires ' + module + '.' + action + ' permission'
      });
    }
    next();
  };
}

function superOnly(req, res, next) {
  if (req.admin.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super admin only' });
  }
  next();
}

function addDateFilter(query, field, from, to) {
  if (from || to) {
    query[field] = {};
    if (from) query[field].$gte = new Date(from);
    if (to)   query[field].$lte = new Date(new Date(to).setHours(23,59,59,999));
  }
  return query;
}

function safeModel(name) {
  try { return mongoose.models[name] || null; } catch(e) { return null; }
}

function sanitizeRequestAnswers(answers) {
  var cleaned = Object.assign({}, answers || {});
  if (cleaned.fullAddress && !cleaned.full_address) cleaned.full_address = cleaned.fullAddress;
  if (cleaned.clientLocation && !cleaned.client_location) cleaned.client_location = cleaned.clientLocation;
  if (cleaned.serviceLocationType && !cleaned.service_location_type) cleaned.service_location_type = cleaned.serviceLocationType;
  delete cleaned.fullAddress;
  delete cleaned.clientLocation;
  delete cleaned.serviceLocationType;
  return cleaned;
}

function safeReq(path) {
  try { return require(path); } catch(e) { return null; }
}

// ===========================================================
// LOGIN
// ===========================================================
router.post('/login', async (req, res) => {
  try {
    var adminId = req.body.adminId, password = req.body.password;
    if (!adminId || !password) return res.status(400).json({ success: false, message: 'Required' });
    var admin = await Admin.findOne({ adminId: adminId }).select('+password');
    if (!admin || !admin.isActive) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    var match = await admin.matchPassword(password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    admin.lastLogin = new Date(); await admin.save();
    var token = jwt.sign(
      { id: admin._id, isAdmin: true, role: admin.role, permissions: admin.permissions, allowedTabs: admin.allowedTabs || [] },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({
      success: true,
      token: token,
      admin: {
        id: admin._id,
        name: admin.name,
        adminId: admin.adminId,
        role: admin.role,
        permissions: admin.permissions,
        allowedTabs: admin.allowedTabs || []
      }
    });
    
  } catch (err) { res.status(500).json({ success: false, message: 'Login failed' }); }
});

// ===========================================================
// STATS
// ===========================================================
router.get('/stats', protect, async (req, res) => {
  try {
    var from = req.query.from, to = req.query.to;
    var User = mongoose.model('User');
    var Request = mongoose.model('Request');
    var Approach = safeReq('../models/Approach');
    var Ticket = safeModel('SupportTicket');
    var Rating = safeModel('Rating');
    var CreditTx = safeReq('../models/CreditTransaction');
    var dateQ = {};
    if (from || to) {
      dateQ.createdAt = {};
      if (from) dateQ.createdAt.$gte = new Date(from);
      if (to)   dateQ.createdAt.$lte = new Date(new Date(to).setHours(23,59,59,999));
    }
    var totalClients = await User.countDocuments(Object.assign({ role: 'client', isBanned: { $ne: true } }, dateQ));
    var totalExperts = await User.countDocuments(Object.assign({ role: 'expert', isBanned: { $ne: true } }, dateQ));
    var totalRequests   = await Request.countDocuments(dateQ);
    var totalApproaches = Approach ? await Approach.countDocuments(dateQ) : 0;
var openApproaches  = Approach ? await Approach.countDocuments(Object.assign({ status: 'pending' }, dateQ)) : 0;

// Add expert invites (customer_interest notifications) to approach counts
var Notification = safeModel('Notification');
var totalInvites = Notification ? await Notification.countDocuments(Object.assign({ type: 'customer_interest' }, dateQ)) : 0;
var openInvites  = Notification ? await Notification.countDocuments(Object.assign({ type: 'customer_interest', 'data.completed': { $ne: true } }, dateQ)) : 0;
totalApproaches += totalInvites;
openApproaches  += openInvites;
    var closedApproaches = totalApproaches - openApproaches;
    var pendingRefunds  = Ticket ? await Ticket.countDocuments({ status: 'pending_review' }) : 0;
    var openTickets     = Ticket ? await Ticket.countDocuments({ status: 'open' }) : 0;
    var totalReviews    = Rating ? await Rating.countDocuments(dateQ) : 0;
    var recentUsers     = await User.find(dateQ).sort({ createdAt: -1 }).limit(5).select('name email role createdAt credits');
    var credits = { totalPurchased: 0, totalSpent: 0, totalRefunded: 0 };
    if (CreditTx) {
      var agg = await CreditTx.aggregate([
  { $match: dateQ },
  { $group: {
    _id: '$type',
    total: { $sum: '$amount' },
    totalAmountPaid: { $sum: '$purchaseDetails.amountPaid' }  // ← nested path
}}
]);
agg.forEach(function(a) {
  if (a._id === 'purchase') {
    credits.totalPurchased = a.total;
    credits.totalAmountPaid = a.totalAmountPaid || 0;  // ← ADD THIS
  }
  if (a._id === 'spent')  credits.totalSpent = Math.abs(a.total);
  if (a._id === 'refund') credits.totalRefunded = a.total;
});
    }
    res.json({ success: true, stats: { totalClients, totalExperts, totalRequests, totalApproaches, openApproaches, closedApproaches, pendingRefunds, openTickets, totalReviews, credits }, recentUsers });
  } catch (err) { console.error('Stats error:', err); res.status(500).json({ success: false }); }
});
// ===========================================================
// DEBUG - TEMPORARY (remove after diagnosis)
// ===========================================================
router.get('/debug/credits', protect, async (req, res) => {
  try {
    var CreditTx = require('../models/CreditTransaction');
    var samples = await CreditTx.find({ type: 'purchase' }).limit(5).lean();
    res.json({
      count: samples.length,
      samples: samples.map(function(t) {
        return {
          _id: t._id,
          amount: t.amount,
          purchaseDetails: t.purchaseDetails,
          description: t.description,
          createdAt: t.createdAt
        };
      })
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
// ===========================================================
// ALL USERS  (search by name/email/phone)
// ===========================================================
router.get('/users', protect, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var role = req.query.role, search = req.query.search, from = req.query.from, to = req.query.to;
    var limit = parseInt(req.query.limit) || 100, skip = parseInt(req.query.skip) || 0;
    var query = {};
    if (role && role !== 'all') query.role = role;
    if (search) query.$or = [
      { name:  { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } }
    ];
    addDateFilter(query, 'createdAt', from, to);
            var users = await User.find(query)
      .select('name email phone role credits createdAt lastLogin isFlagged isBanned isRestricted isApproved isRejected warnings rating reviewCount profile specialization location kyc requests totalApproaches adminBoost adminRank profileViews questionnaireCompleted inviteCode')
      .sort({ createdAt: -1 }).skip(skip).limit(limit);
    if (role === 'expert') users = users.map(function(u) { return attachExpertScores(u); });
    var total = await User.countDocuments(query);
    res.json({ success: true, users, total });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ===========================================================
// USER BY ID
// ===========================================================
router.get('/users/:id', protect, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var Approach = safeReq('../models/Approach');
    var Request = mongoose.model('Request');
    var Ticket = safeModel('SupportTicket');
    var CreditTx = safeReq('../models/CreditTransaction');
    var from = req.query.from, to = req.query.to;
    var dateQ = {};
    if (from || to) {
      dateQ.createdAt = {};
      if (from) dateQ.createdAt.$gte = new Date(from);
      if (to)   dateQ.createdAt.$lte = new Date(new Date(to).setHours(23,59,59,999));
    }
    var uid = req.params.id;
            var user = await User.findById(uid);
    user = user ? user.toObject() : null;
    if (user) delete user.password;
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    var approaches = Approach ? await Approach.find(Object.assign({ expert: uid }, dateQ)).populate('request', 'title service status').populate('client', 'name email').sort({ createdAt: -1 }).limit(50) : [];
    var requests   = await Request.find(Object.assign({ client: uid }, dateQ)).sort({ createdAt: -1 }).limit(30);
    var tickets    = Ticket ? await Ticket.find({ user: uid }).sort({ createdAt: -1 }).limit(20) : [];
    var transactions = CreditTx ? await CreditTx.find(Object.assign({ user: uid }, dateQ)).populate('relatedRequest', 'title').populate('relatedClient', 'name').sort({ createdAt: -1 }).limit(50) : [];
    var creditSummary = null;
    if (user.role === 'expert' && CreditTx) {
      var agg2 = await CreditTx.aggregate([{ $match: { user: new mongoose.Types.ObjectId(uid) } }, { $group: { _id: '$type', total: { $sum: '$amount' } } }]);
      creditSummary = { purchased: 0, spent: 0, refunded: 0, closing: user.credits || 0 };
      agg2.forEach(function(a) {
        if (a._id === 'purchase') creditSummary.purchased = a.total;
        if (a._id === 'spent')    creditSummary.spent = Math.abs(a.total);
        if (a._id === 'refund')   creditSummary.refunded = a.total;
      });
      creditSummary.opening = creditSummary.purchased + creditSummary.refunded - creditSummary.spent - creditSummary.closing;
    }
    res.json({ success: true, user, approaches, requests, transactions, tickets, creditSummary });
  } catch (err) { console.error('Get user error:', err); res.status(500).json({ success: false }); }
});

router.get('/expert-boosts', protect, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var experts = await User.find({ role: 'expert' })
      .select('name email phone rating reviewCount totalApproaches adminBoost adminRank profileViews profile specialization servicesOffered location createdAt')
      .lean();
    experts = experts.map(function(e) { return attachExpertScores(e); })
      .sort(function(a, b) {
        var ar = Number(a.adminRank || 0);
        var br = Number(b.adminRank || 0);
        if (ar > 0 && br > 0 && ar !== br) return ar - br;
        if (ar > 0 && !br) return -1;
        if (!ar && br > 0) return 1;
        return (b.searchScore || 0) - (a.searchScore || 0);
      });
    res.json({ success: true, experts: experts });
  } catch (err) {
    console.error('Expert boosts error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/experts/:id/boost', protect, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var boost = Math.max(0, Math.min(100, Number(req.body.adminBoost || 0)));
    var rankInput = req.body.adminRank === '' || req.body.adminRank === null || req.body.adminRank === undefined
      ? null
      : Math.max(1, Number(req.body.adminRank || 0));
    var expert = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'expert' },
      { adminBoost: boost, adminRank: Number.isFinite(rankInput) ? rankInput : null },
      { new: true }
    ).select('name email rating reviewCount totalApproaches adminBoost adminRank profileViews profile specialization servicesOffered location');
    if (!expert) return res.status(404).json({ success: false, message: 'Expert not found' });
    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name || req.admin.adminId },
        'expert_admin_boost_updated',
        { type: 'user', id: expert._id, name: expert.name },
        { adminBoost: boost, adminRank: rankInput }
      ).catch(() => {});
    } catch(e) {}
    res.json({ success: true, expert: attachExpertScores(expert) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===========================================================
// NEW: ADJUST USER CREDITS
// ===========================================================
router.post('/users/:id/credits', protect, cp('credits','write'), async (req, res) => {
  try {
    var User = mongoose.model('User');
    var CreditTx = safeReq('../models/CreditTransaction');
    var { action, amount, reason, type: reqType } = req.body;
    amount = parseInt(amount);
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    var user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    var oldBalance = user.credits || 0;
    var newBalance;
    var txAmount;
    // Use explicit type from frontend if provided; otherwise infer from action
    var txType = reqType || (action === 'add' ? 'refund' : 'penalty');

    if (action === 'add') {
      newBalance = oldBalance + amount;
      txAmount = amount;
      // Override inferred type only if not explicitly set
      if (!reqType) txType = 'refund';
    } else if (action === 'deduct') {
      newBalance = Math.max(0, oldBalance - amount);
      txAmount = -(amount);
      if (!reqType) txType = 'penalty';
    } else if (action === 'set') {
      txAmount = amount - oldBalance;
      newBalance = amount;
      if (!reqType) txType = txAmount >= 0 ? 'refund' : 'penalty';
    } else {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    user.credits = newBalance;
    await user.save();

    // Log transaction if CreditTransaction model exists
    if (CreditTx) {
      await CreditTx.create({
        user: user._id,
        type: txType,
        amount: txAmount,
        balanceBefore: oldBalance,
        balanceAfter: newBalance,
        description: reason || ('Admin ' + txType + ': ' + (txAmount > 0 ? '+' : '') + txAmount + ' credits'),
        createdBy: 'admin'
      });
    }

try {
  var Notification = safeModel('Notification');
  if (Notification) {
    var creditMsg = action === 'add'
      ? '💰 ' + amount + ' credits have been added to your account by admin. New balance: ' + newBalance + ' credits.'
      : action === 'deduct'
      ? '⚠️ ' + amount + ' credits have been deducted from your account by admin. New balance: ' + newBalance + ' credits.'
      : '🔄 Your credit balance has been updated by admin. New balance: ' + newBalance + ' credits.';
    await Notification.create({
      user: user._id,
      type: 'admin_action',
      title: '💳 Credit Balance Updated',
      message: creditMsg + (reason ? ' Reason: ' + reason : ''),
      isRead: false
    });
  }
} catch(e) {}
    
try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.name },
    'admin_credit_adjusted',
    { type: 'user', id: req.params.id, name: user.name },
    { action, amount, oldBalance, newBalance, reason, txType }
  ).catch(() => {});
} catch(e) {}    
    
    res.json({ success: true, message: 'Credits updated', oldBalance, newBalance });
  } catch (err) { console.error('Credit adjust error:', err); res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// NEW: RESET USER PASSWORD
// ===========================================================
router.post('/users/:id/reset-password', protect, cp('users','write'), async (req, res) => {
  try {
    var User = mongoose.model('User');
    var { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

    var user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    var hashed = await bcrypt.hash(newPassword, 12);
    await User.findByIdAndUpdate(req.params.id, { password: hashed });

try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.name },
    'admin_password_reset',
    { type: 'user', id: req.params.id, name: user.name },
    { email: user.email }
  ).catch(() => {});
} catch(e) {}
    
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) { console.error('Reset PW error:', err); res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// APPROACHES
// ===========================================================
router.get('/approaches', protect, async (req, res) => {
  try {
    var Approach = safeReq('../models/Approach');
    if (!Approach) return res.json({ success: true, approaches: [], total: 0 });
    var status = req.query.status, from = req.query.from, to = req.query.to;
    var limit = parseInt(req.query.limit) || 100, skip = parseInt(req.query.skip) || 0;
    var query = {};
    if (status && status !== 'all') query.status = status;
    addDateFilter(query, 'createdAt', from, to);
    var approaches = await Approach.find(query).populate('expert', 'name email phone').populate('client', 'name email').populate('request', 'title service').sort({ createdAt: -1 }).skip(skip).limit(limit);
    var total = await Approach.countDocuments(query);
    res.json({ success: true, approaches, total });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ===========================================================
// ALL CHATS
// ===========================================================
router.get('/chats', protect, async (req, res) => {
  try {
    var Chat = safeModel('Chat');
    if (!Chat) return res.json({ success: true, chats: [] });
    var from = req.query.from, to = req.query.to;
    var limit = parseInt(req.query.limit) || 100;
    var query = {};
    addDateFilter(query, 'createdAt', from, to);
    var chats = await Chat.find(query).populate('expert', 'name email').populate('client', 'name email').populate('request', 'title service').sort({ updatedAt: -1 }).limit(limit);
    res.json({ success: true, chats, total: chats.length });
  } catch (err) { res.status(500).json({ success: false }); }
});

// CHAT MESSAGES - tries Message collection first, then embedded array
router.get('/chats/:id/messages', protect, async (req, res) => {
  try {
    var Chat = safeModel('Chat');
    var Message = safeModel('Message');
    var messages = [];
    var chatMeta = null;

    // Always fetch chat for metadata (expert/client names)
    if (Chat) {
      try {
        chatMeta = await Chat.findById(req.params.id)
          .populate('expert', 'name role')
          .populate('client', 'name role')
          .populate('request', 'title')
          .lean();
      } catch(e) {}
    }

    // Try Message collection first (separate docs pattern)
    if (Message) {
      try {
        messages = await Message.find({ chat: req.params.id })
          .populate('sender', 'name role profilePhoto')
          .sort({ createdAt: 1 })
          .limit(500);
        messages = messages.map(function(m) { return m.toObject ? m.toObject() : m; });
      } catch(e) {}
    }

    // If no messages found, try embedded messages array in Chat doc
    if (!messages.length && chatMeta && chatMeta.messages && chatMeta.messages.length) {
      // Try to populate embedded sender ObjectIds via User model
      var User = null;
      try { User = mongoose.model('User'); } catch(e) {}

      var senderIds = [];
      chatMeta.messages.forEach(function(m) {
        if (m.sender && typeof m.sender !== 'object') senderIds.push(String(m.sender));
      });

      var senderMap = {};
      if (User && senderIds.length) {
        try {
          var senders = await User.find({ _id: { $in: senderIds } }).select('name role').lean();
          senders.forEach(function(s) { senderMap[String(s._id)] = s; });
        } catch(e) {}
      }

      // Also map expert/client by _id for fallback
      if (chatMeta.expert) senderMap[String(chatMeta.expert._id || chatMeta.expert)] = chatMeta.expert;
      if (chatMeta.client) senderMap[String(chatMeta.client._id || chatMeta.client)] = chatMeta.client;

      messages = chatMeta.messages.map(function(m) {
        var senderId = m.sender ? String(m.sender._id || m.sender) : null;
        var populated = senderId ? (senderMap[senderId] || null) : null;
        return Object.assign({}, m, {
          sender: populated || m.sender,
          senderName: populated ? populated.name : (m.senderName || ''),
          senderRole: populated ? populated.role : (m.senderRole || m.role || '')
        });
      });
    }

    var meta = chatMeta ? {
      expert: chatMeta.expert,
      client: chatMeta.client,
      request: chatMeta.request,
      expertId: chatMeta.expert ? String(chatMeta.expert._id || chatMeta.expert) : null,
      clientId: chatMeta.client ? String(chatMeta.client._id || chatMeta.client) : null
    } : {};

    res.json({ success: true, messages: messages, chat: meta });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET single chat (for fallback)
router.get('/chats/:id', protect, async (req, res) => {
  try {
    var Chat = safeModel('Chat');
    if (!Chat) return res.status(404).json({ success: false });
    var chat = await Chat.findById(req.params.id)
      .populate('expert', 'name role profilePhoto')
      .populate('client', 'name role profilePhoto')
      .populate('request', 'title service')
      .lean();
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    res.json({ success: true, chat, messages: chat.messages || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// CREDIT TRANSACTIONS
// ===========================================================
router.get('/credits', protect, async (req, res) => {
  try {
    var CreditTx = safeReq('../models/CreditTransaction');
    if (!CreditTx) return res.json({ success: true, transactions: [], total: 0 });
    var type = req.query.type, from = req.query.from, to = req.query.to;
    var limit = parseInt(req.query.limit) || 100, skip = parseInt(req.query.skip) || 0;
    var query = {};
    if (type && type !== 'all') query.type = type;
    addDateFilter(query, 'createdAt', from, to);
    var transactions = await CreditTx.find(query).populate('user', 'name email role').populate('relatedRequest', 'title service').populate('relatedClient', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit);
    var total = await CreditTx.countDocuments(query);
    res.json({ success: true, transactions, total });
  } catch (err) { res.status(500).json({ success: false }); }
});

// EXPERT CREDIT LEDGER
router.get('/credits/expert/:id', protect, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var CreditTx = safeReq('../models/CreditTransaction');
    var user = await User.findById(req.params.id).select('name email credits');
    if (!user) return res.status(404).json({ success: false });
    var transactions = [], summary = { purchased: 0, spent: 0, refunded: 0, bonus: 0, closing: user.credits || 0 };
    if (CreditTx) {
      var from = req.query.from, to = req.query.to;
      var query = { user: req.params.id };
      addDateFilter(query, 'createdAt', from, to);
      transactions = await CreditTx.find(query).populate('relatedRequest', 'title service').populate('relatedClient', 'name').sort({ createdAt: -1 });
      transactions.forEach(function(tx) {
        if (tx.type === 'purchase') summary.purchased += tx.amount;
        if (tx.type === 'spent')    summary.spent += Math.abs(tx.amount);
        if (tx.type === 'refund')   summary.refunded += tx.amount;
        if (tx.type === 'bonus')    summary.bonus += tx.amount;
      });
      summary.opening = summary.purchased + summary.refunded + summary.bonus - summary.spent - summary.closing;
    }
    res.json({ success: true, user, transactions, summary });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ===========================================================
// TICKETS - GET ALL
// ===========================================================
router.get('/tickets', protect, async (req, res) => {
  try {
    var Ticket = safeModel('SupportTicket');
    if (!Ticket) return res.json({ success: true, tickets: [] });
    var status = req.query.status, from = req.query.from, to = req.query.to;
    var limit = parseInt(req.query.limit) || 100;
    var query = (status && status !== 'all') ? { status: status } : {};
    addDateFilter(query, 'createdAt', from, to);
    var tickets = await Ticket.find(query).populate('user', 'name email phone credits').sort({ createdAt: -1 }).limit(limit);
    res.json({ success: true, tickets, total: tickets.length });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ===========================================================
// NEW: TICKET BY ID
// ===========================================================
router.get('/tickets/:id', protect, async (req, res) => {
  try {
    var Ticket = safeModel('SupportTicket');
    if (!Ticket) return res.status(404).json({ success: false, message: 'Ticket model not found' });
    var ticket = await Ticket.findById(req.params.id).populate('user', 'name email phone credits');
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    res.json({ success: true, ticket });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// APPROVE REFUND (existing)
router.post('/tickets/:id/approve', protect, cp('tickets','write'), async (req, res) => {
  try {
    var Ticket = safeModel('SupportTicket');
    var User = mongoose.model('User');
    var CreditTx = safeReq('../models/CreditTransaction');
    if (!Ticket) return res.status(404).json({ success: false });
    var ticket = await Ticket.findById(req.params.id).populate('user');
    if (!ticket) return res.status(404).json({ success: false });
    if (ticket.status !== 'pending_review') return res.status(400).json({ success: false, message: 'Already processed' });
    var creditsToAdd = ticket.eligibleCredits || 0;
    var user = await User.findById(ticket.user._id);
    user.credits = (user.credits || 0) + creditsToAdd;
    await user.save();
    // Log credit transaction
    if (CreditTx) {
      await CreditTx.create({
        user: user._id,
        type: 'refund',
        amount: creditsToAdd,
        balanceBefore: user.credits - creditsToAdd,
        balanceAfter: user.credits,
        description: 'Admin approved refund for ticket #' + ticket._id
      });
    }
    ticket.status = 'resolved'; ticket.decision = 'REFUND_APPROVED';
    ticket.creditsRefunded = creditsToAdd; ticket.adminNote = req.body.note || ''; ticket.resolvedAt = new Date();
    await ticket.save();

    // ── Bell notification to user ──
try {
  if (Notification && ticket.user) {
    await Notification.create({
      user:    ticket.user._id,
      type:    'admin_action',
      title:   '✅ Refund Approved',
      message: creditsToAdd + ' credits have been added to your account. Your support ticket has been resolved.',
      isRead:  false
    });
  }
} catch (e) {}

// ── Audit log ──
try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.adminId },
    'ticket_refund_approved',
    { type: 'ticket', id: req.params.id, name: ticket.user ? ticket.user.name : 'User' },
    { creditsAdded: creditsToAdd, ticketId: String(ticket._id) }
  ).catch(() => {});
} catch (e) {}
    res.json({ success: true, message: 'Refund approved', creditsAdded: creditsToAdd });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// REJECT REFUND (existing)
router.post('/tickets/:id/reject', protect, cp('tickets','write'), async (req, res) => {
  try {
    var Ticket = safeModel('SupportTicket');
    if (!Ticket) return res.status(404).json({ success: false });
    var ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false });
    ticket.status = 'resolved'; ticket.decision = 'REFUND_REJECTED';
    ticket.adminNote = req.body.note || ''; ticket.resolvedAt = new Date();
    await ticket.save();

    // ── Bell notification to user ──
try {
  const Notification = safeModel('Notification');
  if (Notification && ticket.user) {
    await Notification.create({
      user:    ticket.user,
      type:    'admin_action',
      title:   '❌ Refund Request Rejected',
      message: 'Your refund request has been reviewed and could not be approved. If you have questions, please raise a new support ticket.',
      isRead:  false
    });
  }
} catch (e) {}

// ── Audit log ──
try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.adminId },
    'ticket_refund_rejected',
    { type: 'ticket', id: req.params.id, name: '' },
    { note: req.body.note || '', ticketId: String(ticket._id) }
  ).catch(() => {});
} catch (e) {}
    res.json({ success: true, message: 'Refund rejected' });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ===========================================================
// NEW: RESOLVE TICKET (non-refund tickets)
// ===========================================================
router.post('/tickets/:id/resolve', protect, cp('tickets','write'), async (req, res) => {
  try {
    var Ticket = safeModel('SupportTicket');
    if (!Ticket) return res.status(404).json({ success: false });
    var ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false });
    ticket.status = 'resolved';
    ticket.decision = 'RESOLVED_BY_ADMIN';
    ticket.adminNote = req.body.note || '';
    ticket.resolvedAt = new Date();
    await ticket.save();

    // ── Bell notification to user ──
try {
  const Notification = safeModel('Notification');
  if (Notification && ticket.user) {
    await Notification.create({
      user:    ticket.user,
      type:    'admin_action',
      title:   '✔️ Support Ticket Resolved',
      message: 'Your support ticket has been marked as resolved by our team.' + (req.body.note ? ' Note: ' + req.body.note : '') + ' Thank you for reaching out.',
      isRead:  false
    });
  }
} catch (e) {}

// ── Audit log ──
try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.adminId },
    'ticket_resolved',
    { type: 'ticket', id: req.params.id, name: '' },
    { note: req.body.note || '', ticketId: String(ticket._id) }
  ).catch(() => {});
} catch (e) {}
    res.json({ success: true, message: 'Ticket resolved' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// USER ACTION (existing + approve/reject for registrations)
// ===========================================================
router.post('/users/:id/action', protect, cp('users','write'), async (req, res) => {
  try {
    var User = mongoose.model('User');
    var action = req.body.action, reason = req.body.reason;
    var user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false });
    var msg = '';
    if      (action === 'ban')     { user.isBanned = true;  user.isFlagged = true;   msg = 'User banned'; }
    else if (action === 'unban')   { user.isBanned = false; user.isFlagged = false;  msg = 'User unbanned'; }
    else if (action === 'flag')    { user.isFlagged = true;  msg = 'User flagged'; }
    else if (action === 'unflag')  { user.isFlagged = false; msg = 'User unflagged'; }
    else if (action === 'warn') {
  user.warnings = (user.warnings || 0) + 1;
  user.lastWarning = { reason: reason, date: new Date(), by: req.admin.adminId };
  if (user.warnings >= 3) {
    user.isRestricted = true;
    user.markModified('isRestricted');
  }
  user.markModified('warnings');
  user.markModified('lastWarning');
  msg = 'Warning issued' + (user.warnings >= 3 ? ' — account restricted (3 warnings)' : ' (' + user.warnings + '/3)');
  // Email if now restricted
  if (user.warnings >= 3) {
    try {
      const { sendClientRestricted, sendExpertRestricted, sendAdminUserRestricted } = require('../utils/notificationEmailService');
      const sendFn = user.role === 'client' ? sendClientRestricted : sendExpertRestricted;
      sendFn({ to: user.email, name: user.name, reason: reason, warningCount: user.warnings, userId: user._id }).catch(() => {});
      sendAdminUserRestricted({ userName: user.name, userEmail: user.email, userRole: user.role, reason: reason, warningCount: user.warnings, restrictedBy: req.admin.adminId }).catch(() => {});
    } catch(e) {}
  }
}
      
    else if (action === 'unrestrict') {
  user.isRestricted = false;
  user.warnings = 0;
  user.markModified('isRestricted');
  user.markModified('warnings');
  msg = 'Restriction lifted and warnings reset';
}
    else if (action === 'approve') { user.isApproved = true; user.isRejected = false; msg = 'Expert approved'; }
    else if (action === 'reject')  { user.isRejected = true; user.isApproved = false; msg = 'Expert rejected'; }
    else return res.status(400).json({ success: false, message: 'Unknown action' });
    await user.save();
    try {
  var Notification = safeModel('Notification');
  if (Notification) {
    var actionMessages = {
      ban:        { title: '🚫 Account Suspended', msg: 'Your account has been suspended due to a violation of our platform policies. Please contact support if you believe this is an error.' },
      unban:      { title: '✅ Account Reinstated', msg: 'Your account suspension has been lifted. You can now access all platform features.' },
      warn:       { title: '⚠️ Warning Issued', msg: 'You have received a warning from admin' + (reason ? ': ' + reason : '.') + ' Warning count: ' + (user.warnings || 0) + '/3.' },
      flag:       { title: '🚩 Account Flagged', msg: 'Your account has been flagged for review. Some features may be temporarily limited.' },
      unflag:     { title: '✅ Account Flag Removed', msg: 'The flag on your account has been removed. All features are restored.' },
      restrict:   { title: '🔒 Account Restricted', msg: 'Your account has been restricted' + (reason ? ' due to: ' + reason : '.') + ' Contact support to resolve this.' },
      unrestrict: { title: '🔓 Account Restriction Lifted', msg: 'Your account restriction has been lifted and warnings have been reset. Welcome back!' },
      approve:    { title: '✅ Profile Approved', msg: 'Congratulations! Your expert profile has been approved. You can now receive and respond to client requests.' },
      reject:     { title: '❌ Profile Not Approved', msg: 'Your expert profile could not be approved at this time. Please contact support for more details.' }
    };
    var notifData = actionMessages[action];
    if (notifData) {
      await Notification.create({
        user: user._id,
        type: 'admin_action',
        title: notifData.title,
        message: notifData.msg,
        isRead: false
      });
    }
  }
} catch(e) {}
    
    try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.name },
    'admin_user_action',
    { type: 'user', id: req.params.id, name: user.name },
    { action, reason, result: msg }
  ).catch(() => {});
} catch(e) {}
    res.json({ success: true, message: msg, user: { isBanned: user.isBanned, isFlagged: user.isFlagged, warnings: user.warnings, isApproved: user.isApproved } });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ===========================================================
// NEW: RATINGS / REVIEWS
// ===========================================================
router.get('/ratings', protect, async (req, res) => {
  try {
    var Rating = safeModel('Rating');
    if (!Rating) return res.json({ success: true, ratings: [] });
    var search = req.query.search, from = req.query.from, to = req.query.to;
    var limit = parseInt(req.query.limit) || 100;
    var query = {};
    addDateFilter(query, 'createdAt', from, to);
    var ratings = await Rating.find(query)
      .populate('expert', 'name email')
      .populate('client', 'name email')
      .sort({ createdAt: -1 }).limit(limit);
    // filter by expert name if search
    if (search) {
      search = search.toLowerCase();
      ratings = ratings.filter(function(r) {
        return r.expert && (r.expert.name || '').toLowerCase().includes(search);
      });
    }
    res.json({ success: true, ratings, total: ratings.length });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/ratings/:id', protect, cp('reports','delete'), async (req, res) => {
  try {
    var Rating = safeModel('Rating');
    if (!Rating) return res.status(404).json({ success: false });
    var rating = await Rating.findById(req.params.id);
    if (!rating) return res.status(404).json({ success: false, message: 'Review not found' });

    // Update expert's rating average
    if (rating.expert) {
      var User = mongoose.model('User');
      var expert = await User.findById(rating.expert);
      if (expert && expert.reviewCount > 0) {
        expert.totalRatingSum = Math.max(0, (expert.totalRatingSum || 0) - rating.rating);
        expert.reviewCount = Math.max(0, expert.reviewCount - 1);
        expert.rating = expert.reviewCount > 0 ? (expert.totalRatingSum / expert.reviewCount).toFixed(2) : 0;
        await expert.save();
      }
    }

    await Rating.findByIdAndDelete(req.params.id);

  try {
  var Notification = safeModel('Notification');
  if (Notification && rating.expert) {
    var expertId = rating.expert._id || rating.expert;
    await Notification.create({
      user: expertId,
      type: 'admin_action',
      title: '⭐ A Review Was Removed',
      message: 'A ' + (rating.rating || '') + '-star review on your profile has been removed by admin for violating our review guidelines.',
      isRead: false
    });
  }
} catch(e) {}  
    try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.name },
    'admin_review_deleted',
    { type: 'rating', id: req.params.id, name: (rating.expert && rating.expert.name) || '' },
{ 
  reviewRating: rating.rating,
  expertName: rating.expert ? rating.expert.name : '',
  clientName: rating.client ? rating.client.name : ''
}
  ).catch(() => {});
} catch(e) {}
    res.json({ success: true, message: 'Review deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// NEW: POSTS / REQUESTS - EDIT & DELETE
// ===========================================================
router.get('/requests', protect, async (req, res) => {
  try {
    var Request = mongoose.model('Request');
    var search = req.query.search, status = req.query.status, from = req.query.from, to = req.query.to;
    var limit = parseInt(req.query.limit) || 100, skip = parseInt(req.query.skip) || 0;
    var query = {};
    if (status && status !== 'all') query.status = status;
    if (search) query.$or = [
      { title:   { $regex: search, $options: 'i' } },
      { service: { $regex: search, $options: 'i' } }
    ];
    addDateFilter(query, 'createdAt', from, to);
    var requests = await Request.find(query)
      .populate('client', 'name email')
      .sort({ createdAt: -1 }).skip(skip).limit(limit);
    var total = await Request.countDocuments(query);
    // Enrich with credits from accepted/completed approaches
    try {
      var Approach = safeModel('Approach');
      if (Approach) {
        var reqIds = requests.map(function(r) { return r._id; });
        var approaches = await Approach.find({ request: { $in: reqIds } })
          .select('request creditsSpent status').lean();
        var approachMap = {};
        approaches.forEach(function(a) {
          var rid = String(a.request);
          if (a.creditsSpent && (!approachMap[rid] || a.creditsSpent > approachMap[rid])) {
            approachMap[rid] = a.creditsSpent;
          }
        });
                requests = requests.map(function(r) {
          var ro = r.toObject ? r.toObject() : Object.assign({}, r);
          if (!ro.credits && approachMap[String(ro._id)]) ro.credits = approachMap[String(ro._id)];
          return ro;
        });
      }
    } catch(enrichErr) { /* non-fatal */ }
    res.json({ success: true, requests, total });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/requests/:id', protect, async (req, res) => {
  try {
    var Request = mongoose.model('Request');
    var request = await Request.findById(req.params.id).populate('client', 'name email');
    if (!request) return res.status(404).json({ success: false, message: 'Post not found' });
    res.json({ success: true, request });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/requests/:id', protect, cp('requests','write'), async (req, res) => {
  try {
    var Request = mongoose.model('Request');
    var { title, description, status, creditsRequired, answers, timeline, budget, location } = req.body;
    // Only update fields that were explicitly sent ? prevents accidental status override
    var updateFields = {};
    if (title       !== undefined) updateFields.title           = title;
    if (description !== undefined) updateFields.description     = description;
    if (status      !== undefined && status !== '') updateFields.status = status;
    if (creditsRequired !== undefined && creditsRequired !== null) updateFields.credits = parseInt(creditsRequired) || 0;
    if (answers     !== undefined && answers !== null) updateFields.answers = sanitizeRequestAnswers(answers);
    if (timeline    !== undefined && timeline !== '') updateFields.timeline = timeline;
    if (budget      !== undefined) updateFields.budget = budget;
    if (location    !== undefined && location !== '') updateFields.location = location;
    var request = await Request.findByIdAndUpdate(
  req.params.id,
  { $set: updateFields },
  { new: true }
).populate('client', 'name');
if (!request) return res.status(404).json({ success: false, message: 'Post not found' });

    try {
  var Notification = safeModel('Notification');
  if (Notification && request.client && request.client._id) {
    await Notification.create({
      user: request.client._id,
      type: 'admin_action',
      title: '✏️ Your Request Was Edited',
      message: 'Your request "' + (request.title || 'Untitled') + '" has been edited by admin. Please review it to ensure the details are correct.',
      isRead: false
    });
  }
} catch(e) {}
    try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.name },
    'admin_post_edited',
    { type: 'request', id: req.params.id, name: request.title || '' },
    { updatedFields: Object.keys(updateFields), postedBy: request.client ? request.client.name : '' }
  ).catch(() => {});
} catch(e) {}
res.json({ success: true, message: 'Post updated', request });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/requests/:id', protect, cp('requests','delete'), async (req, res) => {
  try {
    var Request = mongoose.model('Request');
    var request = await Request.findById(req.params.id).populate('client', 'name');
if (!request) return res.status(404).json({ success: false, message: 'Post not found' });
await Request.findByIdAndDelete(req.params.id);

    try {
  var Notification = safeModel('Notification');
  if (Notification && request.client && request.client._id) {
    await Notification.create({
      user: request.client._id,
      type: 'admin_action',
      title: '🗑️ Your Request Was Removed',
      message: 'Your request "' + (request.title || 'Untitled') + '" has been removed by admin for violating platform guidelines. Contact support if you have questions.',
      isRead: false
    });
  }
} catch(e) {}
    try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.name },
    'admin_post_deleted',
    { type: 'request', id: req.params.id, name: request.title || '' },
    { postedBy: request.client ? request.client.name : '' }
  ).catch(() => {});
} catch(e) {}
res.json({ success: true, message: 'Post deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// PAYMENTS — all transactions (success + failed + pending + refunded)
// ===========================================================
router.get('/payments', protect, async (req, res) => {
  try {
    var Transaction = safeReq('../models/Transaction');
    if (!Transaction) return res.json({ success: true, payments: [], total: 0 });
    var from = req.query.from, to = req.query.to;
    var status = req.query.status;
    var limit = parseInt(req.query.limit) || 200;
    var query = { type: 'credit_purchase' };
    if (status && status !== 'all') query.paymentStatus = status;
    addDateFilter(query, 'createdAt', from, to);
    var payments = await Transaction.find(query)
      .populate('user', 'name email phone credits')
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json({ success: true, payments: payments, total: payments.length });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/payments/failed', protect, async (req, res) => {
  try {
    var Transaction = safeReq('../models/Transaction');
    if (!Transaction) return res.json({ success: true, payments: [], total: 0 });
    var from = req.query.from, to = req.query.to;
    var query = { type: 'credit_purchase', paymentStatus: 'failed' };
    addDateFilter(query, 'createdAt', from, to);
    var payments = await Transaction.find(query)
      .populate('user', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ success: true, payments: payments, total: payments.length });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// NEW: COMMUNICATIONS - BULK EMAIL / HISTORY
// ===========================================================
router.post('/communications/send', protect, cp('users','write'), async (req, res) => {
  try {
    var User = mongoose.model('User');
    var CommLog = safeModel('CommunicationLog');
    var { subject, message, target, emails } = req.body;
    if (!subject || !message) return res.status(400).json({ success: false, message: 'Subject and message required' });

    var recipients = [];
    if (target === 'all') {
      recipients = await User.find({ isActive: true }).select('email name');
    } else if (target === 'experts') {
      recipients = await User.find({ role: 'expert', isActive: true }).select('email name');
    } else if (target === 'clients') {
      recipients = await User.find({ role: 'client', isActive: true }).select('email name');
    } else if (target === 'custom' && emails && emails.length) {
      recipients = emails.map(function(e) { return { email: e, name: e }; });
    }

    // Log the communication
    if (CommLog) {
      await CommLog.create({
        subject,
        message,
        target,
        recipientCount: recipients.length,
        sentBy: req.admin.adminId,
        recipientEmails: recipients.slice(0, 50).map(function(r) { return r.email; }) // store first 50
      });
    }

    // NOTE: Plug in your email provider here (Nodemailer / SendGrid / AWS SES)
    // For now we return success with recipient count
    // Example with nodemailer (add to your setup):
    // const transporter = nodemailer.createTransporter({...});
    // for (const r of recipients) { await transporter.sendMail({ to: r.email, subject, html: message }); }

    res.json({ success: true, message: 'Communication logged. Connect email provider to send.', recipientCount: recipients.length });
  } catch (err) { console.error('Comm error:', err); res.status(500).json({ success: false, message: err.message }); }
});

router.get('/communications/history', protect, async (req, res) => {
  
  
  try {
    var CommLog = safeModel('CommunicationLog');
    if (!CommLog) return res.json({ success: true, logs: [] });
    var logs = await CommLog.find({}).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, logs });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/communications/history/:id', protect, superOnly, async (req, res) => {
  try {
    var CommLog = safeModel('CommunicationLog');
    if (!CommLog) return res.status(503).json({ success: false, message: 'CommunicationLog model not found' });
    var log = await CommLog.findById(req.params.id);
    if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
    await CommLog.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Communication log deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===========================================================
// NEW: DIRECT MESSAGE (admin ? user inbox)
// ===========================================================
router.post('/users/:id/dm', protect, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var Chat = safeModel('Chat');
    var CommLog = safeModel('CommunicationLog');
    var { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });

    var user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (Chat) {
      // Find existing admin DM chat or create new one
      var chatQuery = { request: null, adminDM: true };
      if (user.role === 'expert') chatQuery.expert = user._id;
      else chatQuery.client = user._id;

      var chat = await Chat.findOne(chatQuery);
      if (!chat) {
        var chatData = {
          request: null,
          adminDM: true,
          lastMessage: message.substring(0, 100),
          lastMessageAt: new Date(),
          messages: []
        };
        if (user.role === 'expert') {
          chatData.expert = user._id;
          chatData.client = user._id; // dummy - same user
        } else {
          chatData.client = user._id;
          chatData.expert = user._id; // dummy - same user
        }
        chat = await Chat.create(chatData);
      }

      // Push message into embedded messages array
      chat.messages.push({
        sender: user._id, // use user as sender placeholder
        text: '[Admin]: ' + message,
        readAt: null
      });
      chat.lastMessage = '[Admin]: ' + message.substring(0, 80);
      chat.lastMessageAt = new Date();
      await chat.save();
    }

    if (CommLog) {
      await CommLog.create({
        type: 'dm',
        subject: 'Direct Message',
        message: message,
        target: 'custom',
        recipientCount: 1,
        recipientEmails: [user.email],
        sentBy: req.admin.adminId
      });
    }

    res.json({ success: true, message: 'Message sent to ' + user.name });
  } catch (err) {
    console.error('DM error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});



// ===========================================================
// NEW: ANNOUNCEMENTS (bell notification to users)
// ===========================================================
router.post('/communications/announce', protect, cp('users','write'), async (req, res) => {
  try {
    var User = mongoose.model('User');
    var CommLog = safeModel('CommunicationLog');
    var Notification = safeModel('Notification');
    var { target, title, message } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, message: 'Title and message required' });

    var query = { isActive: true };
    if (target === 'experts') query.role = 'expert';
    else if (target === 'clients') query.role = 'client';
    var recipients = await User.find(query).select('_id email name');

    // Create a Notification document for each user (if model exists)
    if (Notification) {
      var notifications = recipients.map(function(u) {
        return { user: u._id, title: title, message: message, type: 'announcement', isRead: false, sentBy: 'admin' };
      });
      // Insert in batches of 500
      for (var i = 0; i < notifications.length; i += 500) {
        await Notification.insertMany(notifications.slice(i, i + 500), { ordered: false });
      }
    }

    // Log it
    if (CommLog) {
      await CommLog.create({
        type: 'announcement',
        subject: title,
        message: message,
        target: target || 'all',
        recipientCount: recipients.length,
        sentBy: req.admin.adminId
      });
    }

    res.json({ success: true, message: 'Announcement sent', recipientCount: recipients.length });
  } catch (err) { console.error('Announce error:', err); res.status(500).json({ success: false, message: err.message }); }
});


// ===========================================================
// APPROACHES ? UPDATE STATUS & DELETE
// ===========================================================
router.put('/approaches/:id', protect, cp('requests','write'), async (req, res) => {
  try {
    var Approach = safeModel('Approach');
    if (!Approach) return res.status(503).json({ success: false, message: 'Approach model not available' });
    var { status } = req.body;
    var validStatuses = ['pending', 'accepted', 'rejected', 'completed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status: ' + status });
    }
    var approach = await Approach.findByIdAndUpdate(
      req.params.id,
      { $set: { status: status } },
      { new: true }
    ).populate('expert', 'name').populate('client', 'name').lean();
    if (!approach) return res.status(404).json({ success: false, message: 'Approach not found' });
    res.json({ success: true, message: 'Approach updated to ' + status, approach });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/approaches/:id', protect, cp('requests','delete'), async (req, res) => {
  try {
    var Approach = safeModel('Approach');
    if (!Approach) return res.status(503).json({ success: false, message: 'Approach model not available' });

    var approach = await Approach.findById(req.params.id)
      .populate('expert', 'name')
      .populate('client', 'name')
      .populate('request', 'title');
    if (!approach) return res.status(404).json({ success: false, message: 'Approach not found' });

    // ── Auto-refund credits to expert if they spent any ──
    var creditsRefunded = 0;
    if (approach.creditsSpent && approach.creditsSpent > 0) {
      try {
        var User = mongoose.model('User');
        var CreditTx = safeReq('../models/CreditTransaction');
        var expertId = approach.expert ? (approach.expert._id || approach.expert) : null;
        if (expertId) {
          var expert = await User.findById(expertId);
          if (expert) {
            var oldBal = expert.credits || 0;
            expert.credits = oldBal + approach.creditsSpent;
            await expert.save();
            creditsRefunded = approach.creditsSpent;
            if (CreditTx) {
              await CreditTx.create({
                user: expert._id,
                type: 'refund',
                amount: approach.creditsSpent,
                balanceBefore: oldBal,
                balanceAfter: expert.credits,
                description: 'Admin deleted approach — credits refunded automatically'
              });
            }
          }
        }
      } catch(refundErr) {
        console.error('Approach refund error:', refundErr.message);
      }
    }

    await Approach.findByIdAndDelete(req.params.id);

    try {
  var Notification = safeModel('Notification');
  if (Notification) {
    var expertNotifId = approach.expert ? (approach.expert._id || approach.expert) : null;
    if (expertNotifId) {
      var approachMsg = 'Your approach for "' + (approach.request ? approach.request.title : 'a request') + '" has been removed by admin.';
      if (creditsRefunded > 0) {
        approachMsg += ' ' + creditsRefunded + ' credits have been refunded to your account.';
      }
      await Notification.create({
        user: expertNotifId,
        type: 'admin_action',
        title: '🗑️ Approach Removed',
        message: approachMsg,
        isRead: false
      });
    }
  }
} catch(e) {}
    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name },
        'admin_approach_deleted',
        { type: 'approach', id: req.params.id, name: approach.expert ? approach.expert.name : '' },
        {
          expertName: approach.expert ? approach.expert.name : '',
          requestTitle: approach.request ? approach.request.title : '',
          creditsRefunded: creditsRefunded
        }
      ).catch(() => {});
    } catch(e) {}

    res.json({
      success: true,
      message: creditsRefunded > 0
        ? 'Approach deleted and ' + creditsRefunded + ' credits refunded to expert'
        : 'Approach deleted',
      creditsRefunded
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/chats/:id/messages', protect, async (req, res) => {
  try {
    var Chat = safeModel('Chat');
    var Message = safeModel('Message');
    if (!Chat) return res.json({ success: true, messages: [] });

    var chat = await Chat.findById(req.params.id)
      .populate({ path: 'expert', select: 'name profilePhoto role' })
      .populate({ path: 'client', select: 'name profilePhoto role' })
      .populate({ path: 'request', select: 'title service' })
      .lean();

    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    var messages = [];

    // Pattern 1: messages are embedded array in Chat doc
    if (chat.messages && chat.messages.length > 0) {
      // Populate sender refs if they are ObjectIds
      var populatedChat = await Chat.findById(req.params.id)
        .populate({ path: 'messages.sender', select: 'name role profilePhoto' })
        .lean();
      messages = populatedChat.messages || [];
    }

    // Pattern 2: messages are in separate Message collection
    if (messages.length === 0 && Message) {
      try {
        messages = await Message.find({ chat: req.params.id })
          .populate('sender', 'name role profilePhoto')
          .sort('createdAt')
          .lean();
      } catch (e) { /* Message model not found */ }
    }

    res.json({ success: true, messages: messages, chat: chat });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// TICKETS ? CREATE ON BEHALF OF USER (admin action)
// ===========================================================
router.post('/tickets/create-for-user', protect, async (req, res) => {
  try {
    var Ticket = safeModel('SupportTicket') || safeReq('../models/SupportTicket') || safeReq('../models/Ticket');
if (!Ticket) return res.status(503).json({ success: false, message: 'Ticket model not found - check model filename' });
    var User = mongoose.model('User');
    var { userId, subject, description, priority, adminNote } = req.body;
    if (!userId || !subject) {
      return res.status(400).json({ success: false, message: 'userId and subject are required' });
    }
    var user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    var ticketData = {
      issueType: subject,
      subject: subject,
      description: description || subject,
      priority: priority || 'medium',
      status: 'open',
      createdByAdmin: true,
      adminNote: adminNote || '',
      createdBy: req.admin.adminId
    };
    // Always set user field; also set expert field if expert
    ticketData.user = userId;
    if (user.role === 'expert') ticketData.expert = userId;

    var ticket = await Ticket.create(ticketData);
    res.status(201).json({ success: true, message: 'Ticket created', ticket });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
// ===========================================================
// KYC REVIEW
// ===========================================================
router.get('/kyc-requests', protect, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var status = req.query.status || 'pending';
    var users = await User.find(
      { 'kyc.status': status },
      'name email phone kyc createdAt'
    ).sort({ 'kyc.submittedAt': -1 });
    res.json({ success: true, users });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/kyc/:userId/approve', protect, cp('kyc','write'), async (req, res) => {
  try {
    var User = mongoose.model('User');
    await User.findByIdAndUpdate(req.params.userId, {
      'kyc.status':          'approved',
      'kyc.reviewedAt':      new Date(),
      'kyc.rejectionReason': null
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/kyc/:userId/reject', protect, cp('kyc','write'), async (req, res) => {
  try {
    var User = mongoose.model('User');
    var reason = req.body.reason || 'Document unclear or invalid';
    await User.findByIdAndUpdate(req.params.userId, {
      'kyc.status':          'rejected',
      'kyc.reviewedAt':      new Date(),
      'kyc.rejectionReason': reason
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===========================================================
// SETTINGS ? Password change + Danger zone + Stats
// ===========================================================
router.post('/settings/change-password', protect, async (req, res) => {
  try {
    var { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Both passwords required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }
    var admin = await Admin.findById(req.admin._id).select('+password');
    var match = await admin.matchPassword(currentPassword);
    if (!match) return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    admin.password = await bcrypt.hash(newPassword, 12);
    await admin.save();
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/settings/danger/:action', protect, superOnly, async (req, res) => {
  try {
    var action = req.params.action;
    var CommLog = safeModel('CommunicationLog');
    var FailedPayment = safeModel('FailedPayment');
    var deleted = 0;

    if (action === 'clearLogs' && CommLog) {
      var cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      var result = await CommLog.deleteMany({ createdAt: { $lt: cutoff } });
      deleted = result.deletedCount;
      res.json({ success: true, message: 'Cleared ' + deleted + ' communication logs older than 90 days' });
    } else if (action === 'clearFailedPayments' && FailedPayment) {
      var result2 = await FailedPayment.deleteMany({});
      deleted = result2.deletedCount;
      res.json({ success: true, message: 'Cleared ' + deleted + ' failed payment records' });
    } else {
      res.status(400).json({ success: false, message: 'Unknown action or model unavailable: ' + action });
    }
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
// ─── EXPERT INVITES (customer_interest notifications) ───
router.get('/interests', protect, async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'];
    if (!Notification) return res.json({ success: true, interests: [] });
    
    const from = req.query.from, to = req.query.to;
    const query = { type: 'customer_interest' };
    addDateFilter(query, 'createdAt', from, to);
    
    const interests = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    
    // Populate expert info
    const User = mongoose.model('User');
    const expertIds = interests.map(n => n.user).filter(Boolean);
    const experts = await User.find({ _id: { $in: expertIds } }).select('name email').lean();
    const expertMap = {};
    experts.forEach(e => { expertMap[String(e._id)] = e; });
    
    const enriched = interests.map(n => ({
  _id: n._id,
  expert: expertMap[String(n.user)] || { name: 'Unknown' },
  clientName: n.data?.clientName || 'Client',
  maskedPhone: n.data?.maskedPhone,
  maskedEmail: n.data?.maskedEmail,
  unlocked: n.data?.unlocked || false,
  completed: n.data?.completed || false,   // ← ADD THIS
  createdAt: n.createdAt
}));
    
    res.json({ success: true, interests: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ===========================================================
// REPORTS — GET ALL (aggregated from Request.reports)
// ===========================================================
router.get('/reports', protect, async (req, res) => {
  try {
    var Request = mongoose.model('Request');
    var User = mongoose.model('User');

    // Get all requests that have at least 1 report
    var requests = await Request.find({ 'reports.0': { $exists: true } })
      .populate('client', 'name email isRestricted isBanned')
      .select('title reports client isSuspended')
      .sort({ 'reports.0.date': -1 })
      .lean();

    var reports = [];
    requests.forEach(function(req) {
      (req.reports || []).forEach(function(rp) {
        reports.push({
          _id: String(rp._id || rp.by),
          reporterRole: 'expert',
          reporterName: null,
          reporterEmail: null,
          reporterId: String(rp.by),
          reportedUserId: req.client ? String(req.client._id) : '',
          reportedUserName: req.client ? req.client.name : '-',
          reportedUserEmail: req.client ? req.client.email : '',
          targetIsRestricted: req.client ? req.client.isRestricted : false,
          targetIsBanned: req.client ? req.client.isBanned : false,
          category: rp.reason || 'Suspicious request',
          message: rp.note || '',
          requestTitle: req.title || '',
          createdAt: rp.date || new Date()
        });
      });
    });

    // Populate reporter names (experts who reported)
    var reporterIds = reports.map(function(r) { return r.reporterId; }).filter(Boolean);
    if (reporterIds.length) {
      var reporters = await User.find({ _id: { $in: reporterIds } }).select('name email role').lean();
      var reporterMap = {};
      reporters.forEach(function(u) { reporterMap[String(u._id)] = u; });
      reports.forEach(function(r) {
        var reporter = reporterMap[r.reporterId];
        if (reporter) {
          r.reporterName = reporter.name;
          r.reporterEmail = reporter.email;
          r.reporterRole = reporter.role;
        }
      });
    }
// Also fetch expert reports (client-reported experts)
    const reportedExperts = await User.find({ 
      'reports.0': { $exists: true }, 
      role: 'expert' 
    })
      .select('name email reports isRestricted isBanned')
      .lean();

    reportedExperts.forEach(function(expert) {
      (expert.reports || []).forEach(function(rp) {
        reports.push({
          _id: String(rp._id || rp.reportedBy),
          reporterRole: 'client',
          reporterName: null,
          reporterEmail: null,
          reporterId: String(rp.reportedBy),
          reportedUserId: String(expert._id),
          reportedUserName: expert.name,
          reportedUserEmail: expert.email,
          targetIsRestricted: expert.isRestricted || false,
          targetIsBanned: expert.isBanned || false,
          category: rp.reason || 'Reported by client',
          message: rp.reason || '',
          requestTitle: '',
          createdAt: rp.date || new Date()
        });
      });
    });

    // Populate client reporter names
    const clientReporterIds = reportedExperts.flatMap(e => 
      (e.reports || []).map(r => String(r.reportedBy))
    ).filter(Boolean);

    if (clientReporterIds.length) {
      const clientReporters = await User.find({ 
        _id: { $in: clientReporterIds } 
      }).select('name email role').lean();
      const clientMap = {};
      clientReporters.forEach(u => { clientMap[String(u._id)] = u; });
      reports.forEach(function(r) {
        if (r.reporterRole === 'client' && !r.reporterName) {
          const cr = clientMap[r.reporterId];
          if (cr) { r.reporterName = cr.name; r.reporterEmail = cr.email; }
        }
      });
    }
    
    // Sort by date desc
    reports.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

    res.json({ success: true, reports: reports });
  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===========================================================
// SUSPENDED REQUESTS — GET ALL
// ===========================================================
router.get('/suspended-requests', protect, async (req, res) => {
  try {
    var Request = mongoose.model('Request');
    var requests = await Request.find({ isSuspended: true })
      .populate('client', 'name email')
      .sort({ suspendedAt: -1 })
      .lean();
    res.json({ success: true, requests });
  } catch (err) {
    console.error('Suspended requests error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===========================================================
// SUSPENDED REQUESTS — RESTORE OR DELETE
// ===========================================================
router.post('/suspended-requests/:id/action', protect, cp('requests','write'), async (req, res) => {
  try {
    var Request = mongoose.model('Request');
    var User = mongoose.model('User');
    var action = req.body.action; // 'restore' or 'delete'

    var request = await Request.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });

    if (action === 'restore') {
      request.isSuspended   = false;
      request.suspendedAt   = null;
      request.suspendReason = null;
      request.reports       = [];
      await request.save();
      // Unrestrict the client too
      await User.findByIdAndUpdate(request.client, { isRestricted: false });

      // ── Bell notification to client ──
try {
  const Notification = safeModel('Notification');
  if (Notification && request.client) {
    await Notification.create({
      user:    request.client,
      type:    'admin_action',
      title:   '✅ Your Request Has Been Restored',
      message: 'Your request "' + (request.title || 'Untitled') + '" has been reviewed and restored by admin. Your account restriction has also been lifted.',
      isRead:  false
    });
  }
} catch (e) {}

// ── Audit log ──
try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.adminId },
    'suspended_request_restored',
    { type: 'request', id: req.params.id, name: request.title || '' },
    { clientId: String(request.client) }
  ).catch(() => {});
} catch (e) {}
      res.json({ success: true, message: 'Request restored and client unrestricted' });

    } else if (action === 'delete') {
      await request.deleteOne();

      // ── Bell notification to client ──
try {
  const Notification = safeModel('Notification');
  if (Notification && request.client) {
    await Notification.create({
      user:    request.client,
      type:    'admin_action',
      title:   '🗑️ Your Request Was Permanently Removed',
      message: 'Your request "' + (request.title || 'Untitled') + '" has been permanently removed by admin after being flagged by multiple professionals. Contact support if you have questions.',
      isRead:  false
    });
  }
} catch (e) {}

// ── Audit log ──
try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: req.admin._id, role: 'admin', name: req.admin.adminId },
    'suspended_request_deleted',
    { type: 'request', id: req.params.id, name: request.title || '' },
    { clientId: String(request.client), reportCount: (request.reports || []).length }
  ).catch(() => {});
} catch (e) {}
      res.json({ success: true, message: 'Request permanently deleted' });

    } else {
      res.status(400).json({ success: false, message: 'Invalid action' });
    }
  } catch (err) {
    console.error('Suspended request action error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
// ═══════════════════════════════════════════════════════════
// ADD THESE ROUTES TO: routes/admin.js
// Place them before module.exports = router;
// ═══════════════════════════════════════════════════════════

// ── GET email settings ──
router.get('/email-settings', protect, async (req, res) => {
  try {
    const EmailSettings = require('../models/EmailSettings');
    let settings = await EmailSettings.findOne({ singleton: true });
    if (!settings) settings = await EmailSettings.create({ singleton: true });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── UPDATE email settings (toggle on/off) ──
router.put('/email-settings', protect, async (req, res) => {
  try {
    const EmailSettings = require('../models/EmailSettings');
    const updates = req.body; // { client_welcome: true, expert_banned: false, ... }
    // Remove any non-setting keys for safety
    const allowed = [
      'client_welcome','client_post_created','client_expert_approached',
      'client_post_suspended','client_post_stale_reminder','client_restricted','client_banned',
      'expert_welcome','expert_credits_purchased','expert_credits_refunded',
      'expert_approach_sent','expert_new_post','expert_invite_received','expert_restricted','expert_banned',
      'admin_post_suspended','admin_user_restricted','admin_ticket_escalated','admin_daily_tickets'
    ];
    const safe = {};
    allowed.forEach(k => { if (k in updates) safe[k] = !!updates[k]; });

    const settings = await EmailSettings.findOneAndUpdate(
      { singleton: true },
      { $set: safe },
      { new: true, upsert: true }
    );
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET email logs ──
router.get('/email-logs', protect, async (req, res) => {
  try {
    const EmailLog = require('../models/EmailLog');
    const { category, type, status, limit: lim, skip: sk } = req.query;
    const query = {};
    if (category && category !== 'all') query.category = category;
    if (type && type !== 'all') query.type = type;
    if (status && status !== 'all') query.status = status;
    const limit = parseInt(lim) || 100;
    const skip  = parseInt(sk)  || 0;
    const logs = await EmailLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);
    const total = await EmailLog.countDocuments(query);
    res.json({ success: true, logs, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── TEST: send daily digest manually ──
router.post('/email-test-digest', protect, async (req, res) => {
  try {
    const { sendAdminDailyTicketDigest } = require('../utils/notificationEmailService');
    await sendAdminDailyTicketDigest();
    res.json({ success: true, message: 'Digest sent (if tickets exist today)' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ─── REVENUE DASHBOARD ───────────────────────────────────────────────────────
router.get('/revenue', protect, async (req, res) => {
  try {
    var CreditTx = safeReq('../models/CreditTransaction');
    var Request  = mongoose.model('Request');
    var User = mongoose.model('User');
    var Approach = safeReq('../models/Approach');
    var Transaction = safeReq('../models/Transaction');
    if (!CreditTx) return res.json({ success: true, summary: {}, byPeriod: [], byService: [] });

    var period = req.query.period || 'month'; // day | week | month
    var from = req.query.from;
    var to = req.query.to;
    var creditMatch = {};
    var requestMatch = {};
    if (from || to) {
      creditMatch.createdAt = {};
      requestMatch.createdAt = {};
      if (from) {
        creditMatch.createdAt.$gte = new Date(from);
        requestMatch.createdAt.$gte = new Date(from);
      }
      if (to) {
        var toDate = new Date(new Date(to).setHours(23, 59, 59, 999));
        creditMatch.createdAt.$lte = toDate;
        requestMatch.createdAt.$lte = toDate;
      }
    }

    // ── Date grouping format ──
    var groupId;
    if (period === 'day') {
      groupId = { y: { $year:'$createdAt' }, m: { $month:'$createdAt' }, d: { $dayOfMonth:'$createdAt' } };
    } else if (period === 'week') {
      groupId = { y: { $year:'$createdAt' }, w: { $week:'$createdAt' } };
    } else {
      groupId = { y: { $year:'$createdAt' }, m: { $month:'$createdAt' } };
    }

    // ── Overall summary ──
    var summaryAgg = await CreditTx.aggregate([
      { $match: creditMatch },
      { $group: {
        _id: '$type',
        totalCredits: { $sum: '$amount' },
        totalAmount:  { $sum: '$purchaseDetails.amountPaid' },
        count: { $sum: 1 }
      }}
    ]);
    var summary = {
      purchased: 0, spent: 0, refunded: 0, bonus: 0, penalties: 0, expired: 0,
      inviteBonus: 0, amountReceived: 0, txCount: 0, purchaseCount: 0, refundCount: 0,
      paidExperts: 0, avgOrderValue: 0, refundRate: 0, netCredits: 0,
      openRequests: 0, completedRequests: 0, purgedRequests: 0, totalRequests: 0,
      totalApproaches: 0, completedApproaches: 0
    };
    summaryAgg.forEach(function(a) {
      summary.txCount += a.count || 0;
      if (a._id === 'purchase') { summary.purchased = a.totalCredits; summary.amountReceived = a.totalAmount || 0; summary.purchaseCount = a.count || 0; }
      if (a._id === 'spent')    summary.spent    = Math.abs(a.totalCredits || 0);
      if (a._id === 'refund')   { summary.refunded = Math.abs(a.totalCredits || 0); summary.refundCount = a.count || 0; }
      if (a._id === 'bonus')    summary.bonus    = a.totalCredits || 0;
      if (a._id === 'penalty')  summary.penalties = Math.abs(a.totalCredits || 0);
      if (a._id === 'expired')  summary.expired = Math.abs(a.totalCredits || 0);
    });
    var inviteBonusAgg = await CreditTx.aggregate([
      { $match: Object.assign({}, creditMatch, { type: 'bonus', description: /invite/i }) },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    summary.inviteBonus = inviteBonusAgg[0] ? inviteBonusAgg[0].total : 0;
    summary.netCredits = summary.purchased + summary.bonus + summary.refunded - summary.spent - summary.penalties - summary.expired;
    summary.paidExperts = await CreditTx.distinct('user', Object.assign({}, creditMatch, { type: 'purchase' })).then(function(ids) { return ids.length; });
    summary.avgOrderValue = summary.purchaseCount ? Math.round(summary.amountReceived / summary.purchaseCount) : 0;
    summary.refundRate = summary.purchaseCount ? Math.round((summary.refundCount / summary.purchaseCount) * 100) : 0;

    // ── By period (time series) ──
    var periodAgg = await CreditTx.aggregate([
      { $match: creditMatch },
      { $group: {
        _id: { period: groupId, type: '$type' },
        totalCredits: { $sum: '$amount' },
        totalAmount:  { $sum: '$purchaseDetails.amountPaid' },
        count: { $sum: 1 }
      }},
      { $sort: { '_id.period.y': 1, '_id.period.m': 1, '_id.period.d': 1, '_id.period.w': 1 } }
    ]);

    // Reshape into [{label, purchased, spent, refunded, amountReceived}]
    var periodMap = {};
    periodAgg.forEach(function(a) {
      var p = a._id.period;
      var label;
      if (period === 'day')   label = p.y + '-' + String(p.m).padStart(2,'0') + '-' + String(p.d).padStart(2,'0');
      else if (period === 'week') label = p.y + '-W' + String(p.w).padStart(2,'0');
      else label = p.y + '-' + String(p.m).padStart(2,'0');

      if (!periodMap[label]) periodMap[label] = { label, purchased: 0, spent: 0, refunded: 0, bonus: 0, penalties: 0, amountReceived: 0, txCount: 0 };
      var t = a._id.type;
      periodMap[label].txCount += a.count || 0;
      if (t === 'purchase') { periodMap[label].purchased += a.totalCredits; periodMap[label].amountReceived += (a.totalAmount || 0); }
      if (t === 'spent')    periodMap[label].spent    += Math.abs(a.totalCredits || 0);
      if (t === 'refund')   periodMap[label].refunded += Math.abs(a.totalCredits || 0);
      if (t === 'bonus')    periodMap[label].bonus += a.totalCredits || 0;
      if (t === 'penalty')  periodMap[label].penalties += Math.abs(a.totalCredits || 0);
    });
    var byPeriod = Object.values(periodMap);

    // ── Date filter for service breakdown ──
    var serviceDateQ = Object.assign({}, requestMatch);
    var svcPeriod = req.query.svcPeriod || 'all';
    if (svcPeriod !== 'all' && !from && !to) {
      var svcFrom = new Date();
      if (svcPeriod === 'day')   svcFrom.setDate(svcFrom.getDate() - 1);
      if (svcPeriod === 'week')  svcFrom.setDate(svcFrom.getDate() - 7);
      if (svcPeriod === 'month') svcFrom.setMonth(svcFrom.getMonth() - 1);
      serviceDateQ.createdAt = { $gte: svcFrom };
    }

    // ── By service category — from Requests ──
    var reqAgg = await Request.aggregate([
      { $match: serviceDateQ },
      { $group: {
        _id: '$service',
        count: { $sum: 1 },
        active: { $sum: { $cond: [{ $in: ['$status', ['pending', 'active']] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        purged: { $sum: { $cond: [{ $eq: ['$status', 'purged'] }, 1, 0] } },
        totalCredits: { $sum: '$credits' },
        totalViews: { $sum: '$viewCount' }
      }},
      { $sort: { count: -1 } }
    ]);

    // ── Expert count per service ──
    var approachMatch = serviceDateQ.createdAt ? { createdAt: serviceDateQ.createdAt } : {};
    var approachServiceAgg = Approach ? await Approach.aggregate([
      { $match: approachMatch },
      { $lookup: { from: 'requests', localField: 'request', foreignField: '_id', as: 'requestDoc' } },
      { $unwind: '$requestDoc' },
      { $group: {
        _id: '$requestDoc.service',
        approachCount: { $sum: 1 },
        approachCredits: { $sum: '$creditsSpent' },
        completedApproaches: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }
      }}
    ]) : [];
    var approachServiceMap = {};
    approachServiceAgg.forEach(function(a) {
      approachServiceMap[(a._id || '').toLowerCase()] = a;
    });

    var experts = await User.find({ role: 'expert' }).select('servicesOffered profile').lean();
    var expertCountMap = {};
    experts.forEach(function(expert) {
      var services = [];
      if (Array.isArray(expert.servicesOffered)) services = services.concat(expert.servicesOffered);
      if (expert.profile) {
        ['servicesOffered', 'expert_services', 'services'].forEach(function(key) {
          if (Array.isArray(expert.profile[key])) services = services.concat(expert.profile[key]);
          else if (expert.profile[key]) services.push(expert.profile[key]);
        });
      }
      Array.from(new Set(services.map(function(s) { return String(s || '').toLowerCase().trim(); }).filter(Boolean))).forEach(function(service) {
        expertCountMap[service] = (expertCountMap[service] || 0) + 1;
      });
    });

    // Total requests for share %
    var totalRequests = reqAgg.reduce(function(sum, r) { return sum + r.count; }, 0) || 1;

    var byService = reqAgg.map(function(r) {
      var serviceKey = (r._id || '').toLowerCase();
      var approachStats = approachServiceMap[serviceKey] || {};
      return {
        _id: r._id,
        count: r.count,
        active: r.active || 0,
        completed: r.completed || 0,
        purged: r.purged || 0,
        totalCredits: r.totalCredits || 0,
        totalViews: r.totalViews || 0,
        approachCount: approachStats.approachCount || 0,
        approachCredits: approachStats.approachCredits || 0,
        completedApproaches: approachStats.completedApproaches || 0,
        expertCount: expertCountMap[serviceKey] || 0,
        share: Math.round((r.count / totalRequests) * 100),
        conversionRate: r.count ? Math.round(((approachStats.approachCount || 0) / r.count) * 100) : 0
      };
    });

    var requestStatusAgg = await Request.aggregate([
      { $match: requestMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    requestStatusAgg.forEach(function(r) {
      summary.totalRequests += r.count || 0;
      if (r._id === 'completed') summary.completedRequests = r.count || 0;
      if (r._id === 'purged') summary.purgedRequests = r.count || 0;
      if (['pending', 'active'].indexOf(r._id) !== -1) summary.openRequests += r.count || 0;
    });
    var appDateMatch = creditMatch.createdAt ? { createdAt: creditMatch.createdAt } : {};
    summary.totalApproaches = Approach ? await Approach.countDocuments(appDateMatch) : 0;
    summary.completedApproaches = Approach ? await Approach.countDocuments(Object.assign({ status: 'completed' }, appDateMatch)) : 0;

    var paymentStatus = [];
    if (Transaction) {
      paymentStatus = await Transaction.aggregate([
        { $match: Object.assign({ type: 'credit_purchase' }, creditMatch.createdAt ? { createdAt: creditMatch.createdAt } : {}) },
        { $group: { _id: '$paymentStatus', count: { $sum: 1 }, amount: { $sum: '$amount' }, credits: { $sum: '$credits' } } },
        { $sort: { count: -1 } }
      ]);
    }

    var recentTransactions = await CreditTx.find(creditMatch)
      .populate('user', 'name email role')
      .populate('relatedRequest', 'title service')
      .populate('relatedClient', 'name email')
      .sort({ createdAt: -1 })
      .limit(12)
      .lean();

    var topExpertsBySpend = await CreditTx.aggregate([
      { $match: Object.assign({}, creditMatch, { type: 'spent' }) },
      { $group: { _id: '$user', spent: { $sum: { $abs: '$amount' } }, unlocks: { $sum: 1 } } },
      { $sort: { spent: -1 } },
      { $limit: 8 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { spent: 1, unlocks: 1, name: '$user.name', email: '$user.email', credits: '$user.credits' } }
    ]);

    var creditMix = [
      { label: 'Purchased', value: summary.purchased },
      { label: 'Spent', value: summary.spent },
      { label: 'Refunded', value: summary.refunded },
      { label: 'Bonus', value: summary.bonus },
      { label: 'Penalty', value: summary.penalties }
    ].filter(function(r) { return r.value > 0; });
    var funnel = [
      { label: 'Requests', value: summary.totalRequests },
      { label: 'Approaches', value: summary.totalApproaches },
      { label: 'Completed Requests', value: summary.completedRequests },
      { label: 'Purged Requests', value: summary.purgedRequests }
    ];

    res.json({ success: true, summary, byPeriod, byService, creditMix, paymentStatus, recentTransactions, topExpertsBySpend, funnel });
  } catch (err) {
    console.error('Revenue error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
// CANNED RESPONSES — ticket quick resolve
router.post('/tickets/:id/canned', protect, cp('tickets','write'), async (req, res) => {
  try {
    var Ticket = safeModel('SupportTicket');
    var User = mongoose.model('User');
    var CreditTx = safeReq('../models/CreditTransaction');
    if (!Ticket) return res.status(503).json({ success: false });

    var ticket = await Ticket.findById(req.params.id).populate('user', 'name email credits');
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    var { cannedType, note } = req.body;
    // cannedType: refund_approved | not_eligible | under_investigation | resolved_no_action | contact_support

    var cannedMessages = {
      refund_approved: {
        subject: '✅ Your Refund Has Been Approved',
        body: 'Hi {name}, your support ticket has been reviewed and your refund request has been approved. Credits have been added to your account. Thank you for your patience.'
      },
      not_eligible: {
        subject: '❌ Refund Request — Not Eligible',
        body: 'Hi {name}, after reviewing your ticket we found that this request does not meet our refund policy criteria. If you have further questions, please raise a new ticket with more details.'
      },
      under_investigation: {
        subject: '🔍 Your Ticket is Under Investigation',
        body: 'Hi {name}, we have received your ticket and our team is actively investigating the issue. We will update you within 24-48 hours. Thank you for your patience.'
      },
      resolved_no_action: {
        subject: '✔ Ticket Resolved',
        body: 'Hi {name}, your support ticket has been reviewed and resolved. No further action is required from our side. If you face any other issues, feel free to raise a new ticket.'
      },
      contact_support: {
        subject: '📞 Please Contact Support',
        body: 'Hi {name}, we need some additional information to resolve your ticket. Please email us at workindex318@gmail.com with your ticket ID and additional details.'
      }
    };

    var canned = cannedMessages[cannedType];
    if (!canned) return res.status(400).json({ success: false, message: 'Invalid canned type' });

    var userName = ticket.user ? ticket.user.name : 'User';
    var userEmail = ticket.user ? ticket.user.email : null;

    // Handle refund_approved — add credits
    if (cannedType === 'refund_approved' && ticket.eligibleCredits > 0) {
      var user = await User.findById(ticket.user._id);
      if (user) {
        var oldBal = user.credits || 0;
        user.credits = oldBal + ticket.eligibleCredits;
        await user.save();
// Mark the linked approach as refund approved
        // so client-side count excludes it
        if (ticket.relatedApproachId) {
          try {
            var Approach = require('../models/Approach');
            await Approach.findByIdAndUpdate(
              ticket.relatedApproachId,
              { $set: { refundApproved: true } }
            );
            // Also decrement the request's approachCount
            var linkedApproach = await Approach.findById(ticket.relatedApproachId).select('request').lean();
            if (linkedApproach && linkedApproach.request) {
              var Request = require('../models/Request');
              await Request.findByIdAndUpdate(
                linkedApproach.request,
                { $inc: { approachCount: -1, currentApproaches: -1, responseCount: -1 } }
              );
            }
          } catch(e) { console.error('Approach refund mark failed:', e.message); }
        }
        
        // ── Bell notification to expert ──
        try {
          var Notification = safeModel('Notification');
          if (Notification) {
            await Notification.create({
              user: user._id,
              type: 'admin_action',
              title: '✅ Credit Refund Approved',
              message: ticket.eligibleCredits + ' credits have been refunded to your account. Your support ticket has been resolved.',
              isRead: false
            });
          }
        } catch(e) {}
        
        if (CreditTx) {
          await CreditTx.create({
            user: user._id, type: 'refund',
            amount: ticket.eligibleCredits,
            balanceBefore: oldBal, balanceAfter: user.credits,
            description: 'Admin canned refund for ticket #' + ticket._id
          });
        }
        ticket.creditsRefunded = ticket.eligibleCredits;
      }
    }

        // ── Bell notification for refund rejection (not_eligible) ──
    if (cannedType === 'not_eligible') {
      try {
        var NotifModelReject = safeModel('Notification');
        if (NotifModelReject && ticket.user) {
          var rejectUserId = ticket.user._id || ticket.user;
          await NotifModelReject.create({
            user: rejectUserId,
            type: 'admin_action',
            title: '❌ Refund Request Not Approved',
            message: 'Your credit refund request has been reviewed and could not be approved at this time. ' +
                     (note ? 'Admin note: ' + note + ' ' : '') +
                     'If you believe this is incorrect, please raise a new ticket with additional details.',
            isRead: false
          });
        }
      } catch(e) {}
    }

    
    // Update ticket
    var finalStatus = (cannedType === 'under_investigation') ? 'open' : 'resolved';
    ticket.status = finalStatus;
    ticket.decision = cannedType.toUpperCase();
    ticket.adminNote = note || canned.body.replace('{name}', userName);
    if (finalStatus === 'resolved') ticket.resolvedAt = new Date();
    await ticket.save();

    // Send email to user
    if (userEmail) {
      try {
        var nodemailer = require('nodemailer');
        var transporter = nodemailer.createTransport({
          host: 'smtp-relay.brevo.com', port: 587,
          auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASS }
        });
        transporter.sendMail({
          from: process.env.FROM_EMAIL,
          to: userEmail,
          subject: canned.subject,
          html: '<p>' + canned.body.replace('{name}', userName) + '</p>' +
                (note ? '<p><b>Admin note:</b> ' + note + '</p>' : '') +
                '<p style="color:#888;font-size:12px;">Ticket ID: ' + ticket._id + '</p>'
        }).catch(function(e) { console.error('Canned email error:', e.message); });
      } catch(e) {}
    }

    // ── Bell notification to user ──
try {
  const NotifModel = safeModel('Notification');
  if (NotifModel && ticket.user) {
    const userId = ticket.user._id || ticket.user;
    const bellMessages = {
      refund_approved:       { title: '✅ Refund Approved', msg: 'Your refund has been approved. ' + (ticket.eligibleCredits || 0) + ' credits added to your account.' },
      not_eligible:          { title: '❌ Refund Not Eligible', msg: 'Your refund request has been reviewed and found ineligible. Please contact support for details.' },
      under_investigation:   { title: '🔍 Ticket Under Investigation', msg: 'Your support ticket is being actively investigated. We will update you within 24–48 hours.' },
      resolved_no_action:    { title: '✔️ Ticket Resolved', msg: 'Your support ticket has been reviewed and resolved. No further action needed.' },
      contact_support:       { title: '📞 Action Required', msg: 'Please contact us at workindex318@gmail.com with your ticket ID for further assistance.' }
    };
    const bell = bellMessages[cannedType];
    if (bell) {
      await NotifModel.create({
        user:    userId,
        type:    'admin_action',
        title:   bell.title,
        message: bell.msg + (note ? ' Admin note: ' + note : ''),
        isRead:  false
      });
    }
  }
} catch (e) {}
    // Audit log
    try {
      var { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name },
        'ticket_canned_response',
        { type: 'ticket', id: ticket._id, name: ticket.subject },
        { cannedType, userEmail }
      ).catch(function() {});
    } catch(e) {}

    res.json({ success: true, message: 'Canned response sent and ticket updated', ticket });
  } catch (err) {
    console.error('Canned response error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// AUDIT LOG — full filterable log
router.get('/audit', protect, async (req, res) => {
  try {
    var AuditLog = safeModel('AuditLog') || safeReq('../models/AuditLog');
    if (!AuditLog) return res.json({ success: true, logs: [], total: 0 });

    var { action, role, search, from, to, limit: lim, skip: sk } = req.query;
    var limit = parseInt(lim) || 100;
    var skip  = parseInt(sk)  || 0;
    var query = {};

    if (action && action !== 'all') query.action = action;
    if (role   && role   !== 'all') query.actorRole = role;
    if (search) query.$or = [
      { actorName:  { $regex: search, $options: 'i' } },
      { targetName: { $regex: search, $options: 'i' } },
      { action:     { $regex: search, $options: 'i' } }
    ];
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to)   query.createdAt.$lte = new Date(new Date(to).setHours(23,59,59,999));
    }

    var logs  = await AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);
    var total = await AuditLog.countDocuments(query);

    res.json({ success: true, logs, total });
  } catch (err) {
    console.error('Audit log error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// AUDIT LOG — activity for a specific user (for ticket modal)
router.get('/audit/user/:id', protect, async (req, res) => {
  try {
    var AuditLog = safeModel('AuditLog') || safeReq('../models/AuditLog');
    if (!AuditLog) return res.json({ success: true, logs: [] });

    var logs = await AuditLog.find({ actor: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Audit logs where this user is the TARGET (someone did something to them)
router.get('/audit/target/:id', protect, async (req, res) => {
  try {
    var AuditLog = safeModel('AuditLog') || safeReq('../models/AuditLog');
    if (!AuditLog) return res.json({ success: true, logs: [] });

    var logs = await AuditLog.find({ targetId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/danger/clear-category', protect, superOnly, async (req, res) => {
  try {
    const { category } = req.body;
    const Request = mongoose.model('Request');
    const User = mongoose.model('User');
    const Approach = safeReq('../models/Approach');
    const CreditTx = safeReq('../models/CreditTransaction');
    const Rating = safeModel('Rating');
    const Chat = safeModel('Chat');
    const Notification = safeModel('Notification');
    const Ticket = safeModel('SupportTicket');

    var result = 0;
    if (category === 'approaches'    && Approach)     { result = (await Approach.deleteMany({})).deletedCount; }
    else if (category === 'posts')                    { result = (await Request.deleteMany({})).deletedCount; }
    else if (category === 'experts')                  { result = (await User.deleteMany({ role: 'expert' })).deletedCount; }
    else if (category === 'clients')                  { result = (await User.deleteMany({ role: 'client' })).deletedCount; }
    else if (category === 'ratings'    && Rating)     { result = (await Rating.deleteMany({})).deletedCount; }
    else if (category === 'chats'      && Chat)       { result = (await Chat.deleteMany({})).deletedCount; }
    else if (category === 'tickets'    && Ticket)     { result = (await Ticket.deleteMany({})).deletedCount; }
    else if (category === 'notifications' && Notification) { result = (await Notification.deleteMany({})).deletedCount; }
    else if (category === 'credits'    && CreditTx)   { result = (await CreditTx.deleteMany({})).deletedCount; }
    else if (category === 'payments') {
      var TransactionModel = safeReq('../models/Transaction');
      if (!TransactionModel) return res.status(400).json({ success: false, message: 'Transaction model unavailable' });
      result = (await TransactionModel.deleteMany({ type: 'credit_purchase' })).deletedCount;
    }
    else return res.status(400).json({ success: false, message: 'Unknown category or model unavailable: ' + category });
    
    res.json({ success: true, message: 'Deleted ' + result + ' ' + category + ' records.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ─── EXPERT INVITE ACTIONS ────────────────────────────────────────────────────

// Mark invite as completed
router.post('/interests/:id/complete', protect, cp('requests','write'), async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'];
    if (!Notification) return res.status(503).json({ success: false, message: 'Notification model not found' });

    const notif = await Notification.findByIdAndUpdate(
      req.params.id,
      { $set: { 'data.completed': true } },
      { new: true }
    );
    if (!notif) return res.status(404).json({ success: false, message: 'Invite not found' });

    res.json({ success: true, message: 'Marked as completed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Reset invite to pending (undo unlock or completion)
router.post('/interests/:id/reset', protect, cp('requests','write'), async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'];
    if (!Notification) return res.status(503).json({ success: false, message: 'Notification model not found' });

    const notif = await Notification.findByIdAndUpdate(
      req.params.id,
      { $set: { 'data.completed': false, 'data.unlocked': false } },
      { new: true }
    );
    if (!notif) return res.status(404).json({ success: false, message: 'Invite not found' });

    res.json({ success: true, message: 'Reset to pending' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete invite permanently
router.delete('/interests/:id', protect, cp('requests','delete'), async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'];
    if (!Notification) return res.status(503).json({ success: false, message: 'Notification model not found' });

    // Fetch before deleting so we have expert + client info
    const notif = await Notification.findById(req.params.id).lean();
    if (!notif) return res.status(404).json({ success: false, message: 'Invite not found' });

    await Notification.findByIdAndDelete(req.params.id);

    const expertId   = notif.user;
    const clientName = notif.data?.clientName || 'a client';

    // ── Bell notification to expert ──
    try {
      await Notification.create({
        user:    expertId,
        type:    'admin_action',
        title:   '🗑️ Customer Invite Removed',
        message: 'An invite from ' + clientName + ' has been removed by admin.',
        isRead:  false
      });
    } catch (e) {}

    // ── Audit log ──
    try {
      const { logAudit } = require('../utils/audit');
      const User = mongoose.model('User');
      const expert = await User.findById(expertId).select('name').lean();
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.adminId },
        'admin_invite_deleted',
        { type: 'notification', id: req.params.id, name: expert ? expert.name : 'Expert' },
        { clientName, expertId: String(expertId) }
      ).catch(() => {});
    } catch (e) {}

    res.json({ success: true, message: 'Invite deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.get('/approaches/:id', protect, async (req, res) => {
  try {
    const Approach = safeReq('../models/Approach');
    if (!Approach) return res.status(503).json({ success: false });
    const approach = await Approach.findById(req.params.id)
      .populate('expert', 'name email')
      .populate('client', 'name email')
      .populate('request', 'title service');
    if (!approach) return res.status(404).json({ success: false, message: 'Approach not found' });
    res.json({ success: true, approach });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===========================================================
// ADMIN MANAGEMENT (super_admin only)
// ===========================================================

// GET all admins
router.get('/admins', protect, superOnly, async (req, res) => {
  try {
    var admins = await Admin.find({}).select('-password').sort({ createdAt: -1 });
    res.json({ success: true, admins });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// CREATE admin
router.post('/admins', protect, superOnly, async (req, res) => {
  try {
    var { adminId, name, email, password, role, permissions, template } = req.body;
    if (!adminId || !name || !password) {
      return res.status(400).json({ success: false, message: 'adminId, name and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    var exists = await Admin.findOne({ adminId });
    if (exists) return res.status(400).json({ success: false, message: 'adminId already taken' });

    // Resolve permissions — template takes priority over custom permissions
    var resolvedPerms = {};
    var tmpl = role === 'super_admin' ? 'super_admin' : (template || role);
    if (Admin.TEMPLATES[tmpl]) {
      resolvedPerms = Admin.TEMPLATES[tmpl];
    } else if (permissions) {
      resolvedPerms = permissions;
    } else {
      resolvedPerms = Admin.TEMPLATES['readonly'];
    }

    // Resolve allowedTabs from template
    var resolvedTabs = [];
    if (Admin.TEMPLATES[tmpl] && Admin.TEMPLATES[tmpl].allowedTabs) {
      resolvedTabs = Admin.TEMPLATES[tmpl].allowedTabs;
    }
    if (req.body.allowedTabs && Array.isArray(req.body.allowedTabs)) {
      resolvedTabs = req.body.allowedTabs;
    }

    var admin = await Admin.create({
      adminId, name, email: email || '',
      password,
      role: role || 'admin',
      permissions: resolvedPerms,
      allowedTabs: resolvedTabs,
      createdBy: req.admin.adminId,
      isActive: true
    });
    
    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name },
        'admin_created',
        { type: 'admin', id: admin._id, name: admin.name },
        { role: admin.role, createdAdminId: adminId }
      ).catch(() => {});
    } catch(e) {}

    var result = admin.toObject();
    delete result.password;
    res.status(201).json({ success: true, message: 'Admin created', admin: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// UPDATE admin permissions / role / status
router.put('/admins/:id', protect, superOnly, async (req, res) => {
  try {
    // Prevent super admin from demoting themselves
    if (req.params.id === String(req.admin._id) && req.body.role && req.body.role !== 'super_admin') {
      return res.status(400).json({ success: false, message: 'Cannot change your own role' });
    }

    var admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

    var { role, permissions, template, isActive, name, email } = req.body;

    if (name)     admin.name     = name;
    if (email)    admin.email    = email;
    if (isActive !== undefined) admin.isActive = isActive;
if (req.body.allowedTabs !== undefined) {
      admin.allowedTabs = req.body.allowedTabs;
      admin.markModified('allowedTabs');
    }
    
    if (role) {
      admin.role = role;
      // If role changed to super_admin, grant all permissions automatically
      if (role === 'super_admin') {
        admin.permissions = Admin.TEMPLATES['super_admin'];
      }
    }

    // Apply template if provided
    if (template && Admin.TEMPLATES[template]) {
      admin.permissions = Admin.TEMPLATES[template];
    } else if (permissions) {
      // Merge custom permissions — only update modules sent
      Object.keys(permissions).forEach(function(mod) {
        if (admin.permissions[mod] !== undefined) {
          admin.permissions[mod] = Object.assign({}, admin.permissions[mod].toObject ? admin.permissions[mod].toObject() : admin.permissions[mod], permissions[mod]);
        }
      });
      admin.markModified('permissions');
    }

    await admin.save();

    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name },
        'admin_updated',
        { type: 'admin', id: admin._id, name: admin.name },
        { role: admin.role, updatedBy: req.admin.adminId }
      ).catch(() => {});
    } catch(e) {}

    var result = admin.toObject();
    delete result.password;
    res.json({ success: true, message: 'Admin updated', admin: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE admin
router.delete('/admins/:id', protect, superOnly, async (req, res) => {
  try {
    if (req.params.id === String(req.admin._id)) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    }
    var admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

    await Admin.findByIdAndDelete(req.params.id);

    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name },
        'admin_deleted',
        { type: 'admin', id: req.params.id, name: admin.name },
        { deletedAdminId: admin.adminId }
      ).catch(() => {});
    } catch(e) {}

    res.json({ success: true, message: 'Admin deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET permission templates (for frontend dropdown)
router.get('/admins/templates', protect, superOnly, async (req, res) => {
  res.json({ success: true, templates: Object.keys(Admin.TEMPLATES) });
});

// TOGGLE admin active status
router.post('/admins/:id/toggle', protect, superOnly, async (req, res) => {
  try {
    if (req.params.id === String(req.admin._id)) {
      return res.status(400).json({ success: false, message: 'Cannot deactivate your own account' });
    }
    var admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
    admin.isActive = !admin.isActive;
    await admin.save();
    res.json({ success: true, message: admin.isActive ? 'Admin activated' : 'Admin deactivated', isActive: admin.isActive });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/payments/:id', protect, superOnly, async (req, res) => {
  try {
    var Transaction = safeReq('../models/Transaction');
    if (!Transaction) return res.status(503).json({ success: false, message: 'Transaction model not found' });
    var payment = await Transaction.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    await Transaction.findByIdAndDelete(req.params.id);
    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name },
        'admin_payment_deleted',
        { type: 'payment', id: req.params.id, name: payment.user ? String(payment.user) : '' },
        { amount: payment.amount, status: payment.paymentStatus }
      ).catch(() => {});
    } catch(e) {}
    res.json({ success: true, message: 'Payment record deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE USER PERMANENTLY
router.delete('/users/:id', protect, superOnly, async (req, res) => {
  try {
    var User = mongoose.model('User');
    var user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    var userName = user.name, userRole = user.role;

    // Clean up related data
    try {
      var Approach = safeReq('../models/Approach');
      var Request  = mongoose.model('Request');
      var CreditTx = safeReq('../models/CreditTransaction');
      var Chat     = safeModel('Chat');
      var Ticket   = safeModel('SupportTicket');
      var Notification = safeModel('Notification');
      var Rating   = safeModel('Rating');

      if (Approach)     { await Approach.deleteMany({ $or: [{ expert: req.params.id }, { client: req.params.id }] }); }
      if (userRole === 'client') { await Request.deleteMany({ client: req.params.id }); }
      if (CreditTx)     { await CreditTx.deleteMany({ user: req.params.id }); }
      if (Chat)         { await Chat.deleteMany({ $or: [{ expert: req.params.id }, { client: req.params.id }] }); }
      if (Ticket)       { await Ticket.deleteMany({ user: req.params.id }); }
      if (Notification) { await Notification.deleteMany({ user: req.params.id }); }
      if (Rating)       { await Rating.deleteMany({ $or: [{ expert: req.params.id }, { client: req.params.id }] }); }
    } catch(cleanupErr) {
      console.error('Cleanup error during user delete:', cleanupErr.message);
    }

    await User.findByIdAndDelete(req.params.id);

    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: req.admin._id, role: 'admin', name: req.admin.name },
        'admin_user_deleted',
        { type: 'user', id: req.params.id, name: userName },
        { role: userRole, deletedBy: req.admin.adminId }
      ).catch(() => {});
    } catch(e) {}

    res.json({ success: true, message: userName + ' (' + userRole + ') permanently deleted along with related data' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/credits/:id', protect, superOnly, async (req, res) => {
  try {
    var CreditTx = safeReq('../models/CreditTransaction');
    if (!CreditTx) return res.status(503).json({ success: false, message: 'Model not found' });
    var tx = await CreditTx.findById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
    await CreditTx.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Transaction record deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
