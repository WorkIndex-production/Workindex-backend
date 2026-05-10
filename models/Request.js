const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Client is required']
  },
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true
  },
  service: {
    type: String,
    required: [true, 'Service is required'],
    lowercase: true,
    trim: true
  },
  category: String,
  description: {
    type: String,
    required: [true, 'Description is required']
  },
  answers: {
    type: mongoose.Schema.Types.Mixed,  // ← CRITICAL: Allows flexible questionnaire structure
    default: {}
  },
  timeline: {
    type: String,
    enum: ['immediate', '2-3days', 'week', 'month', 'flexible'],
    default: 'flexible'
  },
  budget: {
    type: String,
    default: '0'
  },
  location: {
    type: String,
    required: [true, 'Location is required']
  },
  
  // Attached Documents
  documents: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document'
  }],
  
  credits: {
    type: Number,
    required: true,
    min: 1,
    default: 20
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'completed','closed', 'cancelled'],
    default: 'pending'
  },
  
  // Accepted Expert
  acceptedExpert: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Completion Status
  isCompleted: {
    type: Boolean,
    default: false
  },
  
  completedAt: Date,
  
  responseCount: {
    type: Number,
    default: 0
  },
  approachCount: {
    type: Number,
    default: 0
  },
    viewCount: {
    type: Number,
    default: 0
  },

  viewedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],

  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  reports: [
    {
      by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reason: { type: String },
      note:   { type: String, default: '' },
      date:   { type: Date, default: Date.now }
    }
  ],

  isSuspended:   { type: Boolean, default: false },
  suspendedAt:   { type: Date, default: null },
  suspendReason: { type: String, default: null }
}, {
  timestamps: true  // Adds createdAt and updatedAt
});

// Indexes for faster queries
requestSchema.index({ client: 1, createdAt: -1 });
requestSchema.index({ service: 1, status: 1 });
requestSchema.index({ status: 1, createdAt: -1 });
requestSchema.index({ location: 1 });

// Virtual for approach count (if you want to calculate dynamically)
requestSchema.virtual('approaches', {
  ref: 'Approach',
  localField: '_id',
  foreignField: 'request',
  count: true
});

// Ensure virtuals are included when converting to JSON
requestSchema.set('toJSON', { virtuals: true });
requestSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Request', requestSchema);
