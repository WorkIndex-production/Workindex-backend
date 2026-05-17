const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const mongoose = require('mongoose');
const { protect, authorize, blockRestrictedUser } = require('../middleware/auth');
const User = require('../models/User');
const Rating = require('../models/Rating');
const ExpertInvite = require('../models/ExpertInvite');
const { logAudit } = require('../utils/audit');
const { attachExpertScores } = require('../utils/expertMetrics');

const MIN_REQUEST_BUDGET = 1000;
const MAX_REQUEST_BUDGET = 100000;
const REQUEST_BUDGET_STEP = 500;

function parseRequestBudget(value) {
  const cleaned = String(value ?? '').replace(/[^\d.]/g, '');
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : 0;
}

function validateRequestBudget(value) {
  const amount = parseRequestBudget(value);
  if (amount < MIN_REQUEST_BUDGET) {
    return {
      valid: false,
      amount,
      message: `Minimum request budget is ₹${MIN_REQUEST_BUDGET.toLocaleString('en-IN')}`
    };
  }
  if (amount > MAX_REQUEST_BUDGET || amount % REQUEST_BUDGET_STEP !== 0) {
    return {
      valid: false,
      amount,
      message: `Budget must be selected between ₹${MIN_REQUEST_BUDGET.toLocaleString('en-IN')} and ₹${MAX_REQUEST_BUDGET.toLocaleString('en-IN')} in ₹${REQUEST_BUDGET_STEP.toLocaleString('en-IN')} steps`
    };
  }
  return { valid: true, amount };
}

function maskPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 4) return 'XXXXXXXXXX';
  return p.slice(0, 2) + 'XXXXXX' + p.slice(-2);
}

function maskEmail(email) {
  const parts = String(email || '').split('@');
  if (parts.length < 2 || !parts[0]) return '****@****.com';
  return parts[0][0] + '****@' + parts[1];
}

const calculateInviteCredits = (service, answers, defaultCredits) => {
  const base = { itr: 15, gst: 20, accounting: 25, audit: 30, photography: 18, development: 35 };
  let credits = base[service] || defaultCredits || 20;
  if (!answers) return credits;
  if (service === 'itr') {
    if (answers.itrAnnualIncome === '10-15') credits = 18;
    if (answers.itrAnnualIncome === '15-20') credits = 22;
    if (answers.itrAnnualIncome === 'above20') credits = 28;
    if (answers.itrIncomeSources && answers.itrIncomeSources.includes('business')) credits += 5;
    if (answers.itrIncomeSources && answers.itrIncomeSources.includes('foreign')) credits += 5;
  }
  if (service === 'gst') {
    if (answers.gstTurnover === '5-20') credits = 22;
    if (answers.gstTurnover === '20-50') credits = 27;
    if (answers.gstTurnover === 'above50') credits = 35;
  }
  if (service === 'accounting') {
    if (answers.accountingTransactions === '100-500') credits = 28;
    if (answers.accountingTransactions === '500-2000') credits = 32;
    if (answers.accountingTransactions === 'above2000') credits = 40;
  }
  if (service === 'audit') {
    if (answers.auditTurnover === '1-5cr') credits = 35;
    if (answers.auditTurnover === '5-20cr') credits = 45;
    if (answers.auditTurnover === 'above20cr') credits = 60;
  }
  if (service === 'photography') {
    if (answers.photographyDuration === 'half-day') credits = 22;
    if (answers.photographyDuration === 'full-day') credits = 28;
    if (answers.photographyDuration === 'multiple') credits = 35;
    if (answers.photographyVideography === 'yes') credits += 5;
  }
  if (service === 'development') {
    if (answers.devProjectType === 'website') credits = 30;
    if (answers.devProjectType === 'ecommerce') credits = 38;
    if (answers.devProjectType === 'mobile-app') credits = 45;
    if (answers.devProjectType === 'web-app') credits = 50;
    if (answers.devProjectType === 'custom') credits = 55;
    if (answers.devMaintenance === 'yes') credits += 5;
  }
  return Math.min(credits, 60);
};

async function getInviteCredits(service, answers) {
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
  return calculateInviteCredits(service, answers, defaultCredits);
}

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
function firstFilled() {
  for (let i = 0; i < arguments.length; i++) {
    const val = arguments[i];
    if (Array.isArray(val) && val.length) return val;
    if (val && typeof val === 'object' && Object.keys(val).length) return val;
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (val !== undefined && val !== null && typeof val !== 'string' && !Array.isArray(val) && typeof val !== 'object') return val;
  }
  return '';
}

function normalizeExpertProfileForSave(profile) {
  const p = Object.assign({}, profile || {});
  const loc = p.expert_location_details && typeof p.expert_location_details === 'object'
    ? p.expert_location_details
    : {};

  p.servicesOffered = firstFilled(p.servicesOffered, p.expert_services, p.services);
  p.specialization = firstFilled(p.specialization, p.expert_specialization);
  p.experience = firstFilled(p.experience, p.expert_experience, p.yearsOfExperience);
  p.serviceLocationType = firstFilled(p.serviceLocationType, p.expert_location);
  p.businessType = firstFilled(p.businessType, p.expert_business_type, p.business_type);
  p.teamSize = firstFilled(p.teamSize, p.expert_team_size, p.team_size);
  p.bio = firstFilled(p.bio, p.expert_bio);
  p.city = firstFilled(p.city, p.expert_city, loc.city);
  p.state = firstFilled(p.state, p.expert_state, loc.state);
  p.pincode = firstFilled(p.pincode, p.expert_pincode, loc.pincode);
  p.professionalAddress = firstFilled(p.professionalAddress, p.expert_professional_address, p.professional_address, p.address);
  p.gstNumber = firstFilled(p.gstNumber, p.expert_gst_number, p.gst_number);
  p.licenseNumber = firstFilled(p.licenseNumber, p.expert_license_number, p.license_number, p.professionalLicense);
  p.certificationNumber = firstFilled(p.certificationNumber, p.expert_certification_number, p.certification_number);
  p.education = firstFilled(p.education, p.expert_education);
  p.portfolio = firstFilled(p.portfolio, p.expert_portfolio);

  if (!p.expert_location_details && (p.city || p.state || p.pincode)) {
    p.expert_location_details = {
      city: p.city || '',
      state: p.state || '',
      pincode: p.pincode || ''
    };
  }

  return p;
}

const DIRECT_PROFILE_FIELDS = [
  'servicesOffered', 'expert_services', 'services',
  'specialization', 'expert_specialization',
  'experience', 'expert_experience', 'yearsOfExperience',
  'serviceLocationType', 'expert_location',
  'businessType', 'expert_business_type', 'business_type',
  'teamSize', 'expert_team_size', 'team_size',
  'bio', 'expert_bio',
  'city', 'expert_city', 'state', 'expert_state', 'pincode', 'expert_pincode',
  'professionalAddress', 'expert_professional_address', 'professional_address', 'address',
  'gstNumber', 'expert_gst_number', 'gst_number',
  'licenseNumber', 'expert_license_number', 'license_number', 'professionalLicense',
  'certificationNumber', 'expert_certification_number', 'certification_number',
  'education', 'expert_education',
  'portfolio', 'expert_portfolio',
  'fullAddress', 'clientLocation', 'service_location_type', 'full_address', 'client_location',
  'browseServiceFilter'
];

function extractDirectProfilePayload(body) {
  const direct = {};
  DIRECT_PROFILE_FIELDS.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(body, key)) direct[key] = body[key];
  });
  return direct;
}

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
        inviteCode: user.inviteCode,
        questionnaireCompleted: user.questionnaireCompleted || false,
        profileViews: user.profileViews || 0,
        adminBoost: user.adminBoost || 0,
        adminRank: user.adminRank || null,
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
    const hasNestedProfilePayload = Object.prototype.hasOwnProperty.call(req.body, 'profile')
      && req.body.profile
      && typeof req.body.profile === 'object'
      && !Array.isArray(req.body.profile);
    const directProfile = extractDirectProfilePayload(req.body || {});
    const hasDirectProfilePayload = Object.keys(directProfile).length > 0;
    const hasProfilePayload = hasNestedProfilePayload || hasDirectProfilePayload;
    const incomingProfile = {
      ...(hasNestedProfilePayload ? req.body.profile : {}),
      ...directProfile
    };
    const previousUser = await User.findById(req.user.id).select('profile whyChooseMe phone name role questionnaireCompleted').lean();
    const previousProfile = (previousUser && previousUser.profile && typeof previousUser.profile === 'object') ? previousUser.profile : {};
    const profile = hasProfilePayload
      ? normalizeExpertProfileForSave(Object.assign({}, previousProfile, incomingProfile))
      : previousProfile;

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
    const updateData = {
      ...locationUpdate,
      ...topLevelUpdate
    };
    if (hasProfilePayload) updateData.profile = profile;
    if (req.user.role === 'expert' && hasProfilePayload) updateData.questionnaireCompleted = true;

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateData },
      { new: true, runValidators: false }
    ).select('-password');

try {
  const changedFields = hasProfilePayload ? getChangedProfileFields(previousUser, profile, topLevelUpdate) : Object.keys(topLevelUpdate);
  const fieldsToLog = changedFields.length ? changedFields : Object.keys(incomingProfile);
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
        questionnaireCompleted: user.questionnaireCompleted || false,
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

router.get('/invite-summary', protect, authorize('expert'), async (req, res) => {
  try {
    let user = await User.findById(req.user.id).select('inviteCode name credits');
    if (!user.inviteCode) {
      user.inviteCode = String(user.name || 'WI').replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
      await user.save();
    }
    const invites = await ExpertInvite.find({ inviter: user._id })
      .populate('invitedUser', 'name email createdAt totalApproaches')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, inviteCode: user.inviteCode, credits: user.credits || 0, invites });
  } catch (error) {
    console.error('Invite summary error:', error);
    res.status(500).json({ success: false, message: 'Error loading invites' });
  }
});

router.post('/validate-invite', async (req, res) => {
  try {
    const code = String(req.body.inviteCode || req.query.inviteCode || '').trim().toUpperCase();
    if (!code) return res.json({ success: true, valid: false });
    const expert = await User.findOne({ role: 'expert', inviteCode: code, emailVerified: true }).select('name inviteCode').lean();
    res.json({ success: true, valid: !!expert, expert: expert ? { name: expert.name, inviteCode: expert.inviteCode } : null });
  } catch (error) {
    res.status(500).json({ success: false, valid: false });
  }
});

router.post('/expert/:id/profile-view', async (req, res) => {
  try {
    const expert = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'expert' },
      { $inc: { profileViews: 1 } },
      { new: true }
    ).select('profileViews').lean();
    if (!expert) return res.status(404).json({ success: false, message: 'Expert not found' });
    res.json({ success: true, profileViews: expert.profileViews || 0 });
  } catch (error) {
    console.error('Profile view count error:', error);
    res.status(500).json({ success: false, message: 'Error recording profile view' });
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
    
    const skip = (page - 1) * limit;
    
    let allExperts = await User.find(query)
      .select('name profilePhoto specialization bio location rating reviewCount servicesOffered certifications companyName yearsOfExperience createdAt profile totalApproaches adminBoost adminRank profileViews questionnaireCompleted')
      .lean();
    allExperts = allExperts.map(attachExpertScores);

    if (sortBy === 'newest') allExperts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    else if (sortBy === 'reviews') allExperts.sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0));
    else if (sortBy === 'name') allExperts.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    else allExperts.sort((a, b) => {
      const ar = Number(a.adminRank || 0);
      const br = Number(b.adminRank || 0);
      if (ar > 0 && br > 0 && ar !== br) return ar - br;
      if (ar > 0 && !br) return -1;
      if (!ar && br > 0) return 1;
      return (b.searchScore || 0) - (a.searchScore || 0);
    });

    const experts = allExperts.slice(skip, skip + parseInt(limit));
    
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
    await User.findByIdAndUpdate(req.params.id, { $inc: { profileViews: 1 } });
    // ✅ Filter by role directly in DB query instead of checking after fetch
    const expert = await User.findOne({ 
      _id: req.params.id, 
      role: 'expert'
    })
    .select('name profilePhoto specialization qualifications rating reviewCount bio portfolio location companyName servicesOffered certifications yearsOfExperience createdAt profile availability whyChooseMe lastOnline profileViews adminBoost adminRank totalApproaches')
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
    
    const scoredExpert = attachExpertScores(expert);
    res.json({ 
      success: true, 
      expert: scoredExpert,
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
router.post('/:id/interest', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
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
      const payload = req.body || {};
      const answers = payload.answers || {};
      const service = String(payload.service || answers.service || '').toLowerCase();
      const budgetCheck = validateRequestBudget(payload.budget || answers.budget || 0);
      if (!service) return res.status(400).json({ success: false, message: 'Service is required' });
      if (!budgetCheck.valid) return res.status(400).json({ success: false, message: budgetCheck.message });
      const phone = req.user.phone || '';
      const email = req.user.email || '';
      const credits = await getInviteCredits(service, answers);

      // Build masked versions
      const maskedPhone = maskPhone(phone);
      const maskedEmail = maskEmail(email);

      // Send notification to expert
      const Notification = mongoose.models['Notification'] || require('../models/Notification');
      if (Notification) {
        await Notification.create({
          user: expertId,
          type: 'customer_interest',
          title: '🎯 A client wants to hire you!',
          message: `A client wants to hire you for their project. Spend 5 credits to unlock their full contact details (phone + email) and reach out directly.`,
          data: {
            clientId: clientId.toString(),
            expertId: expertId.toString(),
            service,
            title: payload.title || 'Direct expert invite',
            description: payload.description || answers.description || 'Request details in questionnaire',
            answers,
            timeline: payload.timeline || answers.urgency || 'flexible',
            budget: String(budgetCheck.amount),
            location: payload.location || 'Online / Remote',
            credits,
            status: 'pending',
            maskedPhone,
            maskedEmail,
            fullPhone: phone,
            fullEmail: email,
            clientName: req.user.name,
            unlocked: false,
            source: 'expert_invite'
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
router.post('/expert-invites', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
  try {
    const { expertId, service, title, description, answers, timeline, budget, location } = req.body || {};
    const expert = await User.findById(expertId);
    if (!expert || expert.role !== 'expert') return res.status(404).json({ success: false, message: 'Expert not found' });
    const serviceValue = String(service || (answers && answers.service) || '').toLowerCase();
    if (!serviceValue) return res.status(400).json({ success: false, message: 'Service is required' });
    const budgetCheck = validateRequestBudget(budget || (answers && answers.budget) || 0);
    if (!budgetCheck.valid) return res.status(400).json({ success: false, message: budgetCheck.message });

    const Notification = mongoose.models['Notification'] || require('../models/Notification');
    const cleanAnswers = { ...(answers || {}), service: serviceValue, budget: budgetCheck.amount };
    const credits = await getInviteCredits(serviceValue, cleanAnswers);
    const phone = req.user.phone || '';
    const email = req.user.email || '';
    const invite = await Notification.create({
      user: expert._id,
      type: 'customer_interest',
      title: 'New Expert Invite',
      message: 'A client sent you a direct service request. Review the details before unlocking contact information.',
      data: {
        clientId: req.user._id.toString(),
        expertId: expert._id.toString(),
        service: serviceValue,
        title: title || 'Direct expert invite',
        description: description || cleanAnswers.description || 'Request details in questionnaire',
        answers: cleanAnswers,
        timeline: timeline || cleanAnswers.urgency || 'flexible',
        budget: String(budgetCheck.amount),
        location: location || 'Online / Remote',
        credits,
        status: 'pending',
        maskedPhone: maskPhone(phone),
        maskedEmail: maskEmail(email),
        fullPhone: phone,
        fullEmail: email,
        clientName: req.user.name,
        unlocked: false,
        source: 'expert_invite'
      },
      isRead: false
    });

    try {
      const { sendExpertInviteReceived } = require('../utils/notificationEmailService');
      sendExpertInviteReceived({
        to: expert.email,
        name: expert.name,
        clientName: req.user.name,
        postTitle: title || 'Direct expert invite',
        service: serviceValue,
        credits,
        location: location || 'Online / Remote',
        budget: `Rs. ${budgetCheck.amount.toLocaleString('en-IN')}`,
        userId: expert._id
      }).catch(() => {});
    } catch(e) {}

    logAudit(
      { id: req.user._id, role: 'client', name: req.user.name },
      'client_sent_expert_invite',
      { type: 'user', id: expert._id, name: expert.name },
      { service: serviceValue, credits }
    ).catch(() => {});

    res.status(201).json({ success: true, invite });
  } catch (err) {
    console.error('Create expert invite error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/expert-invites/:notifId', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'] || require('../models/Notification');
    const notif = await Notification.findById(req.params.notifId);
    if (!notif || notif.type !== 'customer_interest') return res.status(404).json({ success: false, message: 'Invite not found' });
    const data = notif.data || {};
    if (String(data.clientId) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (data.cancelled || data.completed) return res.status(400).json({ success: false, message: 'Cannot edit a closed invite' });

    const next = { ...data };
    ['title', 'description', 'timeline', 'location'].forEach(key => {
      if (req.body[key] !== undefined) next[key] = req.body[key];
    });
    if (req.body.answers && typeof req.body.answers === 'object') next.answers = { ...(next.answers || {}), ...req.body.answers };
    if (req.body.service !== undefined) next.service = String(req.body.service).toLowerCase();
    if (req.body.budget !== undefined) {
      const budgetCheck = validateRequestBudget(req.body.budget);
      if (!budgetCheck.valid) return res.status(400).json({ success: false, message: budgetCheck.message });
      next.budget = String(budgetCheck.amount);
      next.answers = { ...(next.answers || {}), budget: budgetCheck.amount };
    }
    next.credits = await getInviteCredits(next.service, next.answers || {});
    await Notification.updateOne({ _id: notif._id }, { $set: { data: next } });
    res.json({ success: true, invite: { ...notif.toObject(), data: next } });
  } catch (err) {
    console.error('Edit expert invite error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/expert-invites/:notifId/cancel', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'] || require('../models/Notification');
    const notif = await Notification.findById(req.params.notifId);
    if (!notif || notif.type !== 'customer_interest') return res.status(404).json({ success: false, message: 'Invite not found' });
    const data = notif.data || {};
    if (String(data.clientId) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not authorized' });
    const next = { ...data, status: 'cancelled', cancelled: true, cancelledAt: new Date() };
    await Notification.updateOne({ _id: notif._id }, { $set: { data: next, isRead: true } });
    res.json({ success: true });
  } catch (err) {
    console.error('Cancel expert invite error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

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
router.post('/unlock-interest/:notifId', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const Notification = mongoose.models['Notification'] || require('../models/Notification');
    const CreditTransaction = require('../models/CreditTransaction');

    if (!Notification) {
      return res.status(503).json({ success: false, message: 'Notification system unavailable' });
    }

    const notif = await Notification.findById(req.params.notifId);
    if (!notif || notif.user.toString() !== req.user._id.toString()) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    const unlockCost = Number((notif.data && notif.data.credits) || 15);
    if (notif.data && notif.data.cancelled) {
      return res.status(400).json({ success: false, message: 'This invite was cancelled by the customer' });
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
    if ((expert.credits || 0) < unlockCost) {
      return res.status(400).json({
        success: false,
        message: `Need ${unlockCost} credits to unlock. You have ${expert.credits || 0}.`,
        needCredits: true
      });
    }

    // Deduct credits
        // Deduct credits
    const balanceBefore = expert.credits;
    expert.credits -= unlockCost;
    await expert.save();

    // Log credit transaction
    try {
      await CreditTransaction.create({
        user: expert._id,
        type: 'spent',
        amount: -unlockCost,
        balanceBefore,
        balanceAfter: expert.credits,
        description: 'Unlocked expert invite contact'
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
      ...(notif.data || {}),
      clientId,
      clientName,
      fullPhone,
      fullEmail,
      maskedPhone,
      maskedEmail,
      unlocked: true,
      status: 'accepted',
      unlockedAt: new Date()
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
      { creditsSpent: unlockCost }
    ).catch(() => {});
    
    res.json({
      success: true,
      creditsSpent: unlockCost,
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
  cancelled: (n.data && n.data.cancelled) || false,
  status: (n.data && n.data.status) || ((n.data && n.data.unlocked) ? 'accepted' : 'pending'),
  data: n.data || {},
  createdAt: n.createdAt
}));

    res.json({ success: true, invites: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ─── MARK INVITE AS COMPLETED (CLIENT ONLY) ───
router.post('/invite-complete/:notifId', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
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
      { $set: { 'data.completed': true, 'data.status': 'completed', 'data.completedAt': new Date() } }
    );

    console.log(`✅ Invite ${notif._id} marked completed by client ${req.user._id}`);
    res.json({ success: true, message: 'Invite marked as completed' });
  } catch (err) {
    console.error('Invite complete error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
// ─── UPDATE AVAILABILITY (EXPERT ONLY) ───
router.put('/availability', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
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
