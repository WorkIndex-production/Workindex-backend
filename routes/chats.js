const express = require('express');
const router = express.Router();
const { protect, blockRestrictedUser } = require('../middleware/auth');
const Chat = require('../models/Chat');
const Approach = require('../models/Approach'); // or whatever your approach model is
const Notification = require('../models/Notification');

function isChatParticipant(req, expertId, clientId) {
  return (req.user.role === 'expert' && String(expertId) === String(req.user.id))
    || (req.user.role === 'client' && String(clientId) === String(req.user.id));
}

// Get all chats for current user
router.get('/', protect, async (req, res) => {
  try {
    const query = req.user.role === 'expert'
      ? { expert: req.user.id }
      : { client: req.user.id };

    const chats = await Chat.find(query)
      .populate('expert', 'name profilePhoto rating')
      .populate('client', 'name profilePhoto')
      .populate('request', 'title service')
      .sort('-lastMessageAt')
      .lean();

    res.json({ success: true, chats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Direct chat between expert and client (no request needed - for customer interest unlocks)
router.post('/direct', protect, blockRestrictedUser, async (req, res) => {
  let expertId;
  let clientId;
  try {
    expertId = req.body.expertId;
    clientId = req.body.clientId;
    if (!expertId || !clientId) {
      return res.status(400).json({ success: false, message: 'expertId and clientId required' });
    }
    if (!isChatParticipant(req, expertId, clientId)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    const invite = await Notification.findOne({
      user: expertId,
      type: 'customer_interest',
      'data.clientId': String(clientId),
      'data.cancelled': { $ne: true }
    }).lean();
    if (!invite || (req.user.role === 'expert' && !(invite.data && invite.data.unlocked))) {
      return res.status(403).json({ success: false, message: 'Direct chat is available only after a valid expert invite' });
    }

    // Find ANY existing chat between these two users
    let chat = await Chat.findOne({ expert: expertId, client: clientId });

    if (!chat) {
      // Use a dummy unique requestId to avoid null unique index conflict
      chat = await Chat.create({
        expert: expertId,
        client: clientId,
        request: null,
        lastMessage: ''
      });
    }

    await chat.populate('expert', 'name profilePhoto rating');
    await chat.populate('client', 'name profilePhoto');

    res.json({ success: true, chat });
  } catch (err) {
    // If duplicate key error on null, find and return existing
    if (err.code === 11000) {
      try {
        const chat = await Chat.findOne({ expert: expertId, client: clientId });
        if (chat) return res.json({ success: true, chat });
      } catch (e) {}
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get or create chat (called when Contact button clicked or expert approaches)
router.post('/start', protect, blockRestrictedUser, async (req, res) => {
  try {
    const { requestId, expertId, clientId } = req.body;

    // If no requestId, treat as direct chat
    if (!requestId || requestId === 'null') {
      if (!isChatParticipant(req, expertId, clientId)) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
      }
      const invite = await Notification.findOne({
        user: expertId,
        type: 'customer_interest',
        'data.clientId': String(clientId),
        'data.cancelled': { $ne: true }
      }).lean();
      if (!invite || (req.user.role === 'expert' && !(invite.data && invite.data.unlocked))) {
        return res.status(403).json({ success: false, message: 'Direct chat is available only after a valid expert invite' });
      }
      let chat = await Chat.findOne({ expert: expertId, client: clientId });
      if (!chat) {
        chat = await Chat.create({
          expert: expertId,
          client: clientId,
          request: null,
          lastMessage: ''
        });
      }
      await chat.populate('expert', 'name profilePhoto rating');
      await chat.populate('client', 'name profilePhoto');
      return res.json({ success: true, chat });
    }

    // Verify an approach exists (expert paid credits)
    const approach = await Approach.findOne({
      request: requestId,
      expert: expertId
    });

    if (!approach) {
      return res.status(403).json({ 
        success: false, 
        message: 'No approach found. Expert must approach first.' 
      });
    }
    if (!isChatParticipant(req, expertId, clientId) || String(approach.client) !== String(clientId)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    // Find existing or create new chat
    let chat = await Chat.findOne({
      request: requestId,
      expert: expertId,
      client: clientId
    });

    if (!chat) {
      chat = await Chat.create({
        request: requestId,
        expert: expertId,
        client: clientId,
        messages: []
      });
    }

    await chat.populate('expert', 'name profilePhoto rating');
    await chat.populate('client', 'name profilePhoto');
    await chat.populate('request', 'title service');

    res.json({ success: true, chat });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get messages for a specific chat
router.get('/:chatId/messages', protect, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId)
      .populate('messages.sender', 'name profilePhoto');

    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    const isParticipant =
      chat.expert.toString() === req.user.id ||
      chat.client.toString() === req.user.id;

    if (!isParticipant) return res.status(403).json({ success: false, message: 'Not authorized' });

    // Mark messages as read
    const userId = req.user.id;
    chat.messages.forEach(msg => {
      const senderId = msg.sender && msg.sender._id ? msg.sender._id.toString() : msg.sender.toString();
      if (senderId !== userId && !msg.readAt) {
        msg.readAt = new Date();
      }
    });
    await chat.save();

    res.json({ success: true, messages: chat.messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Mark messages as read without reloading the full thread.
router.post('/:chatId/read', protect, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    const isParticipant =
      chat.expert.toString() === req.user.id ||
      chat.client.toString() === req.user.id;

    if (!isParticipant) return res.status(403).json({ success: false, message: 'Not authorized' });

    chat.messages.forEach(msg => {
      if (msg.sender.toString() !== req.user.id && !msg.readAt) {
        msg.readAt = new Date();
      }
    });
    await chat.save();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Send a message
router.post('/:chatId/messages', protect, blockRestrictedUser, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Message required' });

    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    // Verify user belongs to this chat
    const isParticipant = 
      chat.expert.toString() === req.user.id || 
      chat.client.toString() === req.user.id;

    if (!isParticipant) return res.status(403).json({ success: false, message: 'Not authorized' });

    const message = { sender: req.user.id, text: text.trim() };
    chat.messages.push(message);
    chat.lastMessage = text.trim();
    chat.lastMessageAt = new Date();
    await chat.save();

    res.json({ success: true, message: chat.messages[chat.messages.length - 1] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
