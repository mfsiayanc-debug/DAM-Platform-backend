const jwt = require('jsonwebtoken');
const config = require('../config');

function getUserFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  if (!token) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }

  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    return { id: payload.sub, email: payload.email, role: payload.role };
  } catch {
    const error = new Error('Invalid or expired token');
    error.status = 401;
    throw error;
  }
}

// Simple JWT auth middleware
function authenticate(req, res, next) {
  try {
    req.user = getUserFromRequest(req);
    next();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }
}

module.exports = {
  getUserFromRequest,
  authenticate,
};
