import { Router } from 'express';
import { DeliveryFeeConfigController } from '../controllers/deliveryFeeConfig.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAdmin } from '../middlewares/requireAdmin';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(DeliveryFeeConfigController.get));
router.put('/', requireAuth, asyncHandler(requireAdmin), asyncHandler(DeliveryFeeConfigController.update));

export default router;
