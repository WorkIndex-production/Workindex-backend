const mongoose = require('mongoose');

const visitSchema = new mongoose.Schema({
  ip:        { type: String, default: 'unknown' },
  referrer:  { type: String, default: '' },
  source:    { type: String, default: '' },
  medium:    { type: String, default: '' },
  country:   { type: String, default: 'India' },
  state:     { type: String, default: 'Unknown' },
  city:      { type: String, default: 'Unknown' },
  page:      { type: String, default: '/' },
  userAgent: { type: String, default: '' },
  sessionId: { type: String, default: '' }, // prevent double count per session
}, { timestamps: true });

// Index for fast queries
visitSchema.index({ createdAt: -1 });
visitSchema.index({ state: 1 });
visitSchema.index({ sessionId: 1 });

module.exports = mongoose.model('Visit', visitSchema);
