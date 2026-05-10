const mongoose = require('mongoose');

const creditPackSchema = new mongoose.Schema({
  id:      { type: String, required: true, trim: true, lowercase: true },
  label:   { type: String, required: true, trim: true },
  credits: { type: Number, required: true, min: 1 },
  price:   { type: Number, required: true, min: 1 },
  active:  { type: Boolean, default: true }
}, { _id: false });

const platformSettingsSchema = new mongoose.Schema({
  singleton: { type: Boolean, default: true, unique: true },
  defaultPostCredits: { type: Number, default: 20, min: 1 },
  creditPacks: {
    type: [creditPackSchema],
    default: [
      { id: 'starter', label: 'Starter', credits: 15,  price: 100,  active: true },
      { id: 'basic',   label: 'Basic',   credits: 40,  price: 250,  active: true },
      { id: 'popular', label: 'Popular', credits: 180, price: 1000, active: true },
      { id: 'pro',     label: 'Pro',     credits: 500, price: 2500, active: true }
    ]
  }
}, { timestamps: true });

module.exports = mongoose.models.PlatformSettings ||
  mongoose.model('PlatformSettings', platformSettingsSchema);
