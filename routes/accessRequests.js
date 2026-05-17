const express = require('express');
const router = express.Router();
const { protect, authorize, blockRestrictedUser } = require('../middleware/auth');
const AccessRequest = require('../models/AccessRequest');
const Document = require('../models/Document');
const Approach = require('../models/Approach');

// ⭐ Request access to a document
router.post('/', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    const { documentId, approachId, message } = req.body;
    
        if (!documentId || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Document ID and message are required' 
      });
    }
    
    // Verify document exists
    const document = await Document.findById(documentId).populate('owner');
    if (!document) {
      return res.status(404).json({ 
        success: false, 
        message: 'Document not found' 
      });
    }
    
        // Verify approach if provided
    if (approachId) {
      const approach = await Approach.findById(approachId);
      if (!approach) {
        return res.status(404).json({ 
          success: false, 
          message: 'Approach not found' 
        });
      }
      if (approach.expert.toString() !== req.user.id) {
        return res.status(403).json({ 
          success: false, 
          message: 'Not authorized - approach does not belong to you' 
        });
      }
    }
    
    // Check if access already requested
    const existing = await AccessRequest.findOne({ 
      document: documentId, 
      expert: req.user.id 
    });
    
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Access already requested for this document',
        status: existing.status
      });
    }
    
    // Create access request
        const accessRequest = await AccessRequest.create({
      document: documentId,
      expert: req.user.id,
      client: document.owner._id,
      approach: approachId || null,
      message,
      status: 'pending'
    });
    
    res.status(201).json({
      success: true,
      message: 'Access request sent successfully',
      accessRequest: {
        id: accessRequest._id,
        document: documentId,
        status: accessRequest.status,
        requestedAt: accessRequest.createdAt
      }
    });
    
  } catch (error) {
    console.error('Create access request error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Error creating access request' 
    });
  }
});

// ⭐ Get my access requests (for experts)
router.get('/my-requests', protect, authorize('expert'), async (req, res) => {
  try {
    const { status } = req.query;
    
    const query = { expert: req.user.id };
    if (status) query.status = status;
    
    const requests = await AccessRequest.find(query)
      .populate('document', 'originalFileName fileType category')
      .populate('client', 'name email')
      .populate('approach', 'message')
      .sort('-createdAt')
      .lean();
    
    res.json({
      success: true,
      count: requests.length,
      requests
    });
    
  } catch (error) {
    console.error('Get my requests error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching access requests' 
    });
  }
});

// ⭐ Get access requests for my documents (for clients)
router.get('/pending', protect, authorize('client'), async (req, res) => {
  try {
    const requests = await AccessRequest.find({ 
      client: req.user.id,
      status: 'pending'
    })
    .populate('document', 'originalFileName fileType category description')
    .populate('expert', 'name profilePhoto specialization rating')
    .populate('approach', 'message creditsSpent')
    .sort('-createdAt')
    .lean();
    
    res.json({
      success: true,
      count: requests.length,
      requests
    });
    
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching pending requests' 
    });
  }
});

// ⭐ Approve access request
router.post('/:id/approve', protect, blockRestrictedUser, async (req, res) => {
  try {
    const { responseMessage } = req.body;
    
    const accessRequest = await AccessRequest.findById(req.params.id)
      .populate('document');
    
    if (!accessRequest) {
      return res.status(404).json({ 
        success: false, 
        message: 'Access request not found' 
      });
    }
    
    // Verify client owns the document
    if (accessRequest.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    if (accessRequest.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        message: 'Request already processed' 
      });
    }
    
    // Update access request
    accessRequest.status = 'approved';
    accessRequest.responseMessage = responseMessage || 'Access granted';
    accessRequest.respondedAt = Date.now();
    await accessRequest.save();
    
    // Grant access in document
    const document = await Document.findById(accessRequest.document._id);
    const alreadyGranted = document.grantedAccess.some(
      access => access.expert.toString() === accessRequest.expert.toString()
    );
    
    if (!alreadyGranted) {
      document.grantedAccess.push({
        expert: accessRequest.expert,
        grantedAt: Date.now()
      });
      await document.save();
    }
    
    // Update approach
    await Approach.findByIdAndUpdate(accessRequest.approach, {
      documentAccessGranted: true,
      documentAccessGrantedAt: Date.now()
    });
    
    res.json({
      success: true,
      message: 'Access granted successfully',
      accessRequest
    });
    
  } catch (error) {
    console.error('Approve access error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error approving access request' 
    });
  }
});

// ⭐ Reject access request
router.post('/:id/reject', protect, blockRestrictedUser, async (req, res) => {
  try {
    const { responseMessage } = req.body;
    
    const accessRequest = await AccessRequest.findById(req.params.id);
    
    if (!accessRequest) {
      return res.status(404).json({ 
        success: false, 
        message: 'Access request not found' 
      });
    }
    
    if (accessRequest.client.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    if (accessRequest.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        message: 'Request already processed' 
      });
    }
    
    accessRequest.status = 'rejected';
    accessRequest.responseMessage = responseMessage || 'Access denied';
    accessRequest.respondedAt = Date.now();
    await accessRequest.save();
    
    res.json({
      success: true,
      message: 'Access request rejected',
      accessRequest
    });
    
  } catch (error) {
    console.error('Reject access error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error rejecting access request' 
    });
  }
});

// ⭐ Get access request details
router.get('/:id', protect, async (req, res) => {
  try {
    const accessRequest = await AccessRequest.findById(req.params.id)
      .populate('document', 'originalFileName fileType category description')
      .populate('expert', 'name profilePhoto specialization')
      .populate('client', 'name email')
      .populate('approach', 'message');
    
    if (!accessRequest) {
      return res.status(404).json({ 
        success: false, 
        message: 'Access request not found' 
      });
    }
    
    // Check authorization
    const isExpert = accessRequest.expert._id.toString() === req.user.id;
    const isClient = accessRequest.client._id.toString() === req.user.id;
    
    if (!isExpert && !isClient) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    res.json({
      success: true,
      accessRequest
    });
    
  } catch (error) {
    console.error('Get access request error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching access request' 
    });
  }
});

// ⭐ Delete/cancel access request
router.delete('/:id', protect, blockRestrictedUser, async (req, res) => {
  try {
    const accessRequest = await AccessRequest.findById(req.params.id);
    
    if (!accessRequest) {
      return res.status(404).json({ 
        success: false, 
        message: 'Access request not found' 
      });
    }
    
    // Only expert can cancel their own request, only if pending
    if (accessRequest.expert.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }
    
    if (accessRequest.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot cancel processed request' 
      });
    }
    
    await accessRequest.deleteOne();
    
    res.json({
      success: true,
      message: 'Access request cancelled'
    });
    
  } catch (error) {
    console.error('Delete access request error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error cancelling access request' 
    });
  }
});

module.exports = router;
