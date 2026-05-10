const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const mongoose = require('mongoose');
const { protect, authorize } = require('../middleware/auth');
const User = require('../models/User');
const Rating = require('../models/Rating');
const { logAudit } = require('../utils/audit');

function normalizeForAudit(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function auditFieldLabel(key) {
  const labels = {
    bio: 'bio',
    expert_bio: 'bio',
    specialization: 'specialization',
    expert_specialization: 'specialization',
    whyChooseMe: 'why choose me',
    city: 'city',
    expert_city: 'city',
    state: 'state',
    expert_state: 'state',
    pincode: 'pincode',
    expert_pincode: 'pincode',
    gstNumber: 'GST number',
    licenseNumber: 'professional license',
    certificationNumber: 'certification number',
    education: 'education',
    portfolio: 'portfolio',
    professionalAddress: 'professional address',
    servicesOffered: 'services offered',
    serviceLocationType: 'service location',
    fullAddress: 'full address',
    clientLocation: 'client location',
    phone: 'phone'
  };
  return labels[key] || String(key).replace(/^expert_/, '').replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
}

function auditActionForProfileField(key) {
  return 'profile_' + auditFieldLabel(key).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_updated';
}

function getChangedProfileFields(previousUser, nextProfile, topLevelUpdate) {
  const previousProfile = (previousUser && previousUser.profile) || {};
  const changed = [];
  Object.keys(nextProfile || {}).forEach(key => {
    if (normalizeForAudit(previousProfile[key]) !== normalizeForAudit(nextProfile[key])) changed.push(key);
  });
  Object.keys(topLevelUpdate || {}).forEach(key => {
    if (normalizeForAudit(previousUser && previousUser[key]) !== normalizeForAudit(topLevelUpdate[key])) changed.push(key);
  });
  return changed;
}

// ─── PHONE VALIDATION ───────────────────────────────────────────────────────
const WHITELISTED_IPS = [
  '127.0.0.1',
  '::1',
  ...(process.env.WHITELISTED_IPS ? process.env.WHITELISTED_IPS.split(',').map(function(ip){ return ip.trim(); }) : [])
];

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || (req.connection && req.connection.remoteAddress)
    || req.ip
    || '';
}

function isWhitelisted(req) {
  var ip = getClientIp(req);
  var bypassHeader = req.headers['x-dev-bypass'];
  var ipMatch = WHITELISTED_IPS.some(function(w) { return ip === w || ip.endsWith(w); });
  var headerMatch = process.env.DEV_BYPASS_SECRET && bypassHeader === process.env.DEV_BYPASS_SECRET;
  return ipMatch || headerMatch;
}

function isValidIndianPhone(phone) {
  if (!phone) return false;
  var cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length !== 10) return false;
  if (!/^[6-9]/.test(cleaned)) return false;
  if (/^(\d)\1{9}$/.test(cleaned)) return false;
  var invalid = ['1234567890','0987654321','1234554321'];
  if (invalid.indexOf(cleaned) !== -1) return false;
  return true;
}
// ────────────────────────────────────────────────────────────────────────────

// ✅ FIXED: Use memory storage instead of disk storage
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

// Get current user profile
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        credits: user.credits,
        profilePhoto: user.profilePhoto,
        profile: user.profile,
        specialization: user.specialization,
        qualifications: user.qualifications,
        location: user.location,
        bio: user.bio,
        portfolio: user.portfolio,
        companyName: user.companyName,
        companySize: user.companySize,
        hasWebsite: user.hasWebsite,
        websiteUrl: user.websiteUrl,
        yearsOfExperience: user.yearsOfExperience,
        servicesOffered: user.servicesOffered,
        certifications: user.certifications,
        rating: user.rating,
        reviewCount: user.reviewCount,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified,
        preferences: user.preferences,
        createdAt: user.createdAt,
        kyc: user.kyc ? {
          status: user.kyc.status,
          docType: user.kyc.docType,
          rejectionReason: user.kyc.rejectionReason
        } : { status: 'not_submitted' },
        totalApproaches: user.totalApproaches || 0,
        responseRate: user.responseRate || 0,
        availability: user.availability || 'available',
        whyChooseMe: user.whyChooseMe || '',
        lastOnline: user.lastOnline || null
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Error fetching profile' });
  }
});

// Update user profile
router.put('/me', protect, async (req, res) => {
  try {
    const { 
      name, 
      specialization, 
      bio,
      companyName,
      companySize,
      hasWebsite,
      websiteUrl,
      yearsOfExperience,
      servicesOffered,
      certifications,
      location
    } = req.body;
    
    const updateData = {};
    
    if (name) updateData.name = name;
    if (bio) updateData.bio = bio;
    
    if (req.user.role === 'expert') {
      if (specialization) updateData.specialization = specialization;
      if (companyName) updateData.companyName = companyName;
      if (companySize) updateData.companySize = companySize;
      if (hasWebsite !== undefined) updateData.hasWebsite = hasWebsite;
      if (websiteUrl) updateData.websiteUrl = websiteUrl;
      if (yearsOfExperience) updateData.yearsOfExperience = yearsOfExperience;
      if (servicesOffered) updateData.servicesOffered = servicesOffered;
      if (certifications) updateData.certifications = certifications;
    }
    if (req.body.whyChooseMe !== undefined) updateData.whyChooseMe = req.body.whyChooseMe;
    if (location) updateData.location = location;
    
    const user = await User.findByIdAndUpdate(
      req.user.id, 
      updateData, 
      { new: true, runValidators: true }
    );

try {
  logAudit(
    { id: req.user._id, role: req.user.role, name: req.user.name },
    'profile_updated',
    { type: 'user', id: req.user._id, name: req.user.name },
    { updatedFields: Object.keys(updateData) }
  ).catch(() => {});
} catch(e) {}
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        credits: user.credits,
        profilePhoto: user.profilePhoto,
        specialization: user.specialization,
        bio: user.bio,
        location: user.location,
        companyName: user.companyName,
        servicesOffered: user.servicesOffered,
        certifications: user.certifications
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
});

// ✅ FIXED: Upload profile photo with base64 storage
router.post('/profile-photo', protect, upload.single('profilePhoto'), async (req, res) => {
  try {
    if (!req.file) {
      console.log('❌ No file in request');
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }
    
    console.log('📸 Uploading profile photo:');
    console.log('  User:', req.user.id);
    console.log('  Filename:', req.file.originalname);
    console.log('  Size:', req.file.size);
    
    // Convert to base64
    const base64Image = req.file.buffer.toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${base64Image}`;
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profilePhoto: dataURI },
      { new: true }
    );
    
    console.log('✅ Profile photo uploaded successfully');
    
    res.json({
      success: true,
      message: 'Profile photo uploaded successfully',
      profilePhoto: dataURI
    });
  } catch (error) {
    console.error('❌ Upload photo error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error uploading photo' 
    });
  }
});

// Update user preferences
router.put('/preferences', protect, async (req, res) => {
  try {
    const { darkMode, notifications } = req.body;
    
    const updateData = {};
    if (darkMode !== undefined) updateData['preferences.darkMode'] = darkMode;
    if (notifications) {
      Object.keys(notifications).forEach(function(key) {
        if (['email', 'sms', 'newPosts'].indexOf(key) !== -1) {
          updateData['preferences.notifications.' + key] = !!notifications[key];
        }
      });
    }
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      updateData,
      { new: true }
    );
    
    res.json({
      success: true,
      message: 'Preferences updated',
      preferences: user.preferences
    });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating preferences' 
    });
  }
});
// POST /api/users/tickets - Create support ticket
router.post('/tickets', protect, async (req, res) => {
  try {
    var SupportTicket = mongoose.models['SupportTicket'];
    if (!SupportTicket) {
      try { SupportTicket = require('../models/SupportTicket'); } catch(e) {}
    }
    if (!SupportTicket) {
      return res.status(503).json({ success: false, message: 'Ticket system not available' });
    }

    var { subject, description, priority, issueType } = req.body;
    if (!subject) return res.status(400).json({ success: false, message: 'Subject required' });

    var { subject, description, priority, issueType,
          relatedApproachId, eligibleCredits, isExpertRefund } = req.body;

    var ticketData = {
      user: req.user._id,
      issueType: issueType || subject,
      subject: subject,
      description: description || subject,
      priority: priority || 'medium',
      status: 'open'
    };

    if (req.user.role === 'expert') ticketData.expert = req.user._id;

    // Expert credit refund — link the approach
    if (relatedApproachId) ticketData.relatedApproachId = relatedApproachId;
    if (eligibleCredits)   ticketData.eligibleCredits   = parseInt(eligibleCredits) || 0;
    if (isExpertRefund)    ticketData.isExpertRefund     = true;

    // Auto-set pending_review for credit refund tickets so admin sees them in refunds queue
    if (isExpertRefund && ticketData.eligibleCredits > 0) {
      ticketData.status = 'pending_review';
    }

    var ticket = await SupportTicket.create(ticketData);
    res.status(201).json({ success: true, message: 'Ticket created', ticket });
  } catch (err) {
    console.error('Create ticket error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/users/tickets - Get user's own tickets
router.get('/tickets', protect, async (req, res) => {
  try {
    var SupportTicket = mongoose.models['SupportTicket'];
    if (!SupportTicket) {
      try { SupportTicket = require('../models/SupportTicket'); } catch(e) {}
    }
    if (!SupportTicket) return res.json({ success: true, tickets: [] });

    var tickets = await SupportTicket.find({ user: req.user._id })
            .select('issueType subject description priority status decision adminNote eligibleCredits creditsRefunded isExpertRefund relatedApproachId createdAt lastFollowUp followUpCount')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ success: true, tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// POST /api/users/kyc - Submit KYC document
router.post('/kyc', protect, async (req, res) => {
  try {
    const { docType, docBase64, fileName, mimeType } = req.body;

    if (!docType || !docBase64) {
      return res.json({ success: false, message: 'Document type and file required' });
    }

    const base64Data = docBase64.split(',')[1] || docBase64;
    if (base64Data.length > 7 * 1024 * 1024) {
      return res.json({ success: false, message: 'File too large. Max 5MB.' });
    }

    await User.findByIdAndUpdate(req.user.id, {
      'kyc.status':          'pending',
      'kyc.docType':         docType,
      'kyc.docBase64':       docBase64,
      'kyc.fileName':        fileName,
      'kyc.mimeType':        mimeType,
      'kyc.submittedAt':     new Date(),
      'kyc.rejectionReason': null,
      'kyc.reviewedAt':      null
    });

    res.json({ success: true, message: 'KYC submitted successfully' });
  } catch (err) {
    console.error('KYC submit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add to portfolio (for experts)
router.post('/portfolio', protect, authorize('expert'), upload.single('image'), async (req, res) => {
  try {
    const { title, description, completedAt } = req.body;
    
    const portfolioItem = {
      title,
      description,
      completedAt: completedAt || Date.now()
    };
    
    if (req.file) {
      const base64Image = req.file.buffer.toString('base64');
      portfolioItem.image = `data:${req.file.mimetype};base64,${base64Image}`;
    }
    
    const user = await User.findById(req.user.id);
    if (!user.portfolio) user.portfolio = [];
    user.portfolio.push(portfolioItem);
    await user.save();
    
    res.json({ 
      success: true, 
      message: 'Portfolio item added',
      portfolio: user.portfolio 
    });
  } catch (error) {
    console.error('Add portfolio error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding portfolio item' 
    });
  }
});

// Update profile data (for expert questionnaire)
router.put('/profile', protect, async (req, res) => {
  try {
    const profile = req.body.profile || {};
    const previousUser = await User.findById(req.user.id).select('profile whyChooseMe phone name role').lean();

    // Build location update from all possible sources
    const locationUpdate = {};

    // Expert: saves city, state, pincode directly in profile
    if (profile.city)    locationUpdate['location.city']    = profile.city;
    if (profile.state)   locationUpdate['location.state']   = profile.state;
    if (profile.pincode) locationUpdate['location.pincode'] = profile.pincode;

    // Client (in-person): saves inside profile.fullAddress
    if (profile.fullAddress) {
      if (profile.fullAddress.city)    locationUpdate['location.city']    = profile.fullAddress.city;
      if (profile.fullAddress.state)   locationUpdate['location.state']   = profile.fullAddress.state;
      if (profile.fullAddress.pincode) locationUpdate['location.pincode'] = profile.fullAddress.pincode;
    }

    // Client (online): saves inside profile.clientLocation
    if (profile.clientLocation) {
      if (profile.clientLocation.city)    locationUpdate['location.city']    = profile.clientLocation.city;
      if (profile.clientLocation.state)   locationUpdate['location.state']   = profile.clientLocation.state;
      if (profile.clientLocation.pincode) locationUpdate['location.pincode'] = profile.clientLocation.pincode;
    }

    const topLevelUpdate = {};
    if (req.body.whyChooseMe !== undefined) topLevelUpdate.whyChooseMe = req.body.whyChooseMe;
    if (req.body.phone) {
      var phoneToSave = String(req.body.phone).replace(/\D/g, '');
      if (!isWhitelisted(req) && !isValidIndianPhone(phoneToSave)) {
        return res.status(400).json({ success: false, message: 'Enter a valid Indian mobile number (10 digits starting with 6, 7, 8 or 9)' });
      }
      topLevelUpdate.phone = phoneToSave;
    }
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { 
        profile: profile,
        ...locationUpdate,
        ...topLevelUpdate
      },
      { new: true, runValidators: false }
    ).select('-password');

try {
  const changedFields = getChangedProfileFields(previousUser, profile, topLevelUpdate);
  const fieldsToLog = changedFields.length ? changedFields : Object.keys(profile);
  fieldsToLog.forEach(field => {
    logAudit(
      { id: req.user._id, role: req.user.role, name: req.user.name },
      auditActionForProfileField(field),
      { type: 'user', id: req.user._id, name: req.user.name },
      { field, label: auditFieldLabel(field), updatedFields: changedFields }
    ).catch(() => {});
  });
} catch(e) {}
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        credits: user.credits,
        profile: user.profile
      }
    });

  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
});

// Add qualification
router.post('/qualifications', protect, authorize('expert'), async (req, res) => {
  try {
    const { title, description } = req.body;
    const user = await User.findById(req.user.id);
    user.qualifications.push({ title, description });
    await user.save();
    res.json({ success: true, qualifications: user.qualifications });
  } catch (error) {
    console.error('Add qualification error:', error);
    res.status(500).json({ success: false, message: 'Error adding qualification' });
  }
});

router.get('/location-suggestions', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const regex = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const experts = await User.find({
      role: 'expert',
      $or: regex ? [
        { 'location.city': regex },
        { 'location.pincode': regex },
        { 'profile.city': regex },
        { 'profile.pincode': regex },
        { 'profile.expert_city': regex },
        { 'profile.expert_pincode': regex }
      ] : [
        { 'location.city': { $exists: true, $ne: '' } },
        { 'location.pincode': { $exists: true, $ne: '' } },
        { 'profile.city': { $exists: true, $ne: '' } },
        { 'profile.pincode': { $exists: true, $ne: '' } },
        { 'profile.expert_city': { $exists: true, $ne: '' } },
        { 'profile.expert_pincode': { $exists: true, $ne: '' } }
      ]
    }).select('location profile').limit(80).lean();

    const seen = new Set();
    const suggestions = [];
    experts.forEach(expert => {
      const city = expert.location?.city || expert.profile?.city || expert.profile?.expert_city || '';
      const pin = expert.location?.pincode || expert.profile?.pincode || expert.profile?.expert_pincode || '';
      if (city) {
        const key = 'city:' + city.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({ type: 'city', label: city, value: city });
        }
      }
      if (pin) {
        const key = 'pincode:' + pin;
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({ type: 'pincode', label: pin + (city ? ' - ' + city : ''), value: pin });
        }
      }
    });

    res.json({ success: true, suggestions: suggestions.slice(0, 12) });
  } catch (error) {
    console.error('Location suggestions error:', error);
    res.status(500).json({ success: false, suggestions: [] });
  }
});

// Get all experts
router.get('/experts', async (req, res) => {
  try {
    const { 
      service, 
      location, 
      minRating, 
      sortBy,
      page = 1,
      limit = 50
    } = req.query;
    
    const query = { role: 'expert' };  // ← removed isActive filter

// Service filter
if (service && service !== 'all') {
  query.$or = [
    { servicesOffered: service },
    { 'profile.servicesOffered': service }
  ];
}

// Search by name, city or pincode
if (location) {
  const searchRegex = new RegExp(location, 'i');
  const locationConditions = [
    { name: searchRegex },
    { 'location.city': searchRegex },
    { 'location.pincode': searchRegex },
    { 'profile.city': searchRegex },
    { 'profile.pincode': searchRegex }
  ];

  // If service filter also exists, combine with AND logic
  if (query.$or) {
    const serviceConditions = query.$or;
    delete query.$or;
    query.$and = [
      { $or: serviceConditions },
      { $or: locationConditions }
    ];
  } else {
    query.$or = locationConditions;
  }
}

if (minRating) {
  query.rating = { $gte: parseFloat(minRating) };
}
    
    let sort = '-rating';
    if (sortBy === 'newest') sort = '-createdAt';
    if (sortBy === 'reviews') sort = '-reviewCount';
    if (sortBy === 'name') sort = 'name';
    
    const skip = (page - 1) * limit;
    
    const experts = await User.find(query)
      .select('name profilePhoto specialization bio location rating reviewCount servicesOffered certifications companyName yearsOfExperience createdAt profile')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const total = await User.countDocuments(query);
    
    res.json({
      success: true,
      count: experts.length,
      total: total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      experts
    });
  } catch (error) {
    console.error('Get experts error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching experts' 
    });
  }
});

// Get single expert public profile
router.get('/expert/:id', async (req, res) => {
  // Optional auth — log audit if viewer is logged in
  try {
    const jwt = require('jsonwebtoken');
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
      const viewer = await User.findById(decoded.id).select('name role').lean();
      if (viewer) {
        // Get expert name for target
        const expertUser = await User.findById(req.params.id).select('name').lean();
        logAudit(
          { id: viewer._id, role: viewer.role, name: viewer.name },
          'expert_profile_viewed',
          { type: 'user', id: req.params.id, name: expertUser ? expertUser.name : '' },
          {}
        ).catch(() => {});
      }
    }
  } catch(e) {}
  try {
    // ✅ Filter by role directly in DB query instead of checking after fetch
    const expert = await User.findOne({ 
      _id: req.params.id, 
      role: 'expert'
    })
    .select('name profilePhoto specialization qualifications rating reviewCount bio portfolio location companyName servicesOffered certifications yearsOfExperience createdAt profile availability whyChooseMe lastOnline')
    .lean();
    
    if (!expert) {
      return res.status(404).json({ 
        success: false, 
        message: 'Expert not found' 
      });
    }
    
    const ratings = await Rating.find({ 
      expert: req.params.id, 
      isPublic: true,
      isFlagged: false
    })
    .populate('client', 'name profilePhoto')
    .sort('-createdAt')
    .limit(10)
    .lean();
    
    res.json({ 
      success: true, 
      expert,
      ratings
    });
  } catch (error) {
    console.error('Get expert error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching expert' 
    });
  }
});
// ─── BLOCK EXPERT (client blocks/reports an expert) ───
router.post('/:id/block', protect, authorize('client'), async (req, res) => {
  try {
    const { report, reason } = req.body;
    const expertId = req.params.id;

    // Add to client's blocked list
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { blockedExperts: expertId }
    });

    // If also reporting, issue warning to expert
    if (report) {
      const expert = await User.findById(expertId);
      if (expert) {
        const alreadyReported = (expert.reports || []).some(
          r => r.reportedBy && r.reportedBy.toString() === req.user._id.toString()
        );
        if (!alreadyReported) {
          expert.reportCount = (expert.reportCount || 0) + 1;
          expert.reports = expert.reports || [];
          expert.reports.push({
            reportedBy: req.user._id,
            reason: reason || 'Reported by client',
            date: new Date()
          });
          expert.warnings = (expert.warnings || 0) + 1;
          expert.lastWarning = {
            reason: `A client reported you: ${reason || 'Inappropriate behavior or platform violation'}`,
            date: new Date(),
            by: 'system'
          };
          expert.markModified('warnings');
          expert.markModified('lastWarning');
          expert.markModified('reports');
          if (expert.warnings >= 3) {
            expert.isRestricted = true;
            expert.markModified('isRestricted');
            console.log(`🚫 Expert ${expertId} auto-restricted after ${expert.warnings} warnings`);
          }
          await expert.save();
          console.log(`⚠️ Warning ${expert.warnings}/3 issued to expert ${expertId} — reported by client ${req.user._id}`);
          if (expert.isRestricted) {
            try {
              const { sendExpertRestricted, sendAdminUserRestricted } = require('../utils/notificationEmailService');
              sendExpertRestricted({ to: expert.email, name: expert.name, reason: reason || 'Multiple client reports', warningCount: expert.warnings, userId: expert._id }).catch(() => {});
              sendAdminUserRestricted({ userName: expert.name, userEmail: expert.email, userRole: 'expert', reason: reason || 'Auto-restricted after 3 client reports', warningCount: expert.warnings, restrictedBy: 'system' }).catch(() => {});
            } catch(e) {}
          }
        }
      }
    }
    console.log(`✅ User ${req.user._id} blocked expert ${expertId}. Report: ${report}`);
    res.json({
      success: true,
      message: report ? 'Expert blocked and reported' : 'Expert blocked'
    });
    
  } catch (err) {
    console.error('Block expert error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── SHORTLIST OR HIRE EXPERT (client action) ───
router.post('/:id/interest', protect, authorize('client'), async (req, res) => {
  try {
    const { type } = req.body; // 'shortlist' or 'hire'
    const expertId = req.params.id;
    const clientId = req.user._id;

    const expert = await User.findById(expertId);
    if (!expert || expert.role !== 'expert') {
      return res.status(404).json({ success: false, message: 'Expert not found' });
    }

    // ── SHORTLIST ──
    if (type === 'shortlist') {
      const client = await User.findById(clientId);
      const alreadyShortlisted = (client.shortlistedExperts || [])
        .some(id => id.toString() === expertId.toString());

      if (alreadyShortlisted) {
        // Toggle off — remove from shortlist
        await User.findByIdAndUpdate(clientId, {
          $pull: { shortlistedExperts: expertId }
        });
        return res.json({ success: true, message: 'Removed from shortlist', shortlisted: false });
      } else {
        await User.findByIdAndUpdate(clientId, {
          $addToSet: { shortlistedExperts: expertId }
        });
        return res.json({ success: true, message: 'Expert shortlisted', shortlisted: true });
      }
    }

    // ── HIRE ──
    if (type === 'hire') {
      const phone = req.user.phone || '';
      const email = req.user.email || '';

      // Build masked versions
      const maskedPhone = phone.length >= 4
        ? phone.slice(0, 2) + 'XXXXXX' + phone.slice(-2)
        : 'XXXXXXXXXX';
      const emailParts = email.split('@');
      const maskedEmail = emailParts[0]
        ? emailParts[0][0] + '****@' + (emailParts[1] || '')
        : '****@****.com';

      // Send notification to expert
      const Notification = mongoose.models['Notification'];
      if (Notification) {
        await Notification.create({
          user: expertId,
          type: 'customer_interest',
          title: '🎯 A client wants to hire you!',
          message: `A client wants to hire you for their project. Spend 5 credits to unlock their full contact details (phone + email) and reach out directly.`,
          data: {
            clientId: clientId.toString(),
            maskedPhone,
            maskedEmail,
            fullPhone: phone,
            fullEmail: email,
            clientName: req.user.name,
            unlocked: false
          },
          isRead: false
        });
        console.log(`✅ Hire notification created for expert ${expertId}`);
      } else {
        console.log('⚠️  Notification model not found — notification skipped');
      }

      // ── Audit: client_hired_expert ──
      logAudit(
        { id: clientId, role: 'client', name: req.user.name },
        'client_hired_expert',
        { type: 'user', id: expertId, name: expert.name },
        {}
      ).catch(() => {});

      return res.json({ success: true, message: 'Expert notified of your interest' });
    }

    res.status(400).json({ success: false, message: 'Invalid type. Use shortlist or hire.' });
  } catch (err) {
    console.error('Interest error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET CLIENT'S SHORTLISTED EXPERTS ───
router.get('/shortlisted', protect, authorize('client'), async (req, res) => {
  try {
    const client = await User.findById(req.user._id)
      .populate(
        'shortlistedExperts',
        'name profilePhoto specialization rating reviewCount profile location bio'
      )
      .lean();

    res.json({
      success: true,
      experts: client.shortlistedExperts || []
    });
  } catch (err) {
    console.error('Get shortlisted error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── EXPERT UNLOCKS CUSTOMER INTEREST NOTIFICATION ───
router.post('/unlock-interest/:notifId', protect, authorize('expert'), async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'];
    const CreditTransaction = require('../models/CreditTransaction');
    const UNLOCK_COST = 15;

    if (!Notification) {
      return res.status(503).json({ success: false, message: 'Notification system unavailable' });
    }

    const notif = await Notification.findById(req.params.notifId);
    if (!notif || notif.user.toString() !== req.user._id.toString()) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    // Already unlocked — just return details
    if (notif.data && notif.data.unlocked) {
      return res.json({
        success: true,
        alreadyUnlocked: true,
        client: {
          name: notif.data.clientName,
          phone: notif.data.fullPhone,
          email: notif.data.fullEmail
        }
      });
    }

    // Check credits
    const expert = await User.findById(req.user._id);
    if ((expert.credits || 0) < UNLOCK_COST) {
      return res.status(400).json({
        success: false,
        message: `Need ${UNLOCK_COST} credits to unlock. You have ${expert.credits || 0}.`,
        needCredits: true
      });
    }

    // Deduct credits
        // Deduct credits
    const balanceBefore = expert.credits;
    expert.credits -= UNLOCK_COST;
    await expert.save();

    // Log credit transaction
    try {
      await CreditTransaction.create({
        user: expert._id,
        type: 'spent',
        amount: -UNLOCK_COST,
        balanceBefore,
        balanceAfter: expert.credits,
        description: 'Unlocked customer hire interest'
      });
    } catch (txErr) {
      console.log('CreditTransaction log failed (non-fatal):', txErr.message);
    }

    // Save client data BEFORE modifying notif.data
    const clientName = notif.data ? notif.data.clientName : '';
    const fullPhone  = notif.data ? notif.data.fullPhone  : '';
    const fullEmail  = notif.data ? notif.data.fullEmail  : '';
    const maskedPhone = notif.data ? notif.data.maskedPhone : '';
    const maskedEmail = notif.data ? notif.data.maskedEmail : '';
    const clientId   = notif.data ? notif.data.clientId   : '';

    // Build a completely new data object and replace — this is the ONLY reliable
    // way to save Mixed type in Mongoose
    const newData = {
      clientId,
      clientName,
      fullPhone,
      fullEmail,
      maskedPhone,
      maskedEmail,
      unlocked: true
    };

    // Use replaceOne to force full document update — bypasses Mixed type issues
    await Notification.updateOne(
      { _id: notif._id },
      { $set: { data: newData, isRead: true } }
    );

    console.log(`✅ Expert ${expert._id} unlocked interest. Credits: ${balanceBefore} → ${expert.credits}`);
    console.log(`✅ Saved unlocked data:`, newData);
 
    // ── Audit: expert_accepted_hire ──
    logAudit(
      { id: expert._id, role: 'expert', name: expert.name },
      'expert_accepted_hire',
      { type: 'user', id: clientId, name: clientName },
      { creditsSpent: UNLOCK_COST }
    ).catch(() => {});
    
    res.json({
      success: true,
      creditsSpent: UNLOCK_COST,
      newBalance: expert.credits,
      client: {
        name: clientName || 'Client',
        phone: fullPhone || '',
        email: fullEmail || ''
      }
    });
  } catch (err) {
    console.error('Unlock interest error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
// GET /api/users/my-invites — client sees which experts they've invited
router.get('/my-invites', protect, authorize('client'), async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'] || require('../models/Notification');
    
    // Find all customer_interest notifications where clientId matches this user
    const invites = await Notification.find({
      type: 'customer_interest',
      'data.clientId': req.user._id.toString()
    }).sort({ createdAt: -1 }).lean();

    // Get expert details
    const expertIds = invites.map(n => n.user).filter(Boolean);
    const experts = await User.find({ _id: { $in: expertIds } })
      .select('name email profilePhoto specialization')
      .lean();
    const expertMap = {};
    experts.forEach(e => { expertMap[String(e._id)] = e; });

    const enriched = invites.map(n => ({
  _id: n._id,
  expert: expertMap[String(n.user)] || {},
  unlocked: (n.data && n.data.unlocked) || false,
  completed: (n.data && n.data.completed) || false,
  createdAt: n.createdAt
}));

    res.json({ success: true, invites: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ─── MARK INVITE AS COMPLETED (CLIENT ONLY) ───
router.post('/invite-complete/:notifId', protect, authorize('client'), async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'] || require('../models/Notification');
    
    const notif = await Notification.findById(req.params.notifId);
    if (!notif) {
      return res.status(404).json({ success: false, message: 'Invite not found' });
    }
    
    // Verify this invite belongs to this client
    if (!notif.data || notif.data.clientId !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    // Must be unlocked first
    if (!notif.data.unlocked) {
      return res.status(400).json({ success: false, message: 'Invite not yet accepted by expert' });
    }

    await Notification.updateOne(
      { _id: notif._id },
      { $set: { 'data.completed': true, 'data.completedAt': new Date() } }
    );

    console.log(`✅ Invite ${notif._id} marked completed by client ${req.user._id}`);
    res.json({ success: true, message: 'Invite marked as completed' });
  } catch (err) {
    console.error('Invite complete error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
// ─── UPDATE AVAILABILITY (EXPERT ONLY) ───
router.put('/availability', protect, authorize('expert'), async (req, res) => {
  try {
    const { availability } = req.body;
    if (!['available', 'busy', 'away'].includes(availability)) {
      return res.status(400).json({ success: false, message: 'Invalid availability status' });
    }
    await User.findByIdAndUpdate(req.user.id, { availability });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// ─── FOLLOW UP ON TICKET (48hr rule) ───
router.post('/tickets/:id/followup', protect, async (req, res) => {
  try {
    var mongoose = require('mongoose');
    var SupportTicket = mongoose.models['SupportTicket'] || require('../models/SupportTicket');
    var { logAudit } = require('../utils/audit');

    var ticket = await SupportTicket.findOne({ _id: req.params.id, user: req.user._id });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (['resolved', 'closed'].includes(ticket.status)) return res.status(400).json({ success: false, message: 'Ticket is already resolved' });
    
    // Check 48hrs have passed since creation
    var hoursSinceCreated = (Date.now() - new Date(ticket.createdAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreated < 48) {
      var hoursLeft = Math.ceil(48 - hoursSinceCreated);
      return res.status(400).json({ success: false, message: `Follow up available in ${hoursLeft} hour(s)` });
    }

    // Check 24hrs since last follow up
    if (ticket.lastFollowUp) {
      var hoursSinceFollowUp = (Date.now() - new Date(ticket.lastFollowUp).getTime()) / (1000 * 60 * 60);
      if (hoursSinceFollowUp < 24) {
        var hoursLeft2 = Math.ceil(24 - hoursSinceFollowUp);
        return res.status(400).json({ success: false, message: `Next follow up available in ${hoursLeft2} hour(s)` });
      }
    }

    ticket.lastFollowUp = new Date();
    ticket.followUpCount = (ticket.followUpCount || 0) + 1;
    if (ticket.status === 'open') ticket.status = 'escalated';
    await ticket.save();

    // Email admin
    try {
      const { sendAdminTicketEscalated } = require('../utils/notificationEmailService');
      await sendAdminTicketEscalated({
        userName: req.user.name,
        userEmail: req.user.email,
        ticketId: String(ticket._id),
        subject: ticket.subject,
        followUpCount: ticket.followUpCount
      });
    } catch(e) {
      console.error('Escalation email error:', e.message);
    }
    // Audit log
    logAudit(
      { id: req.user._id, role: req.user.role, name: req.user.name },
      'ticket_followup',
      { type: 'ticket', id: ticket._id, name: ticket.subject },
      { followUpCount: ticket.followUpCount }
    ).catch(() => {});
    
    res.json({ success: true, message: 'Follow up sent. Admin has been notified.' });
  } catch (err) {
    console.error('Follow up error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Public expert profile — no auth required
router.get('/public/:id', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
      const viewer = await User.findById(decoded.id).select('name role').lean();
      if (viewer) {
        logAudit(
          { id: viewer._id, role: viewer.role, name: viewer.name },
          'expert_profile_viewed',
          { type: 'user', id: req.params.id, name: '' },
          {}
        ).catch(() => {});
      }
    }
  } catch(e) {}
  try {
    const user = await User.findById(req.params.id)
      .select('name role profilePhoto bio specialization yearsOfExperience servicesOffered location profile rating reviewCount whyChooseMe kyc emailVerified createdAt')
      .lean();
    if (!user || user.role !== 'expert') {
      return res.status(404).json({ success: false, message: 'Expert not found' });
    }
    const ratings = await Rating.find({ expert: user._id })
      .populate('client', 'name')
      .sort('-createdAt')
      .limit(3)
      .lean();
    res.json({ success: true, expert: user, ratings });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;
