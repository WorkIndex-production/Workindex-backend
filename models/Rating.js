const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  // The expert being rated
  expert: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // The client giving the rating
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Related request and approach
  request: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Request',
  required: false
},
approach: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Approach',
  required: false
},
invite: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Notification',
  required: false
},
  
  // Rating (1-5 stars)
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  
  // Review text
  review: {
    type: String,
    required: true,
    minlength: 10,
    maxlength: 1000
  },
  
  // Rating categories (optional detailed ratings)
  categories: {
    communication: {
      type: Number,
      min: 1,
      max: 5
    },
    professionalism: {
      type: Number,
      min: 1,
      max: 5
    },
    quality: {
      type: Number,
      min: 1,
      max: 5
    },
    timeliness: {
      type: Number,
      min: 1,
      max: 5
    },
    value: {
      type: Number,
      min: 1,
      max: 5
    }
  },
  
  // Would recommend?
  wouldRecommend: {
    type: Boolean,
    default: true
  },
  
  // Expert's response to the review (optional)
  expertResponse: {
    message: String,
    respondedAt: Date
  },
  
  // Helpful votes (other users can mark review as helpful)
  helpfulCount: {
    type: Number,
    default: 0
  },
  
  // Verification
  isVerified: {
    type: Boolean,
    default: true // Verified because it's linked to actual approach
  },
  
  // Status
  isPublic: {
    type: Boolean,
    default: true
  },
  
  isFlagged: {
    type: Boolean,
    default: false
  },
  
  flagReason: String
}, {
  timestamps: true
});

// Indexes
ratingSchema.index({ expert: 1, createdAt: -1 });
ratingSchema.index({ client: 1 });
ratingSchema.index({ rating: -1 });
ratingSchema.index({ isPublic: 1, isFlagged: 1 });

// Ensure one rating per completed approach or completed direct invite.
ratingSchema.index(
  { approach: 1 },
  { unique: true, partialFilterExpression: { approach: { $type: 'objectId' } } }
);
ratingSchema.index(
  { invite: 1 },
  { unique: true, partialFilterExpression: { invite: { $type: 'objectId' } } }
);

// Calculate average from categories if provided
ratingSchema.pre('save', function(next) {
  if (this.categories && Object.keys(this.categories).length > 0) {
    const cats = this.categories;
    const values = Object.values(cats).filter(v => v != null);
    if (values.length > 0) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      // Optional: could update main rating to match category average
    }
  }
  next();
});

module.exports = mongoose.model('Rating', ratingSchema);
