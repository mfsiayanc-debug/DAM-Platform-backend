import express from 'express';
import { getStats } from '../controllers/statsController';
import { authenticate } from '../middleware/auth';

const router = express.Router();

router.get('/', authenticate, getStats);

export default router;
