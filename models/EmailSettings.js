// models/EmailSettings.js
const mongoose = require('mongoose');

const emailSettingsSchema = new mongoose.Schema({
  // Single document — use findOne() always
  singleton: { type: Boolean, default: true },

  // ── CLIENT emails ──
  client_welcome:           { type: Boolean, default: true },
  client_post_created:      { type: Boolean, default: true },
  client_expert_approached: { type: Boolean, default: true },
  client_post_suspended:    { type: Boolean, default: true },
  client_post_stale_reminder:{ type: Boolean, default: true },
  client_restricted:        { type: Boolean, default: true },
  client_banned:            { type: Boolean, default: true },

  // ── EXPERT emails ──
  expert_welcome:           { type: Boolean, default: true },
  expert_credits_purchased: { type: Boolean, default: true },
  expert_credits_refunded:  { type: Boolean, default: true },
  expert_approach_sent:     { type: Boolean, default: true },
  expert_new_post:          { type: Boolean, default: true },
  expert_invite_received:   { type: Boolean, default: true },
  expert_restricted:        { type: Boolean, default: true },
  expert_banned:            { type: Boolean, default: true },

  // ── ADMIN emails ──
  admin_post_suspended:     { type: Boolean, default: true },
  admin_user_restricted:    { type: Boolean, default: true },
  admin_daily_tickets:      { type: Boolean, default: true },

}, { timestamps: true });

module.exports = mongoose.model('EmailSettings', emailSettingsSchema);
