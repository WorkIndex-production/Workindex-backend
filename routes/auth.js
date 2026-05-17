// routes/auth.js
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const ExpertInvite = require('../models/ExpertInvite');
const { sendOTPEmail } = require('../utils/emailService');

// ─── HELPERS ─────────────────────────────────────────────
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
// SIGNUP STEP 1 — Collect details & send OTP
// POST /api/auth/send-otp
// ═══════════════════════════════════════════════════════════
router.post('/send-otp', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone').matches(/^[0-9]{10}$/).withMessage('Valid 10-digit phone required'),
  body('password').isLength({ min: 6 }).withMessage('Password min 6 characters'),
  body('role').isIn(['client', 'expert']).withMessage('Role must be client or expert')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { name, email, phone, password, role, inviteCode } = req.body;
    const inviter = role === 'expert' ? await findInviter(inviteCode) : null;

    // Check if a verified account already exists
    const existing = await User.findOne({
      $or: [
        { email, emailVerified: true },
        { phone, emailVerified: true }
      ]
    });
    if (existing) {
      const field = existing.email === email ? 'email' : 'phone number';
      return res.status(400).json({
        success: false,
        message: `An account with this ${field} already exists. Please log in.`
      });
    }

    // Remove any previous unverified registration for this email
    await User.deleteOne({ email, emailVerified: false });

    // Generate OTP
    const otp = generateOTP();

    // Create pending (unverified) user
    const pendingUser = await User.create({
      name,
      email,
      phone,
      password,
      role,
      credits: 50,
      referredBy: inviter ? inviter._id : null,
      emailVerified: false,
      phoneVerified: false,
      emailOTP:  otp,
      otpExpiry: new Date(Date.now() + 10 * 60 * 1000) // 10 min
    });

    if (inviter) {
      await ExpertInvite.findOneAndUpdate(
        { inviter: inviter._id, invitedEmail: email },
        { inviter: inviter._id, invitedEmail: email, invitedUser: pendingUser._id, inviteCode: inviter.inviteCode, status: 'invited' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    // Send OTP email
    const emailResult = await sendOTPEmail({ to: email, name, otp, purpose: 'signup' });
    if (!emailResult.success) {
      await User.deleteOne({ email, emailVerified: false });
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP email. Please try again.'
      });
    }

    res.json({
      success: true,
      message: `Verification code sent to ${email}`
    });

  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════
// SIGNUP STEP 2 — Verify OTP & activate account
// POST /api/auth/verify-otp-register
// ═══════════════════════════════════════════════════════════
router.post('/verify-otp-register', [
  body('email').isEmail().normalizeEmail(),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { email, otp } = req.body;

    const user = await User.findOne({ email, emailVerified: false });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No pending registration found. Please sign up again.'
      });
    }

    if (user.emailOTP !== otp) {
      return res.status(400).json({ success: false, message: 'Incorrect OTP. Please try again.' });
    }

    if (Date.now() > new Date(user.otpExpiry).getTime()) {
      await User.deleteOne({ _id: user._id });
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please sign up again.'
      });
    }

    // Activate account
    user.emailVerified = true;
    user.phoneVerified = true;
    await ensureInviteCode(user);
    user.emailOTP  = undefined;
    user.otpExpiry = undefined;
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
  else sendExpertWelcome({ to: user.email, name: user.name }).catch(() => {});
} catch(e) {}

try {
  const { logAudit } = require('../utils/audit');
  logAudit(
    { id: user._id, role: user.role, name: user.name },
    'signup',
    { type: 'user', id: user._id, name: user.name },
    { email: user.email, role: user.role }
  ).catch(() => {});
} catch(e) {}
    
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Account verified successfully!',
      token,
      user: {
        _id:           user._id,
        id:            user._id,
        name:          user.name,
        email:         user.email,
        phone:         user.phone,
        role:          user.role,
        credits:       user.credits,
        inviteCode:    user.inviteCode,
        questionnaireCompleted: user.questionnaireCompleted || false,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified,
        profile:       user.profile || {}
      }
    });

  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════
// RESEND SIGNUP OTP
// POST /api/auth/resend-signup-otp
// ═══════════════════════════════════════════════════════════
router.post('/resend-signup-otp', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email, emailVerified: false });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No pending registration found. Please sign up again.'
      });
    }

    const otp = generateOTP();
    user.emailOTP  = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await sendOTPEmail({ to: email, name: user.name, otp, purpose: 'signup' });

    res.json({ success: true, message: 'OTP resent successfully' });

  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════
// LOGIN
// POST /api/auth/login
// ═══════════════════════════════════════════════════════════
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, role } = req.body;

    // Only find verified users
    const user = await User.findOne({ email, emailVerified: true }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Role enforcement
    if (role && user.role !== role) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Banned check
    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Please contact support.'
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    user.lastLogin = Date.now();
    await ensureInviteCode(user);
    await user.save();

    // ── Audit: login ──
    try {
      const { logAudit } = require('../utils/audit');
      logAudit(
        { id: user._id, role: user.role, name: user.name },
        'login',
        { type: 'user', id: user._id, name: user.name },
        { ip: req.ip }
      ).catch(() => {});
    } catch(e) {}

    const token = generateToken(user._id);
    res.json({
      success: true,
      token,
      user: {
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
        warnings:      user.warnings || 0,
        lastWarning:   user.lastWarning || null,
        isRestricted:  user.isRestricted || false,
        isFlagged:     user.isFlagged || false
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Error logging in' });
  }
});

// ═══════════════════════════════════════════════════════════
// FORGOT PASSWORD STEP 1 — Send OTP
// POST /api/auth/forgot-password
// ═══════════════════════════════════════════════════════════
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email, emailVerified: true });

    // Always return success (don't reveal if email exists)
    if (!user) {
      return res.json({
        success: true,
        message: 'If this email is registered, you will receive a code shortly.'
      });
    }

    const otp = generateOTP();
    user.emailOTP  = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await sendOTPEmail({ to: email, name: user.name, otp, purpose: 'forgot_password' });

    res.json({ success: true, message: 'Verification code sent to your email' });

  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════
// FORGOT PASSWORD STEP 2 — Verify OTP
// POST /api/auth/verify-reset-otp
// ═══════════════════════════════════════════════════════════
router.post('/verify-reset-otp', [
  body('email').isEmail().normalizeEmail(),
  body('otp').isLength({ min: 6, max: 6 })
], async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await User.findOne({ email, emailVerified: true });

    if (!user || user.emailOTP !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid OTP. Please try again.' });
    }

    if (Date.now() > new Date(user.otpExpiry).getTime()) {
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new one.'
      });
    }

    // Issue a short-lived reset token (15 min)
    const resetToken = jwt.sign(
      { id: user._id, purpose: 'reset_password' },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    // Clear OTP
    user.emailOTP  = undefined;
    user.otpExpiry = undefined;
    await user.save();

    res.json({
      success: true,
      message: 'OTP verified. You can now set a new password.',
      resetToken
    });

  } catch (err) {
    console.error('Verify reset OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ═══════════════════════════════════════════════════════════
// FORGOT PASSWORD STEP 3 — Set new password
// POST /api/auth/reset-password
// ═══════════════════════════════════════════════════════════
router.post('/reset-password', [
  body('resetToken').notEmpty(),
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { resetToken, newPassword } = req.body;

    // Verify reset token
    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: 'Reset session expired. Please start over.'
      });
    }

    if (decoded.purpose !== 'reset_password') {
      return res.status(400).json({ success: false, message: 'Invalid reset token.' });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Update password — pre-save hook hashes it
    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: 'Password reset successfully. You can now log in.' });

  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── Backward compatibility stubs ────────────────────────
router.post('/verify-email',    async (req, res) => res.json({ success: true }));
router.post('/send-phone-otp',  async (req, res) => res.json({ success: true }));
router.post('/verify-phone',    async (req, res) => res.json({ success: true }));
router.post('/resend-otp',      async (req, res) => res.json({ success: true }));
// ─── TEMPORARY DEBUG - remove after fixing email ───
router.get('/debug-email', async (req, res) => {
  const https = require('https');
  
  const testReq = https.get('https://api.brevo.com/v3/account', {
    headers: { 'api-key': process.env.BREVO_API_KEY }
  }, (testRes) => {
    let data = '';
    testRes.on('data', chunk => data += chunk);
    testRes.on('end', () => {
      res.json({
        statusCode: testRes.statusCode,
        envVars: {
          BREVO_API_KEY: !!process.env.BREVO_API_KEY,
          BREVO_SMTP_USER: process.env.BREVO_SMTP_USER || 'NOT SET',
          FROM_EMAIL: process.env.FROM_EMAIL || 'NOT SET'
        },
        brevoResponse: data.substring(0, 300)
      });
    });
  });
  
  testReq.on('error', (err) => {
    res.json({ 
      error: err.message,
      envVars: {
        BREVO_API_KEY: !!process.env.BREVO_API_KEY,
        BREVO_SMTP_USER: process.env.BREVO_SMTP_USER || 'NOT SET'
      }
    });
  });
});
// GET /api/auth/me — fresh restriction/warning status
const { protect } = require('../middleware/auth');
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user.userId)
  .select('warnings lastWarning isRestricted isFlagged isBanned credits preferences profile inviteCode questionnaireCompleted profileViews adminBoost rating reviewCount totalApproaches').lean();
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;
