import express from 'express';
import health from './health';
import auth from './auth';

const router = express.Router();

router.use('/api/health', health);
router.use('/api/auth', auth);

export default router;
