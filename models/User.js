const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: false,
    unique: true,
    sparse: true,
    trim: true
  },
  googleId: {
    type: String,
    default: null,
    sparse: true
  },
  password: {
    type: String,
    required: false,
    select: false
  },
  role: {
    type: String,
    enum: ['client', 'expert'],
    required: true
  },

  // Profile Photo
  profilePhoto: {
    type: String,
    default: null
  },

  credits: {
    type: Number,
    default: 50
  },

  // Expert Profile Fields
  profile: {
    type: Object,
    default: {}
  },

  specialization: String,

  qualifications: [{
    title: String,
    description: String
  }],

  // Location
  location: {
    city: String,
    state: String,
    country: { type: String, default: 'India' },
    coordinates: {
      latitude: Number,
      longitude: Number
    },
    address: String
  },

  // Portfolio/Description (for experts)
  bio: {
    type: String,
    maxlength: 1000
  },

  portfolio: [{
    title: String,
    description: String,
    image: String,
    completedAt: Date
  }],

  // Company Details (for experts)
  companyName: String,
  companySize: String,
  hasWebsite: Boolean,
  websiteUrl: String,
  yearsOfExperience: String,

  // Services Offered (for experts)
  servicesOffered: [{
    type: String
  }],

  // Certifications (for experts)
  certifications: [{
    type: String
  }],

  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },

  reviewCount: {
    type: Number,
    default: 0
  },

  // Total rating sum (for calculating average)
  totalRatingSum: {
    type: Number,
    default: 0
  },

  emailVerified: {
    type: Boolean,
    default: false
  },

  phoneVerified: {
    type: Boolean,
    default: false
  },

  emailOTP: String,
  phoneOTP: String,
  otpExpiry: Date,

  isActive: {
    type: Boolean,
    default: true
  },
  // KYC Verification
  kyc: {
    status:          { type: String, enum: ['not_submitted','pending','approved','rejected'], default: 'not_submitted' },
    docType:         { type: String },
    docBase64:       { type: String },
    fileName:        { type: String },
    mimeType:        { type: String },
    submittedAt:     { type: Date },
    reviewedAt:      { type: Date },
    rejectionReason: { type: String }
  },

  // Profile strength tracking
  totalApproaches: { type: Number, default: 0 },
  responseRate:    { type: Number, default: 0 },

  // ─── NEW ADMIN FIELDS ───────────────────────────────────
  // Expert registration approval
  isApproved: {
    type: Boolean,
    default: false
  },

  isRejected: {
    type: Boolean,
    default: false
  },

  // Moderation
  isBanned: {
    type: Boolean,
    default: false
  },

  isFlagged: {
    type: Boolean,
    default: false
  },
  
 isRestricted: {
    type: Boolean,
    default: false
  },
  
  warnings: {
    type: Number,
    default: 0
  },

  lastWarning: {
    reason: String,
    date: Date,
    by: String  // admin ID who issued it
  },
  // ────────────────────────────────────────────────────────
  // Client: blocked and shortlisted experts
  blockedExperts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],

  shortlistedExperts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],

  // Expert: report tracking
  reportCount: {
    type: Number,
    default: 0
  },

  reports: [{
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: String,
    date: Date
  }],

  // User Preferences
  preferences: {
    darkMode: {
      type: Boolean,
      default: false
    },
    notifications: {
      email: { type: Boolean, default: true },
      sms:   { type: Boolean, default: false },
      newPosts: { type: Boolean, default: true }
    }
  },

  lastLogin: Date,
  lastOnline: Date,
  availability: {
    type: String,
    enum: ['available', 'busy', 'away'],
    default: 'available'
  },
  whyChooseMe: {
    type: String,
    maxlength: 500,
    default: ''
  }

}, {
  timestamps: true
});

// Indexes
userSchema.index({ email: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ role: 1 });
userSchema.index({ 'location.city': 1, 'location.state': 1 });
userSchema.index({ rating: -1 });
userSchema.index({ isBanned: 1 });
userSchema.index({ isApproved: 1 });
userSchema.index({ googleId: 1 }, { sparse: true });

// Pre-save middleware for password hashing
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate OTP
userSchema.methods.generateOTP = function() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  this.otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
  return otp;
};

// Calculate average rating
userSchema.methods.updateRating = function(newRating) {
  this.totalRatingSum += newRating;
  this.reviewCount += 1;
  this.rating = (this.totalRatingSum / this.reviewCount).toFixed(2);
};

// Get initials for avatar placeholder
userSchema.methods.getInitials = function() {
  return this.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
};

module.exports = mongoose.model('User', userSchema);
