const mongoose = require('mongoose');

const expertInviteSchema = new mongoose.Schema({
  inviter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  invitedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  invitedEmail: { type: String, lowercase: true, trim: true, default: '' },
  inviteCode: { type: String, required: true, trim: true, uppercase: true },
  status: {
    type: String,
    enum: ['invited', 'signed_up', 'approach_pending', 'completed'],
    default: 'invited'
  },
  firstApproach: { type: mongoose.Schema.Types.ObjectId, ref: 'Approach', default: null },
  creditsAwarded: { type: Number, default: 0 },
  creditedAt: { type: Date, default: null }
}, { timestamps: true });

expertInviteSchema.index({ inviter: 1, createdAt: -1 });
expertInviteSchema.index({ invitedUser: 1 }, { sparse: true });
expertInviteSchema.index({ inviteCode: 1 });

module.exports = mongoose.model('ExpertInvite', expertInviteSchema);
