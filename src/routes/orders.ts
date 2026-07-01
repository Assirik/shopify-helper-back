import { Router } from 'express';
import { OrderController } from '../controllers/order.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(OrderController.list));
router.get('/attention', requireAuth, asyncHandler(OrderController.attentionQueue));
router.get('/reconciliation', requireAuth, asyncHandler(OrderController.reconciliation));
router.post('/bulk/confirm', requireAuth, asyncHandler(OrderController.bulkConfirm));
router.post('/bulk/remind', requireAuth, asyncHandler(OrderController.bulkRemind));
router.post('/:id/confirm', requireAuth, asyncHandler(OrderController.confirm));
router.post('/:id/cancel', requireAuth, asyncHandler(OrderController.cancel));
router.post('/:id/remind', requireAuth, asyncHandler(OrderController.remind));
router.post('/:id/dispatch', requireAuth, asyncHandler(OrderController.dispatch));
router.post('/:id/deliver', requireAuth, asyncHandler(OrderController.deliver));
router.post('/:id/delivery-failed', requireAuth, asyncHandler(OrderController.markDeliveryFailed));
router.post('/:id/return', requireAuth, asyncHandler(OrderController.markReturned));
router.get('/:id', requireAuth, asyncHandler(OrderController.detail));

export default router;
