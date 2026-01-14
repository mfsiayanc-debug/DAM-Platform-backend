const express = require('express');
const assetRoutes = require('./assets');
const statsRoutes = require('./stats');

const router = express.Router();

router.use('/assets', assetRoutes);
router.use('/stats', statsRoutes);

module.exports = router;
