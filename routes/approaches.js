const express = require('express');
const router = express.Router();
const { protect, authorize, blockRestrictedUser } = require('../middleware/auth');
const Approach = require('../models/Approach');
const Request = require('../models/Request');
const User = require('../models/User');
const { logAudit } = require('../utils/audit');
const ExpertInvite = require('../models/ExpertInvite');
const CreditTransaction = require('../models/CreditTransaction');
const { calculateProfileCompleteness } = require('../utils/expertMetrics');

async function awardInviteCreditsIfEligible(expert, approach) {
  if (!expert || !expert.referredBy) return;
  const invite = await ExpertInvite.findOne({
    invitedUser: expert._id,
    inviter: expert.referredBy,
    status: { $ne: 'completed' }
  });
  if (!invite) return;
  const inviter = await User.findById(expert.referredBy);
  if (!inviter) return;
  const before = inviter.credits || 0;
  inviter.credits = before + 10;
  await inviter.save();
  invite.status = 'completed';
  invite.firstApproach = approach._id;
  invite.creditsAwarded = 10;
  invite.creditedAt = new Date();
  await invite.save();
  await CreditTransaction.log({
    user: inviter._id,
    type: 'bonus',
    amount: 10,
    balanceBefore: before,
    balanceAfter: inviter.credits,
    description: 'Invite reward: referred expert made first approach',
    relatedApproach: approach._id,
    initiatedBy: 'system'
  });
}

// ─── CREATE NEW APPROACH (EXPERT ONLY) ───
router.post('/', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const { request: requestId, message, quote } = req.body;
    
    console.log('💼 Expert approaching request:');
    console.log('  Expert:', req.user.id);
    console.log('  Request:', requestId);
    console.log('  Message:', message);
    
    // Check if request exists
    const request = await Request.findById(requestId);
    
    if (!request) {
      console.log('❌ Request not found:', requestId);
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }
    
    // ✅ NEW: Check if request already has 5 approaches (MAX LIMIT)
    if (!['pending', 'active'].includes(request.status)) {
      return res.status(400).json({
        success: false,
        message: 'This request is no longer open for approaches'
      });
    }

    const approachCount = await Approach.countDocuments({ request: requestId });
    
    if (approachCount >= 5) {
      console.log('❌ Request already has maximum approaches:', approachCount);
      return res.status(400).json({ 
        success: false, 
        message: 'This request has already received the maximum number of approaches (5)' 
      });
    }
    
    console.log('  Current approach count:', approachCount);
    
    // Check if already approached
    const existingApproach = await Approach.findOne({
      request: requestId,
      expert: req.user.id
    });
    
    if (existingApproach) {
      console.log('❌ Already approached this request');
      return res.status(400).json({ 
        success: false, 
        message: 'You have already approached this request' 
      });
    }
    
    // Check expert profile strength before allowing paid approaches
    const expert = await User.findById(req.user.id);
    const profileStrength = calculateProfileCompleteness(expert);
    if (profileStrength < 50) {
      return res.status(400).json({
        success: false,
        code: 'PROFILE_STRENGTH_REQUIRED',
        profileStrength,
        message: 'Complete at least 50% of your profile before approaching clients.'
      });
    }

    // Check expert has enough credits
    const creditsRequired = request.credits || 20;
    
    console.log('  Credits required:', creditsRequired);
    console.log('  Expert balance:', expert.credits || 0);
    
    if (!expert.credits || expert.credits < creditsRequired) {
      console.log('❌ Insufficient credits');
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient credits. Please purchase credits to approach this request.' 
      });
    }
    
    // Deduct credits
    expert.credits -= creditsRequired;
    await expert.save();
    
    console.log('  💰 Credits deducted. New balance:', expert.credits);

    
    // Create approach
    const approach = await Approach.create({
  request: requestId,
  expert: req.user.id,
  client: request.client,
  message: message || 'I am interested in helping with your request.',
  quote: quote || null,
  creditsSpent: creditsRequired,
  status: 'pending',
  contactUnlocked: true
});

// ─── LOG TO CREDIT TRANSACTION ───
    try {
      const CreditTx = require('../models/CreditTransaction');
      const clientForTx = await User.findById(request.client).select('name').lean();
      await CreditTx.create({
        user: expert._id,
        type: 'spent',
        amount: -creditsRequired,
        balanceBefore: expert.credits + creditsRequired,
        balanceAfter: expert.credits,
        description: `Approach sent for: ${request.title}`,
        relatedRequest: request._id,
        relatedApproach: approach._id,
        relatedClient: request.client,
        approachDetails: {
          requestTitle: request.title,
          requestService: request.service,
          clientName: clientForTx ? clientForTx.name : 'Unknown',
          creditsSpent: creditsRequired
        },
        initiatedBy: 'user',
        status: 'completed'
      });
    } catch(e) { console.error('CreditTx spend log failed:', e.message); }
    
    // Increment approach count on request
    request.approachCount = (request.approachCount || 0) + 1;
    request.responseCount = (request.responseCount || 0) + 1;
    await request.save();
  // ─── INCREMENT EXPERT'S TOTAL APPROACHES ───
    await User.findByIdAndUpdate(req.user.id, { $inc: { totalApproaches: 1 } });  
    await awardInviteCreditsIfEligible(expert, approach);
    
    console.log('✅ Approach created successfully!');
    console.log('  Approach ID:', approach._id);
    console.log('  Request approach count:', request.approachCount);
    
    // Email expert + client on approach submitted
    try {
      const { sendExpertApproachSubmitted, sendClientExpertApproached } = require('../utils/notificationEmailService');
      const clientUser = await User.findById(request.client).select('name email').lean();
      sendExpertApproachSubmitted({
        to: expert.email, name: expert.name,
        postTitle: request.title, clientName: clientUser ? clientUser.name : 'Client',
        creditsSpent: creditsRequired, remainingCredits: expert.credits, userId: expert._id
      }).catch(() => {});
      if (clientUser) {
        sendClientExpertApproached({
          to: clientUser.email, name: clientUser.name,
          postTitle: request.title, expertName: expert.name, userId: clientUser._id
        }).catch(() => {});
      }
    } catch(e) {}

// ── Audit: approach_submitted ──
    const clientForAudit = await User.findById(request.client).select('name').lean();
    logAudit(
      { id: req.user.id, role: 'expert', name: expert.name },
      'approach_submitted',
      { type: 'request', id: requestId, name: clientForAudit ? clientForAudit.name : 'Client' },
      { creditsSpent: creditsRequired, remainingCredits: expert.credits, requestTitle: request.title }
    ).catch(() => {});
    
    res.status(201).json({ 
      success: true, 
      approach,
      remainingCredits: expert.credits
    });
    
  } catch (error) {
    console.error('❌ Create approach error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Error creating approach' 
    });
  }
});

// ─── GET ALL APPROACHES (EXPERT: THEIR OWN, CLIENT: FOR THEIR REQUESTS) ───
router.get('/', protect, async (req, res) => {
  try {
    let query = {};
    
    if (req.user.role === 'expert') {
      query.expert = req.user.id;
    } else if (req.user.role === 'client') {
      query.client = req.user.id;
    }
    
    const approaches = await Approach.find(query)
      .populate('request', 'title service description budget location')
      .populate('expert', 'name specialization rating reviewCount profilePhoto')
      .populate('client', 'name email phone')
      .sort('-createdAt')
      .limit(100);
    
    console.log(`✅ Found ${approaches.length} approaches for ${req.user.role} ${req.user.id}`);
    
    res.json({ 
      success: true, 
      count: approaches.length, 
      approaches 
    });
    
  } catch (error) {
    console.error('❌ Get approaches error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching approaches' 
    });
  }
});

// ─── GET SINGLE APPROACH ───
router.get('/:id', protect, async (req, res) => {
  try {
    const approach = await Approach.findById(req.params.id)
      .populate('request', 'title service description budget location answers')
      .populate('expert', 'name specialization rating reviewCount profilePhoto email phone')
      .populate('client', 'name email phone');
    
    if (!approach) {
      return res.status(404).json({ 
        success: false, 
        message: 'Approach not found' 
      });
    }
    
    // Check authorization
    if (approach.expert._id.toString() !== req.user.id && approach.client._id.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    console.log(`✅ Approach ${req.params.id} retrieved`);


    // ── Audit: approach_viewed (only log when client views it) ──
    if (req.user.role === 'client') {
      logAudit(
        { id: req.user.id, role: 'client', name: req.user.name },
        'approach_viewed',
        { type: 'approach', id: approach._id, name: approach.request ? approach.request.title : '' },
        { expertId: approach.expert ? approach.expert._id : null, expertName: approach.expert ? approach.expert.name : '' }
      ).catch(() => {});
    }
    
    res.json({ success: true, approach });
    
  } catch (error) {
    console.error('❌ Get approach error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching approach' 
    });
  }
});

// ─── UPDATE APPROACH STATUS (CLIENT ONLY) ───
router.put('/:id/status', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['pending', 'accepted', 'rejected', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid approach status' });
    }

    const approach = await Approach.findById(req.params.id);
    
    if (!approach) {
      return res.status(404).json({ 
        success: false, 
        message: 'Approach not found' 
      });
    }
    
    // Verify ownership
    if (approach.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    approach.status = status;
    
    if (status === 'accepted') {
      approach.acceptedAt = new Date();
      
      // Update request with accepted expert
      const request = await Request.findById(approach.request);
      if (request) {
        request.acceptedExpert = approach.expert;
        request.status = 'active';
        await request.save();
      }
    }
    
    await approach.save();
    
    console.log(`✅ Approach ${req.params.id} status updated to ${status}`);

// ── Audit: approach_accepted / approach_rejected ──
    if (status === 'accepted' || status === 'rejected') {
      const expertForAudit = await User.findById(approach.expert).select('name').lean();
      logAudit(
        { id: req.user.id, role: 'client', name: req.user.name },
        status === 'accepted' ? 'approach_accepted' : 'approach_rejected',
        { type: 'approach', id: approach._id, name: expertForAudit ? expertForAudit.name : 'Expert' },
        { expertId: approach.expert ? approach.expert.toString() : null }
      ).catch(() => {});
    }
    
    res.json({ success: true, approach });
    
  } catch (error) {
    console.error('❌ Update approach status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating approach status' 
    });
  }
});

// ─── DELETE APPROACH ───
router.delete('/:id', protect, blockRestrictedUser, async (req, res) => {
  try {
    const approach = await Approach.findById(req.params.id);
    
    if (!approach) {
      return res.status(404).json({ 
        success: false, 
        message: 'Approach not found' 
      });
    }
    
    // Only expert who created it can delete
    if (approach.expert.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    await approach.deleteOne();
    
    console.log(`✅ Approach ${req.params.id} deleted`);
    
    res.json({ 
      success: true, 
      message: 'Approach deleted' 
    });
    
  } catch (error) {
    console.error('❌ Delete approach error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting approach' 
    });
  }
});

module.exports = router;
