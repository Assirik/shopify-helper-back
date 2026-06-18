import { Router } from 'express';
import { MessageController } from '../controllers/message.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(MessageController.list));
router.get('/:id', requireAuth, asyncHandler(MessageController.detail));
router.post('/:id/retry', requireAuth, asyncHandler(MessageController.retry));

export default router;
