import { Router } from 'express';
import { OrderController } from '../controllers/order.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(OrderController.list));
router.get('/attention', requireAuth, asyncHandler(OrderController.attentionQueue));
router.post('/bulk/confirm', requireAuth, asyncHandler(OrderController.bulkConfirm));
router.post('/:id/confirm', requireAuth, asyncHandler(OrderController.confirm));
router.post('/:id/cancel', requireAuth, asyncHandler(OrderController.cancel));
router.post('/:id/remind', requireAuth, asyncHandler(OrderController.remind));
router.get('/:id', requireAuth, asyncHandler(OrderController.detail));

export default router;
