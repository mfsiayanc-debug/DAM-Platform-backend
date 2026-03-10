const express = require('express');
const assetRoutes = require('./assets');
const statsRoutes = require('./stats');
const authRoutes = require('./auth');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/assets', assetRoutes);
router.use('/stats', statsRoutes);

module.exports = router;
