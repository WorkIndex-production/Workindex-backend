// routes/google-auth.js
// Requires: google-auth-library (added to package.json)

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const User = require('../models/User');
const ExpertInvite = require('../models/ExpertInvite');
const { sendOTPEmail } = require('../utils/emailService');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d'
  });

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const makeInviteCode = (name) => {
  const prefix = String(name || 'WI').replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase() || 'WI';
  return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
};

async function ensureInviteCode(user) {
  if (user.role !== 'expert' || user.inviteCode) return;
  let code = makeInviteCode(user.name);
  while (await User.exists({ inviteCode: code })) code = makeInviteCode(user.name);
  user.inviteCode = code;
}

async function findInviter(inviteCode) {
  const code = String(inviteCode || '').trim().toUpperCase();
  if (!code) return null;
  return User.findOne({ role: 'expert', inviteCode: code, emailVerified: true }).select('_id inviteCode');
}


// ═══════════════════════════════════════════════════════════
// STEP 1 — Verify Google token
//   Existing verified user → log in immediately (no OTP)
//   New user               → create pending record + send OTP
// POST /api/auth/google-init
// Body: { credential: <Google ID token>, role: 'client'|'expert' }
// ═══════════════════════════════════════════════════════════
router.post('/google-init', async (req, res) => {
  try {
    const { credential, role, inviteCode } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, message: 'Google credential missing.' });
    }

    // Verify with Google
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken:  credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Invalid Google token. Please try again.' });
    }

    const { sub: googleId, email, name, picture } = payload;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Google account has no email address.' });
    }

    // Check for existing verified account
    const existingVerified = await User.findOne({ email, emailVerified: true });

    if (existingVerified) {
      // ── RETURNING USER — login, no OTP needed ─────────
      if (existingVerified.isBanned) {
        return res.status(403).json({
          success: false,
          message: 'Your account has been suspended. Please contact support.',
        });
      }

      if (!existingVerified.googleId) existingVerified.googleId = googleId;
      if (!existingVerified.profilePhoto && picture) existingVerified.profilePhoto = picture;
      existingVerified.lastLogin = Date.now();
      await ensureInviteCode(existingVerified);
      await existingVerified.save();

      try {
        const { logAudit } = require('../utils/audit');
        logAudit(
          { id: existingVerified._id, role: existingVerified.role, name: existingVerified.name },
          'login_google',
          { type: 'user', id: existingVerified._id, name: existingVerified.name },
          { ip: req.ip }
        ).catch(() => {});
      } catch (e) {}

      return res.json({
        success: true,
        action:  'login',
        message: 'Logged in successfully!',
        token:   generateToken(existingVerified._id),
        user:    buildUserObject(existingVerified),
      });
    }

    // ── NEW USER — send OTP to their Google email ────────
    const signupRole = role && ['client', 'expert'].includes(role) ? role : 'client';
    const inviter = signupRole === 'expert' ? await findInviter(inviteCode) : null;

    // Remove any previous unverified attempt
    await User.deleteOne({ email, emailVerified: false });

    const otp = generateOTP();

    const pendingUser = await User.create({
      name,
      email,
      phone:         undefined,
      password:      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      role:          signupRole,
      credits:       50,
      referredBy:    inviter ? inviter._id : null,
      googleId,
      profilePhoto:  picture || '',
      emailVerified: false,
      phoneVerified: false,
      emailOTP:      otp,
      otpExpiry:     new Date(Date.now() + 10 * 60 * 1000),
    });

    if (inviter) {
      await ExpertInvite.findOneAndUpdate(
        { inviter: inviter._id, invitedEmail: email },
        { inviter: inviter._id, invitedEmail: email, invitedUser: pendingUser._id, inviteCode: inviter.inviteCode, status: 'invited' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const emailResult = await sendOTPEmail({ to: email, name, otp, purpose: 'signup' });

    if (!emailResult.success) {
      await User.deleteOne({ email, emailVerified: false });
      return res.status(500).json({
        success: false,
        message: 'Failed to send verification email. Please try again.',
      });
    }

    return res.json({
      success: true,
      action:  'verify_otp',
      message: `Verification code sent to ${email}`,
      email,
    });

  } catch (err) {
    console.error('Google init error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});


// ═══════════════════════════════════════════════════════════
// STEP 2 — Verify OTP and activate Google account
// POST /api/auth/google-verify-otp
// Body: { email, otp }
// ═══════════════════════════════════════════════════════════
router.post('/google-verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
    }

    const user = await User.findOne({ email, emailVerified: false });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No pending registration found. Please sign up again.',
      });
    }

    if (user.emailOTP !== otp) {
      return res.status(400).json({ success: false, message: 'Incorrect code. Please try again.' });
    }

    if (Date.now() > new Date(user.otpExpiry).getTime()) {
      await User.deleteOne({ _id: user._id });
      return res.status(400).json({
        success: false,
        message: 'Code has expired. Please sign up again.',
      });
    }

    user.emailVerified = true;
    user.phoneVerified = false;
    await ensureInviteCode(user);
    user.emailOTP      = undefined;
    user.otpExpiry     = undefined;
    user.lastLogin     = Date.now();
    await user.save();

    if (user.role === 'expert' && user.referredBy) {
      await ExpertInvite.findOneAndUpdate(
        { inviter: user.referredBy, invitedUser: user._id },
        { inviter: user.referredBy, invitedUser: user._id, invitedEmail: user.email, status: 'approach_pending' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    try {
      const { sendClientWelcome, sendExpertWelcome } = require('../utils/notificationEmailService');
      if (user.role === 'client') sendClientWelcome({ to: user.email, name: user.name }).catch(() => {});
      else                        sendExpertWelcome({ to: user.email, name: user.name }).catch(() => {});
    } catch (e) {}

    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: user._id, role: user.role, name: user.name },
        'signup_google',
        { type: 'user', id: user._id, name: user.name },
        { email: user.email, role: user.role }
      ).catch(() => {});
    } catch (e) {}

    return res.status(201).json({
      success: true,
      action:  'signup_complete',
       needsPhone:    true, 
      message: 'Account verified successfully!',
      token:   generateToken(user._id),
      user:    buildUserObject(user),
    });

  } catch (err) {
    console.error('Google verify OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});


// ═══════════════════════════════════════════════════════════
// RESEND OTP for Google signup
// POST /api/auth/google-resend-otp
// Body: { email }
// ═══════════════════════════════════════════════════════════
router.post('/google-resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email, emailVerified: false });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No pending registration found. Please sign up again.',
      });
    }

    const otp = generateOTP();
    user.emailOTP  = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await sendOTPEmail({ to: email, name: user.name, otp, purpose: 'signup' });

    res.json({ success: true, message: 'Code resent successfully.' });

  } catch (err) {
    console.error('Google resend OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});


function buildUserObject(user) {
  return {
    _id:           user._id,
    id:            user._id,
    name:          user.name,
    email:         user.email,
    phone:         user.phone,
    role:          user.role,
    credits:       user.credits,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
    profile:       user.profile || {},
    inviteCode:    user.inviteCode,
    questionnaireCompleted: user.questionnaireCompleted || false,
    profilePhoto:  user.profilePhoto,
    location:      user.location,
    preferences:   user.preferences,
    warnings:      user.warnings      || 0,
    lastWarning:   user.lastWarning   || null,
    isRestricted:  user.isRestricted  || false,
    isFlagged:     user.isFlagged     || false,
  };
}

module.exports = router;
