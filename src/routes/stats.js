const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getStats } = require('../controllers/statsController');

const router = express.Router();

router.get('/', authenticate, getStats);

module.exports = router;
