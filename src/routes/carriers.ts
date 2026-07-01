import { Router } from 'express';
import { CarrierController } from '../controllers/carrier.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAdmin } from '../middlewares/requireAdmin';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(CarrierController.list));
router.post('/', requireAuth, asyncHandler(requireAdmin), asyncHandler(CarrierController.create));
router.patch('/:id', requireAuth, asyncHandler(requireAdmin), asyncHandler(CarrierController.update));
router.patch('/:id/status', requireAuth, asyncHandler(requireAdmin), asyncHandler(CarrierController.setStatus));

export default router;
