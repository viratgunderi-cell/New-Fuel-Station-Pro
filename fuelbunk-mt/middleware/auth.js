'use strict';
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function authenticate(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.userId,
      username: payload.username,
      role: payload.role,
      stationId: payload.stationId,
      stationCode: payload.stationCode,
      isSuperAdmin: payload.isSuperAdmin || false
    };
    next();
  } catch(err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, error: 'Session expired.', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ success: false, error: 'Invalid token.' });
  }
}

function authenticateSuperAdmin(req, res, next) {
  authenticate(req, res, () => {
    if (!req.user.isSuperAdmin) return res.status(403).json({ success: false, error: 'Super admin access required.' });
    next();
  });
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (req.user.isSuperAdmin) return next(); // super admin passes all
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, error: `Access denied. Required: ${roles.join(' or ')}.` });
    next();
  };
}

module.exports = { authenticate, authenticateSuperAdmin, authorize };
