const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { protect, authorize, blockRestrictedUser } = require('../middleware/auth');
const Document = require('../models/Document');
const AccessRequest = require('../models/AccessRequest');
const Approach = require('../models/Approach');

const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /pdf|doc|docx|xls|xlsx|jpg|jpeg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype) || 
                     file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                     file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, DOC, DOCX, XLS, XLSX, Images'));
    }
  }
});

function getFileType(mimetype, ext) {
  if (mimetype.includes('pdf')) return 'pdf';
  if (mimetype.includes('word') || ext === '.doc' || ext === '.docx') return 'word';
  if (mimetype.includes('excel') || mimetype.includes('spreadsheet') || ext === '.xls' || ext === '.xlsx') return 'excel';
  if (mimetype.includes('image')) return 'image';
  return 'other';
}

// UPLOAD DOCUMENT
router.post('/upload', protect, blockRestrictedUser, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    
    const { description, category, requestId, isPublic } = req.body;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileType = getFileType(req.file.mimetype, ext);
    const base64File = req.file.buffer.toString('base64');
    const dataURI = 'data:' + req.file.mimetype + ';base64,' + base64File;
    
    const document = await Document.create({
      owner: req.user.id,
      request: requestId || null,
      fileName: 'doc-' + Date.now() + ext,
      originalFileName: req.file.originalname,
      fileType,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      fileUrl: dataURI,
      description: description || '',
      category: category || 'other',
      isPublic: isPublic === 'true' || false
    });
    
    console.log('Document uploaded:', document._id);
    
    res.json({
      success: true,
      message: 'Document uploaded successfully',
      document: {
        id: document._id,
        fileName: document.originalFileName,
        fileType: document.fileType,
        fileSize: document.fileSize,
        category: document.category,
        uploadedAt: document.createdAt
      }
    });
  } catch (error) {
    console.error('Upload document error:', error);
    res.status(500).json({ success: false, message: error.message || 'Error uploading document' });
  }
});

// GET CLIENT DOCUMENTS FOR EXPERT (with access control)
router.get('/client/:clientId/request/:requestId', protect, authorize('expert'), async (req, res) => {
  try {
    const { clientId, requestId } = req.params;

    const approach = await Approach.findOne({
      expert: req.user.id,
      request: requestId
    });

    if (!approach) {
      return res.status(403).json({
        success: false,
        message: 'You must approach this request first to view documents'
      });
    }

    const documents = await Document.find({ owner: clientId }).lean();

    console.log('Found ' + documents.length + ' documents for client ' + clientId);

    const expertId = req.user.id.toString();

    const documentsWithAccess = documents.map(function(doc) {
      var hasAccess = doc.isPublic || (doc.grantedAccess && doc.grantedAccess.some(function(a) {
        return a.expert.toString() === expertId;
      }));
      return {
        _id: doc._id,
        originalFileName: doc.originalFileName,
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        category: doc.category,
        uploadedAt: doc.createdAt,
        isPublic: doc.isPublic,
        hasAccess: hasAccess,
        fileUrl: hasAccess ? doc.fileUrl : null
      };
    });

    res.json({
      success: true,
      count: documentsWithAccess.length,
      approachId: approach._id,
      documents: documentsWithAccess
    });

  } catch (error) {
    console.error('Get client documents error:', error);
    res.status(500).json({ success: false, message: 'Error fetching documents' });
  }
});

// GET MY DOCUMENTS
router.get('/my-documents', protect, async (req, res) => {
  try {
    const { category, requestId } = req.query;
    const query = { owner: req.user.id };
    if (category) query.category = category;
    if (requestId) query.request = requestId;
    
    const documents = await Document.find(query)
      .populate('request', 'title service')
      .sort('-createdAt')
      .lean();
    
    console.log('Found ' + documents.length + ' documents for user ' + req.user.id);
    
    res.json({ success: true, count: documents.length, documents });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ success: false, message: 'Error fetching documents' });
  }
});

// GET SINGLE DOCUMENT
router.get('/:id', protect, async (req, res) => {
  try {
    const document = await Document.findById(req.params.id)
      .populate('owner', 'name email')
      .populate('request', 'title');
    
    if (!document) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    
    const isOwner = document.owner._id.toString() === req.user.id;
    const hasAccess = document.grantedAccess.some(
      function(access) { return access.expert.toString() === req.user.id; }
    );
    
    if (!isOwner && !hasAccess && !document.isPublic) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Please request access from the owner.',
        canRequestAccess: true
      });
    }
    
    document.viewCount += 1;
    await document.save();
    
    res.json({
      success: true,
      document: {
        id: document._id,
        fileName: document.originalFileName,
        fileType: document.fileType,
        fileSize: document.fileSize,
        fileUrl: isOwner || hasAccess ? document.fileUrl : null,
        description: document.description,
        category: document.category,
        owner: document.owner,
        canDownload: isOwner || hasAccess,
        uploadedAt: document.createdAt
      }
    });
  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({ success: false, message: 'Error fetching document' });
  }
});

// DELETE DOCUMENT
router.delete('/:id', protect, blockRestrictedUser, async (req, res) => {
  try {
    const document = await Document.findById(req.params.id);
    
    if (!document) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    
    if (document.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    await document.deleteOne();
    console.log('Document deleted:', req.params.id);
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ success: false, message: 'Error deleting document' });
  }
});

// UPDATE DOCUMENT
router.put('/:id', protect, blockRestrictedUser, async (req, res) => {
  try {
    const { description, category, isPublic } = req.body;
    const document = await Document.findById(req.params.id);
    
    if (!document) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    
    if (document.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    if (description !== undefined) document.description = description;
    if (category) document.category = category;
    if (isPublic !== undefined) document.isPublic = isPublic;
    
    await document.save();
    res.json({ success: true, message: 'Document updated successfully', document });
  } catch (error) {
    console.error('Update document error:', error);
    res.status(500).json({ success: false, message: 'Error updating document' });
  }
});

// GET DOCUMENTS FOR A REQUEST
router.get('/request/:requestId', protect, async (req, res) => {
  try {
    const documents = await Document.find({ request: req.params.requestId })
      .populate('owner', 'name')
      .lean();
    
    const accessibleDocs = documents.map(function(doc) {
      var isOwner = doc.owner._id.toString() === req.user.id;
      var hasAccess = doc.grantedAccess && doc.grantedAccess.some(function(access) {
        return access.expert.toString() === req.user.id;
      });
      return {
        ...doc,
        canAccess: isOwner || hasAccess || doc.isPublic,
        isLocked: !isOwner && !hasAccess && !doc.isPublic
      };
    });
    
    res.json({ success: true, count: accessibleDocs.length, documents: accessibleDocs });
  } catch (error) {
    console.error('Get request documents error:', error);
    res.status(500).json({ success: false, message: 'Error fetching documents' });
  }
});
// REQUEST ACCESS TO A DOCUMENT
router.post('/:documentId/request-access', protect, authorize('expert'), blockRestrictedUser, async (req, res) => {
  try {
    var documentId = req.params.documentId;
    var message = req.body.message || 'I would like to access this document.';

    var document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    // Check if already requested
    var existing = await AccessRequest.findOne({
      document: documentId,
      expert: req.user.id
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Access already requested',
        status: existing.status
      });
    }

    // Create access request
    var accessRequest = await AccessRequest.create({
      document: documentId,
      expert: req.user.id,
      client: document.owner,
      message: message,
      status: 'pending'
    });

    console.log('Access request created:', accessRequest._id);

    res.json({
      success: true,
      message: 'Access request sent to client!',
      accessRequest: {
        id: accessRequest._id,
        status: accessRequest.status
      }
    });

  } catch (error) {
    console.error('Request access error:', error);
    res.status(500).json({ success: false, message: 'Error creating access request' });
  }
});
// GET CLIENT DOCUMENTS FOR EXPERT via customer interest (no approach required)
router.get('/client/:clientId/interest', protect, authorize('expert'), async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const documents = await Document.find({ owner: clientId }).lean();
    
    const expertId = req.user.id.toString();
    const documentsWithAccess = documents.map(function(doc) {
      var hasAccess = doc.isPublic || (doc.grantedAccess && doc.grantedAccess.some(function(a) {
        return a.expert.toString() === expertId;
      }));
      return {
        _id: doc._id,
        originalFileName: doc.originalFileName,
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        category: doc.category,
        uploadedAt: doc.createdAt,
        isPublic: doc.isPublic,
        hasAccess: hasAccess,
        fileUrl: hasAccess ? doc.fileUrl : null
      };
    });

    res.json({
      success: true,
      count: documentsWithAccess.length,
      approachId: null,
      documents: documentsWithAccess
    });
  } catch (error) {
    console.error('Get client documents (interest) error:', error);
    res.status(500).json({ success: false, message: 'Error fetching documents' });
  }
});
module.exports = router;
