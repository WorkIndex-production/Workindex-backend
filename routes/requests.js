const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Request = require('../models/Request');

function sanitizeRequestAnswers(answers) {
  const cleaned = { ...(answers || {}) };
  if (cleaned.fullAddress && !cleaned.full_address) cleaned.full_address = cleaned.fullAddress;
  if (cleaned.clientLocation && !cleaned.client_location) cleaned.client_location = cleaned.clientLocation;
  if (cleaned.serviceLocationType && !cleaned.service_location_type) cleaned.service_location_type = cleaned.serviceLocationType;
  delete cleaned.fullAddress;
  delete cleaned.clientLocation;
  delete cleaned.serviceLocationType;
  return cleaned;
}
const Approach = require('../models/Approach');
const { logAudit } = require('../utils/audit');

const calculateCredits = (service, answers, defaultCredits) => {
  // ─── BASE CREDITS PER SERVICE ───────────────────────────
  // Change these numbers to adjust the default cost per service
  const base = {
    itr:          15,   // ITR Filing
    gst:          20,   // GST Services
    accounting:   25,   // Accounting / Bookkeeping
    audit:        30,   // Audit Services
    photography:  18,   // Photography
    development:  35    // App / Web Development
  };

  let credits = base[service] || defaultCredits || 20;
  if (!answers) return credits;

  // ─── ITR: bump based on income bracket & complexity ─────
  if (service === 'itr') {
    if (answers.itrAnnualIncome === '10-15')  credits = 18;
    if (answers.itrAnnualIncome === '15-20')  credits = 22;
    if (answers.itrAnnualIncome === 'above20') credits = 28;
    // Extra complexity: business income source
    if (answers.itrIncomeSources && answers.itrIncomeSources.includes('business')) credits += 5;
    // Extra: foreign income
    if (answers.itrIncomeSources && answers.itrIncomeSources.includes('foreign')) credits += 5;
  }

  // ─── GST: bump based on turnover ────────────────────────
  if (service === 'gst') {
    if (answers.gstTurnover === '5-20')   credits = 22;
    if (answers.gstTurnover === '20-50')  credits = 27;
    if (answers.gstTurnover === 'above50') credits = 35;
  }

  // ─── ACCOUNTING: bump based on transaction volume ────────
  if (service === 'accounting') {
    if (answers.accountingTransactions === '100-500')  credits = 28;
    if (answers.accountingTransactions === '500-2000') credits = 32;
    if (answers.accountingTransactions === 'above2000') credits = 40;
  }

  // ─── AUDIT: bump based on org turnover ──────────────────
  if (service === 'audit') {
    if (answers.auditTurnover === '1-5cr')    credits = 35;
    if (answers.auditTurnover === '5-20cr')   credits = 45;
    if (answers.auditTurnover === 'above20cr') credits = 60;
  }

  // ─── PHOTOGRAPHY: bump based on duration ────────────────
  if (service === 'photography') {
    if (answers.photographyDuration === 'half-day')  credits = 22;
    if (answers.photographyDuration === 'full-day')  credits = 28;
    if (answers.photographyDuration === 'multiple')  credits = 35;
    // Extra: videography included
    if (answers.photographyVideography === 'yes') credits += 5;
  }

  // ─── DEVELOPMENT: bump based on project type ────────────
  if (service === 'development') {
    if (answers.devProjectType === 'website')      credits = 30;
    if (answers.devProjectType === 'ecommerce')    credits = 38;
    if (answers.devProjectType === 'mobile-app')   credits = 45;
    if (answers.devProjectType === 'web-app')      credits = 50;
    if (answers.devProjectType === 'custom')       credits = 55;
    // Extra: needs ongoing maintenance
    if (answers.devMaintenance === 'yes') credits += 5;
  }

  // ─── GLOBAL CAP (optional — remove if you don't want a ceiling) ─
  const MAX_CREDITS = 60;
  credits = Math.min(credits, MAX_CREDITS);

  return credits;
};

async function getRequestCredits(service, answers) {
  try {
    const ServiceCategory = require('../models/ServiceCategory');
    const category = await ServiceCategory.findOne({ value: String(service || '').toLowerCase(), isActive: { $ne: false } })
      .select('creditCost')
      .lean();
    if (category && category.creditCost) return category.creditCost;
  } catch(e) {}

  let defaultCredits = 20;
  try {
    const PlatformSettings = require('../models/PlatformSettings');
    const settings = await PlatformSettings.findOne({ singleton: true }).lean();
    if (settings && settings.defaultPostCredits) defaultCredits = settings.defaultPostCredits;
  } catch(e) {}
  return calculateCredits(service, answers, defaultCredits);
}

function getExpertServiceValues(expert) {
  const profile = expert.profile || {};
  const values = []
    .concat(expert.servicesOffered || [])
    .concat(profile.servicesOffered || [])
    .concat(profile.expert_services || [])
    .concat(profile.services || []);

  return values
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

async function notifyExpertsAboutNewRequest(request) {
  try {
    const User = require('../models/User');
    const ServiceCategory = require('../models/ServiceCategory');
    const { sendExpertNewPost } = require('../utils/notificationEmailService');
    const service = String(request.service || '').toLowerCase();
    const category = await ServiceCategory.findOne({ value: service }).select('label searchAliases').lean();
    const serviceMatches = [service];
    if (category && category.label) serviceMatches.push(String(category.label).toLowerCase());
    if (category && category.searchAliases) {
      category.searchAliases.split(',').forEach(alias => {
        const value = alias.trim().toLowerCase();
        if (value) serviceMatches.push(value);
      });
    }
    const experts = await User.find({
      role: 'expert',
      emailVerified: true,
      isBanned: { $ne: true },
      isRestricted: { $ne: true },
      isActive: { $ne: false }
    }).select('name email servicesOffered profile preferences').lean();

    experts.forEach(expert => {
      const preferredServices = getExpertServiceValues(expert);
      const matchesService = preferredServices.length === 0 || preferredServices.some(value => serviceMatches.indexOf(value) !== -1);
      if (!matchesService) return;
      sendExpertNewPost({
        to: expert.email,
        name: expert.name,
        postTitle: request.title,
        service: request.service,
        credits: request.credits,
        location: request.location,
        userId: expert._id
      }).catch(() => {});
    });
  } catch(e) {
    console.error('New post expert notification error:', e.message);
  }
}
// ─── GET AVAILABLE REQUESTS FOR EXPERTS (NOT YET APPROACHED) ───
router.get('/available', protect, authorize('expert'), async (req, res) => {
  try {
    const myApproaches = await Approach.find({ 
      expert: req.user.id 
    }).select('request');
    
    const approachedRequestIds = myApproaches.map(a => a.request.toString());

    const { service, sort, search } = req.query;
    const query = {
      _id: { $nin: approachedRequestIds },
      status: { $in: ['pending', 'active'] }
    };
    if (service && service !== 'all') query.service = service;
    if (search) query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } }
    ];
    const sortMap = {
      newest:   '-createdAt',
      oldest:   'createdAt',
      budget_h: '-budget',
      budget_l: 'budget',
      credits_h: '-credits',
    };
    const sortStr = sortMap[sort] || '-createdAt';

    const requests = await Request.find(query)
      .sort(sortStr)
      .limit(100)
      .populate('client', 'name emailVerified')
      .lean();

    // ✅ NEW: Get approach counts for all requests
    const requestIds = requests.map(r => r._id);
    
    const approachCounts = await Approach.aggregate([
      { $match: { request: { $in: requestIds } } },
      { $group: { _id: '$request', count: { $sum: 1 } } }
    ]);
    
    // Create a map for quick lookup
    const countMap = {};
    approachCounts.forEach(item => {
      countMap[item._id.toString()] = item.count;
    });
    
    console.log('📊 Approach counts:', countMap);

    // ✅ NEW: Add approach counts to each request and filter out full ones
    const requestsWithCounts = requests.map(r => ({
      _id: r._id,
      title: r.title,
      description: r.description,
      service: r.service,
      client: r.client,
      timeline: r.timeline,
      location: r.location,
      budget: r.budget,
      credits: r.credits || 20,
      answers: r.answers || {},
      createdAt: r.createdAt,
      status: r.status,
      viewCount: r.viewCount || 0,
      // ✅ NEW: Approach counter fields
      currentApproaches: countMap[r._id.toString()] || 0,
      maxApproaches: 5,
      isFull: (countMap[r._id.toString()] || 0) >= 5
    }));
    
    // ✅ NEW: Filter out requests that already have 5 approaches
    const availableRequests = requestsWithCounts.filter(r => !r.isFull);

    console.log(`✅ Found ${availableRequests.length} available requests for expert ${req.user.id}`);
    console.log(`   (Filtered out ${requestsWithCounts.length - availableRequests.length} full requests)`);

    res.json({ 
      success: true, 
      count: availableRequests.length, 
      requests: availableRequests 
    });

  } catch (error) {
    console.error('❌ Get available requests error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching available requests' 
    });
  }
});

// ─── CREATE NEW REQUEST (CLIENT ONLY) ───
router.post('/', protect, authorize('client'), async (req, res) => {
  try {
    const { service, title, description, answers, timeline, budget, location } = req.body;
    const cleanAnswers = sanitizeRequestAnswers(answers);
    
    console.log('📝 Creating request:');
    console.log('  Client:', req.user.id);
    console.log('  Service:', service);
    console.log('  Title:', title);
    console.log('  Timeline:', timeline);
    console.log('  Budget:', budget);
    console.log('  Location:', location);
    console.log('  Answers keys:', cleanAnswers ? Object.keys(cleanAnswers).join(', ') : 'none');
    
    // Validate required fields
    if (!service) {
      console.log('❌ Validation failed: service is required');
      return res.status(400).json({ 
        success: false, 
        message: 'Service is required' 
      });
    }
    
    if (!title) {
      console.log('❌ Validation failed: title is required');
      return res.status(400).json({ 
        success: false, 
        message: 'Title is required' 
      });
    }
    
    if (!description) {
      console.log('❌ Validation failed: description is required');
      return res.status(400).json({ 
        success: false, 
        message: 'Description is required' 
      });
    }
    
    if (!location) {
      console.log('❌ Validation failed: location is required');
      return res.status(400).json({ 
        success: false, 
        message: 'Location is required' 
      });
    }
    
    // Calculate credits
    const credits = await getRequestCredits(service, cleanAnswers);
    console.log('  💰 Calculated credits:', credits);
    
    // Create request
    const request = await Request.create({
      client: req.user.id,
      service,
      title,
      description,
      answers: cleanAnswers,
      timeline: timeline || 'flexible',
      budget: budget || '0',
      location,
      credits,
      status: 'pending',
      viewCount: 0,
      responseCount: 0
    });
    
    console.log('✅ Request created successfully!');
    console.log('  ID:', request._id);
    console.log('  Service:', request.service);
    console.log('  Credits:', request.credits);

    // Email client: post created
    try {
      const { sendClientPostCreated } = require('../utils/notificationEmailService');
      sendClientPostCreated({
        to: req.user.email, name: req.user.name,
        postTitle: title, service: service, userId: req.user._id
      }).catch(() => {});
    } catch(e) {}

    notifyExpertsAboutNewRequest(request).catch(() => {});

 // ── Audit: request_created ──
    logAudit(
      { id: req.user.id, role: 'client', name: req.user.name },
      'request_created',
      { type: 'request', id: request._id, name: title },
      { service, credits }
    ).catch(() => {});   
    
    res.status(201).json({ 
      success: true, 
      request 
    });
    
  } catch (error) {
    console.error('❌ Create request error:', error.message);
    console.error('Error stack:', error.stack);
    
    // More detailed error response
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Error creating request',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ─── GET ALL REQUESTS ───
router.get('/', protect, async (req, res) => {
  try {
    let query = {};
    
    if (req.user.role === 'client') {
      query.client = req.user.id;
    } else {
      query.status = { $in: ['pending', 'active'] };
      if (req.query.service && req.query.service !== 'all') {
        query.service = req.query.service;
      }
    }
    
    const requests = await Request.find(query)
      .sort('-createdAt')
      .limit(50)
      .populate('client', 'name email phone')
      .lean();
    
    console.log(`✅ Found ${requests.length} requests for ${req.user.role} ${req.user.id}`);
    
    res.json({ 
      success: true, 
      count: requests.length, 
      requests 
    });
    
  } catch (error) {
    console.error('❌ Get requests error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching requests' 
    });
  }
});

// ─── GET SINGLE REQUEST BY ID ───
router.get('/:id', protect, async (req, res) => {
  try {
    const request = await Request.findById(req.params.id)
      .populate('client', 'name email phone');
    
    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }
    
    // Increment view count
    request.viewCount = (request.viewCount || 0) + 1;
    await request.save();
    
    console.log(`✅ Request ${req.params.id} viewed (count: ${request.viewCount})`);

    // ── Audit: request_viewed ──
    logAudit(
      { id: req.user.id, role: req.user.role, name: req.user.name },
      'request_viewed',
      { type: 'request', id: request._id, name: request.title },
      {}
    ).catch(() => {});
    
    res.json({ success: true, request });
    
  } catch (error) {
    console.error('❌ Get request error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching request' 
    });
  }
});

// ─── GET APPROACHES FOR A REQUEST (CLIENT ONLY) ───
router.get('/:id/approaches', protect, authorize('client'), async (req, res) => {
  try {
    const request = await Request.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }
    
    if (request.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    const approaches = await Approach.find({ request: req.params.id })
      .populate('expert', 'name specialization rating reviewCount profilePhoto')
      .sort('-createdAt');
    
    console.log(`✅ Found ${approaches.length} approaches for request ${req.params.id}`);

    // ── Audit: approach_list_viewed (client viewing who approached) ──
    logAudit(
      { id: req.user.id, role: 'client', name: req.user.name },
      'approach_list_viewed',
      { type: 'request', id: request._id, name: request.title },
      { count: approaches.length }
    ).catch(() => {});
    
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

// ─── UPDATE REQUEST STATUS (CLIENT ONLY) ───
router.put('/:id/status', protect, authorize('client'), async (req, res) => {
  try {
    const { status } = req.body;
    
    const request = await Request.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }
    
    if (request.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    request.status = status;
    await request.save();
    
    console.log(`✅ Request ${req.params.id} status updated to ${status}`);
    
    res.json({ success: true, request });
    
  } catch (error) {
    console.error('❌ Update status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating status' 
    });
  }
});

// ─── DELETE REQUEST (CLIENT ONLY) ───
router.delete('/:id', protect, authorize('client'), async (req, res) => {
  try {
    const request = await Request.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }
    
    if (request.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    await request.deleteOne();
    
    console.log(`✅ Request ${req.params.id} deleted`);
 logAudit(
      { id: req.user.id, role: 'client', name: req.user.name },
      'request_cancelled',
      { type: 'request', id: req.params.id, name: request.title },
      {}
    ).catch(() => {});
    
    res.json({ 
      success: true, 
      message: 'Request deleted' 
    });
    
  } catch (error) {
    console.error('❌ Delete request error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting request' 
    });
  }
});
// ─── MARK REQUEST AS COMPLETED (CLIENT ONLY) ───
router.post('/:id/complete', protect, authorize('client'), async (req, res) => {
  try {
    const { expertId } = req.body;
    
    console.log('🔍 Completing request:', req.params.id);
    console.log('   Expert ID from body:', expertId);
    
    const request = await Request.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }
    
    if (request.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    // Update request status
    request.status = 'completed';
    request.completedAt = Date.now();
    if (expertId) {
      request.completedBy = expertId;
    }
    await request.save();
    
    console.log('✅ Request status updated to completed');
    
    // Mark the approach as work completed
    if (expertId) {
      console.log('🔍 Looking for approach:', { expert: expertId, request: req.params.id });
      
      const allApproaches = await Approach.find({ request: req.params.id }).lean();
      console.log('📋 All approaches for this request:', allApproaches.length);
      allApproaches.forEach((a, i) => {
        console.log(`   Approach ${i+1}: expert=${a.expert.toString()}, match=${a.expert.toString() === expertId}`);
      });
      
            const approach = await Approach.findOneAndUpdate(
        { expert: expertId, request: req.params.id },
        { 
          isWorkCompleted: true,
          workCompletedAt: Date.now(),
          status: 'completed'
        },
        { new: true }
      );
      
      if (approach) {
        console.log('✅ Approach found and updated! isWorkCompleted:', approach.isWorkCompleted);
      } else {
        console.log('❌ NO APPROACH FOUND with that expert+request combination');
      }
    } else {
      console.log('⚠️ No expertId provided in request body');
    }

    // ── Audit: service_completed + service_received ──
    if (expertId) {
            const User = require('../models/User');
      const expertUser = await User.findById(expertId).select('name').lean();
      const expertName = expertUser ? expertUser.name : 'Expert';

      // service_completed — expert side, target = client name
      logAudit(
        { id: expertId, role: 'expert', name: expertName },
        'service_completed',
        { type: 'request', id: request._id, name: req.user.name },
        { requestTitle: request.title, clientId: req.user.id }
      ).catch(() => {});

      // service_received — client side, target = expert name
      logAudit(
        { id: req.user.id, role: 'client', name: req.user.name },
        'service_received',
        { type: 'request', id: request._id, name: expertName },
        { requestTitle: request.title, expertId }
      ).catch(() => {});
    } else {
      logAudit(
        { id: req.user.id, role: 'client', name: req.user.name },
        'service_received',
        { type: 'request', id: request._id, name: request.title },
        { expertId: null }
      ).catch(() => {});
    }
    
    res.json({ 
      success: true, 
      message: 'Request marked as completed',
      request 
    });
    
  } catch (error) {
    console.error('❌ Complete request error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error completing request' 
    });
  }
});
// ─── TRACK EXPERT VIEW ON REQUEST ───
router.post('/:id/view', protect, authorize('expert'), async (req, res) => {
  try {
    const request = await Request.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false });

    const alreadyViewed = (request.viewedBy || []).some(
      id => id.toString() === req.user._id.toString()
    );

    if (!alreadyViewed) {
      await Request.findByIdAndUpdate(req.params.id, {
        $inc: { viewCount: 1 },
        $addToSet: { viewedBy: req.user._id }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('View track error:', err);
    res.status(500).json({ success: false });
  }
});

router.get('/test-approach-update', protect, async (req, res) => {
  res.json({ 
    message: 'Approach update code is deployed',
    timestamp: new Date().toISOString()
  });
});
// ─── REPORT A REQUEST — POST /api/requests/:id/report ───
router.post('/:id/report', protect, authorize('expert'), async (req, res) => {
  try {
    const { reason, note } = req.body;
    const reporterId = req.user.id;

    const request = await Request.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });

    // Prevent duplicate reports from same expert
    const alreadyReported = (request.reports || []).some(r => r.by.toString() === reporterId);
    if (alreadyReported) return res.json({ success: false, message: 'You have already reported this request' });

    // Add report
    if (!request.reports) request.reports = [];
    request.reports.push({ by: reporterId, reason, note: note || '', date: new Date() });
    await request.save();

    const reportCount = request.reports.length;

    // Issue warning to client on every report + restrict at 3
    const User = require('../models/User');
    const client = await User.findById(request.client);
    if (client) {
      client.warnings = (client.warnings || 0) + 1;
      client.lastWarning = {
        reason: `Your post "${request.title}" was reported by a professional: ${reason || 'Suspicious request'}`,
        date: new Date(),
        by: 'system'
      };
      client.markModified('warnings');
      client.markModified('lastWarning');

      // At 3 reports: suspend post + restrict client
      if (reportCount >= 3) {
        request.isSuspended   = true;
        request.suspendedAt   = new Date();
        request.suspendReason = `Reported by ${reportCount} experts as suspicious`;
        await request.save();

        client.isRestricted = true;
        client.markModified('isRestricted');
        console.log(`🚫 Client ${client._id} auto-restricted after ${reportCount} reports on request ${request._id}`);
      }

      await client.save();
      console.log(`⚠️ Warning ${client.warnings}/3 issued to client ${client._id} — report on request ${request._id}`);
    }

    // Email notifications on report
    try {
      const { sendClientPostSuspended, sendClientRestricted, sendAdminPostSuspended, sendAdminUserRestricted } = require('../utils/notificationEmailService');
      if (reportCount >= 3 && client) {
        sendClientPostSuspended({ to: client.email, name: client.name, postTitle: request.title, reportCount, userId: client._id }).catch(() => {});
        sendClientRestricted({ to: client.email, name: client.name, reason: `Your post "${request.title}" was reported by ${reportCount} professionals`, warningCount: client.warnings, userId: client._id }).catch(() => {});
        sendAdminPostSuspended({ postTitle: request.title, postId: String(request._id), clientName: client.name, clientEmail: client.email, reportCount, reports: request.reports }).catch(() => {});
        sendAdminUserRestricted({ userName: client.name, userEmail: client.email, userRole: 'client', reason: `Post "${request.title}" suspended after ${reportCount} reports`, warningCount: client.warnings, restrictedBy: 'system' }).catch(() => {});
      }
    } catch(e) {}

    console.log(`🚩 Request ${request._id} reported by ${reporterId} — total reports: ${reportCount}`);
    res.json({ success: true, message: 'Report submitted. Thank you for keeping the platform safe.' });
    
  } catch (err) {
    console.error('❌ Report request error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE REQUEST (CLIENT ONLY) ───
router.put('/:id', protect, authorize('client'), async (req, res) => {
  try {
    const { title, description, budget, timeline } = req.body;

    const request = await Request.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    if (request.client.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Only allow editing pending/active requests
    if (!['pending', 'active'].includes(request.status)) {
      return res.status(400).json({ success: false, message: 'Cannot edit a completed or cancelled request' });
    }

    if (title)       request.title       = title;
    if (description) request.description = description;
    if (budget)      request.budget      = budget;
    if (timeline)    request.timeline    = timeline;

    request.updatedAt = new Date();
    await request.save();

    logAudit(
      { id: req.user.id, role: 'client', name: req.user.name },
      'request_edited',
      { type: 'request', id: request._id, name: request.title },
      { fieldsUpdated: Object.keys(req.body).join(', ') }
    ).catch(() => {});

    res.json({ success: true, request });
  } catch (error) {
    console.error('❌ Update request error:', error);
    res.status(500).json({ success: false, message: 'Error updating request' });
  }
});

module.exports = router;
