import { Router } from 'express';
import { DashboardController } from '../controllers/dashboard.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/stats', requireAuth, asyncHandler(DashboardController.stats));

export default router;
