const express = require('express');
const router = express.Router();
const { protect, authorize, blockRestrictedUser } = require('../middleware/auth');
const Rating = require('../models/Rating');
const Approach = require('../models/Approach');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { logAudit } = require('../utils/audit');

// ⭐ Create a rating/review
router.post('/', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
  try {
    const { 
      expertId, 
      requestId, 
      approachId, 
      rating, 
      review,
      categories,
      wouldRecommend 
    } = req.body;
    
    // Validate required fields
    if (!expertId || !rating || !review) {
      return res.status(400).json({ 
        success: false, 
        message: 'Expert, rating, and review are required' 
      });
    }
    
    // Validate rating value
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ 
        success: false, 
        message: 'Rating must be between 1 and 5' 
      });
    }
    
    // Ratings must be tied to a completed approach so reviews cannot be created for arbitrary experts.
    let approach = null;
    let directInvite = null;
    if (approachId) {
      approach = await Approach.findById(approachId).populate('request');
      if (!approach) {
        return res.status(404).json({ success: false, message: 'Approach not found' });
      }
      if (approach.request.client.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized - this is not your request' });
      }
      if (!approach.isWorkCompleted) {
        return res.status(400).json({ success: false, message: 'Cannot rate before work is completed' });
      }
      if (approach.hasBeenRated) {
        return res.status(400).json({ success: false, message: 'You have already rated this expert for this request' });
      }
    } else if (requestId && expertId) {
      approach = await Approach.findOne({
        request: requestId,
        expert: expertId,
        client: req.user.id
      }).populate('request');
      if (!approach) {
        return res.status(400).json({ success: false, message: 'A completed approach is required before rating this expert' });
      }
      if (!approach.isWorkCompleted) {
        return res.status(400).json({ success: false, message: 'Cannot rate before work is completed' });
      }
      if (approach.hasBeenRated) {
        return res.status(400).json({ success: false, message: 'You have already rated this expert for this request' });
      }
    } else if (expertId) {
      directInvite = await Notification.findOne({
        user: expertId,
        type: 'customer_interest',
        'data.clientId': String(req.user.id),
        'data.completed': true,
        'data.cancelled': { $ne: true },
        'data.rated': { $ne: true }
      }).sort({ createdAt: -1 });
      if (!directInvite) {
        const completedInvite = await Notification.exists({
          user: expertId,
          type: 'customer_interest',
          'data.clientId': String(req.user.id),
          'data.completed': true,
          'data.cancelled': { $ne: true }
        });
        return res.status(400).json({
          success: false,
          message: completedInvite
            ? 'You have already rated this expert for this invite'
            : 'A completed approach or expert invite is required before rating this expert'
        });
      }
      const existingInviteRating = await Rating.exists({
        client: req.user.id,
        expert: expertId,
        invite: directInvite._id
      });
      if (existingInviteRating) {
        return res.status(400).json({ success: false, message: 'You have already rated this expert for this invite' });
      }
    } else {
      return res.status(400).json({ success: false, message: 'A completed approach is required before rating this expert' });
    }

    if (approach && approach.expert.toString() !== String(expertId)) {
      return res.status(400).json({ success: false, message: 'Rating expert does not match completed approach' });
    }
    
    // Create rating
    const ratingDoc = await Rating.create({
      expert: expertId,
      client: req.user.id,
      request: requestId || (approach && approach.request && approach.request._id) || null,
      approach: approach ? approach._id : undefined,
      invite: directInvite ? directInvite._id : undefined,
      rating: rating,
      review: review,
      categories: categories || {},
      wouldRecommend: wouldRecommend !== undefined ? wouldRecommend : true
    });
    
    // Update approach if present
    if (approach) {
      approach.hasBeenRated = true;
      approach.rating = ratingDoc._id;
      await approach.save();
    }
    if (directInvite) {
      await Notification.updateOne(
        { _id: directInvite._id },
        { $set: { 'data.rated': true, 'data.ratingId': ratingDoc._id } }
      );
    }
    
    // Update expert's rating
    const expert = await User.findById(expertId);
    expert.updateRating(rating);
    await expert.save();

    logAudit(
      { id: req.user.id, role: 'client', name: req.user.name },
      'rating_completed',
      { type: 'rating', id: ratingDoc._id, name: expert.name },
      { requestId: requestId || null, approachId: approachId || null, inviteId: directInvite ? directInvite._id : null, expertId, rating }
    ).catch(() => {});
    
    res.status(201).json({
      success: true,
      message: 'Rating submitted successfully',
      rating: ratingDoc,
      expertRating: {
        average: expert.rating,
        count: expert.reviewCount
      }
    });
    
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ 
        success: false, 
        message: 'You have already rated this approach' 
      });
    }
    console.error('Create rating error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Error creating rating' 
    });
  }
});

// ⭐ Get ratings for an expert
router.get('/pending/next', protect, authorize('client'), async (req, res) => {
  try {
    const pending = await Approach.findOne({
      client: req.user.id,
      isWorkCompleted: true,
      hasBeenRated: { $ne: true },
      status: 'completed'
    })
      .populate('expert', 'name specialization profilePhoto')
      .populate('request', 'title service')
      .sort('-workCompletedAt -updatedAt')
      .lean();

    if (!pending) {
      return res.json({ success: true, pendingRating: null });
    }

    res.json({
      success: true,
      pendingRating: {
        approachId: pending._id,
        expertId: pending.expert && pending.expert._id,
        expertName: pending.expert && pending.expert.name ? pending.expert.name : 'Expert',
        requestId: pending.request && pending.request._id,
        requestTitle: pending.request && pending.request.title ? pending.request.title : 'Completed request',
        service: pending.request && pending.request.service
      }
    });
  } catch (error) {
    console.error('Pending rating error:', error);
    res.status(500).json({ success: false, message: 'Error fetching pending rating' });
  }
});

router.get('/expert/:expertId', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10,
      minRating,
      sortBy = 'recent'
    } = req.query;
    
    const query = { 
      expert: req.params.expertId,
      isPublic: true,
      isFlagged: false
    };
    
    if (minRating) {
      query.rating = { $gte: parseInt(minRating) };
    }
    
    let sort = '-createdAt'; // Default: most recent
    if (sortBy === 'highest') sort = '-rating';
    if (sortBy === 'lowest') sort = 'rating';
    if (sortBy === 'helpful') sort = '-helpfulCount';
    
    const skip = (page - 1) * limit;
    
    const ratings = await Rating.find(query)
      .populate('client', 'name profilePhoto')
      .populate('request', 'service title')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const total = await Rating.countDocuments(query);
    
    // Calculate statistics
    const stats = await Rating.aggregate([
      { $match: { expert: require('mongoose').Types.ObjectId(req.params.expertId), isPublic: true, isFlagged: false } },
      {
        $group: {
          _id: null,
          avgRating: { $avg: '$rating' },
          totalReviews: { $sum: 1 },
          fiveStar: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
          fourStar: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
          threeStar: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
          twoStar: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
          oneStar: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
          wouldRecommendCount: { $sum: { $cond: ['$wouldRecommend', 1, 0] } }
        }
      }
    ]);
    
    const statistics = stats[0] || {
      avgRating: 0,
      totalReviews: 0,
      fiveStar: 0,
      fourStar: 0,
      threeStar: 0,
      twoStar: 0,
      oneStar: 0,
      wouldRecommendCount: 0
    };
    
    res.json({
      success: true,
      count: ratings.length,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      ratings,
      statistics: {
        ...statistics,
        recommendPercentage: statistics.totalReviews > 0 
          ? ((statistics.wouldRecommendCount / statistics.totalReviews) * 100).toFixed(1)
          : 0
      }
    });
    
  } catch (error) {
    console.error('Get expert ratings error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching ratings' 
    });
  }
});

// ⭐ Get my ratings (for clients - ratings I've given)
router.get('/my-ratings', protect, authorize('client'), async (req, res) => {
  try {
    const ratings = await Rating.find({ client: req.user.id })
      .populate('expert', 'name profilePhoto specialization')
      .populate('request', 'service title')
      .sort('-createdAt')
      .lean();
    
    res.json({
      success: true,
      count: ratings.length,
      ratings
    });
    
  } catch (error) {
    console.error('Get my ratings error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching your ratings' 
    });
  }
});

// ⭐ Get ratings received (for experts - ratings they've received)
router.get('/received', protect, authorize('expert'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;
    
    const ratings = await Rating.find({ 
      expert: req.user.id,
      isPublic: true 
    })
    .populate('client', 'name profilePhoto')
    .populate('request', 'service title')
    .sort('-createdAt')
    .skip(skip)
    .limit(parseInt(limit))
    .lean();
    
    const total = await Rating.countDocuments({ expert: req.user.id, isPublic: true });
    
    res.json({
      success: true,
      count: ratings.length,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      ratings
    });
    
  } catch (error) {
    console.error('Get received ratings error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching ratings' 
    });
  }
});

// ⭐ Get single rating
router.get('/:id', async (req, res) => {
  try {
    const rating = await Rating.findById(req.params.id)
      .populate('expert', 'name profilePhoto specialization')
      .populate('client', 'name profilePhoto')
      .populate('request', 'service title');
    
    if (!rating) {
      return res.status(404).json({ 
        success: false, 
        message: 'Rating not found' 
      });
    }
    
    if (!rating.isPublic) {
      return res.status(403).json({ 
        success: false, 
        message: 'This rating is private' 
      });
    }
    
    res.json({
      success: true,
      rating
    });
    
  } catch (error) {
    console.error('Get rating error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching rating' 
    });
  }
});

// ⭐ Expert responds to a rating
router.post('/:id/respond', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Response message is required' 
      });
    }
    
    const rating = await Rating.findById(req.params.id);
    
    if (!rating) {
      return res.status(404).json({ 
        success: false, 
        message: 'Rating not found' 
      });
    }
    
    if (rating.expert.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    if (rating.expertResponse && rating.expertResponse.message) {
      return res.status(400).json({ 
        success: false, 
        message: 'You have already responded to this rating' 
      });
    }
    
    rating.expertResponse = {
      message,
      respondedAt: Date.now()
    };
    
    await rating.save();
    
    res.json({
      success: true,
      message: 'Response posted successfully',
      rating
    });
    
  } catch (error) {
    console.error('Respond to rating error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error posting response' 
    });
  }
});

// ⭐ Mark rating as helpful
router.post('/:id/helpful', protect, blockRestrictedUser, async (req, res) => {
  try {
    const rating = await Rating.findById(req.params.id);
    
    if (!rating) {
      return res.status(404).json({ 
        success: false, 
        message: 'Rating not found' 
      });
    }
    
    rating.helpfulCount += 1;
    await rating.save();
    
    res.json({
      success: true,
      message: 'Marked as helpful',
      helpfulCount: rating.helpfulCount
    });
    
  } catch (error) {
    console.error('Mark helpful error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error marking as helpful' 
    });
  }
});

// ⭐ Flag a rating (for inappropriate content)
router.post('/:id/flag', protect, blockRestrictedUser, async (req, res) => {
  try {
    const { reason } = req.body;
    
    const rating = await Rating.findById(req.params.id);
    
    if (!rating) {
      return res.status(404).json({ 
        success: false, 
        message: 'Rating not found' 
      });
    }
    
    rating.isFlagged = true;
    rating.flagReason = reason || 'Inappropriate content';
    await rating.save();
    
    res.json({
      success: true,
      message: 'Rating flagged for review'
    });
    
  } catch (error) {
    console.error('Flag rating error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error flagging rating' 
    });
  }
});

// ⭐ Update rating (client can edit within 24 hours)
router.put('/:id', protect, authorize('client'), blockRestrictedUser, async (req, res) => {
  try {
    const { rating: newRating, review, categories, wouldRecommend } = req.body;
    
    const ratingDoc = await Rating.findById(req.params.id);
    
    if (!ratingDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'Rating not found' 
      });
    }
    
    if (ratingDoc.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    // Check if within 24 hours
    const hoursSinceCreated = (Date.now() - ratingDoc.createdAt) / (1000 * 60 * 60);
    if (hoursSinceCreated > 24) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot edit rating after 24 hours' 
      });
    }
    
    const oldRating = ratingDoc.rating;
    
    if (newRating) ratingDoc.rating = newRating;
    if (review) ratingDoc.review = review;
    if (categories) ratingDoc.categories = categories;
    if (wouldRecommend !== undefined) ratingDoc.wouldRecommend = wouldRecommend;
    
    await ratingDoc.save();
    
    // Update expert's average rating if rating value changed
    if (newRating && newRating !== oldRating) {
      const expert = await User.findById(ratingDoc.expert);
      expert.totalRatingSum = expert.totalRatingSum - oldRating + newRating;
      expert.rating = (expert.totalRatingSum / expert.reviewCount).toFixed(2);
      await expert.save();
    }
    
    res.json({
      success: true,
      message: 'Rating updated successfully',
      rating: ratingDoc
    });
    
  } catch (error) {
    console.error('Update rating error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating rating' 
    });
  }
});

module.exports = router;
