const jwt = require('jsonwebtoken');
const User = require('../models/User');

exports.protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id);
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }
    if (req.user.isBanned) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_BANNED',
        message: 'Your account has been banned. Please contact support.'
      });
    }

    // Update lastOnline silently without delaying the request.
    User.findByIdAndUpdate(decoded.id, { lastOnline: new Date() }).catch(() => {});

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized'
    });
  }
};

exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    next();
  };
};

exports.blockRestrictedUser = (req, res, next) => {
  if (req.user && req.user.isRestricted) {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_RESTRICTED',
      message: 'Your account is restricted. Please contact support before taking this action.'
    });
  }
  next();
};

exports.authenticate = exports.protect;
