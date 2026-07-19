import express from 'express';
import assetRoutes from './assets';
import authRoutes from './auth';
import statsRoutes from './stats';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/assets', assetRoutes);
router.use('/stats', statsRoutes);

export default router;
