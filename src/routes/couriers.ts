import { Router } from 'express';
import { CourierController } from '../controllers/courier.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAdmin } from '../middlewares/requireAdmin';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(CourierController.list));
router.post('/', requireAuth, asyncHandler(requireAdmin), asyncHandler(CourierController.create));
router.patch('/:id', requireAuth, asyncHandler(requireAdmin), asyncHandler(CourierController.update));
router.patch('/:id/status', requireAuth, asyncHandler(requireAdmin), asyncHandler(CourierController.setStatus));

export default router;
