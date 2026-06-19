import { Router } from 'express';
import { MessageVariableConfigController } from '../controllers/messageVariableConfig.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAdmin } from '../middlewares/requireAdmin';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(MessageVariableConfigController.get));
router.put('/', requireAuth, asyncHandler(requireAdmin), asyncHandler(MessageVariableConfigController.update));

export default router;
