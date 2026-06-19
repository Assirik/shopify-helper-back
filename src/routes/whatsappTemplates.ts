import { Router } from 'express';
import { WhatsAppTemplateController } from '../controllers/whatsappTemplate.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/templates', requireAuth, asyncHandler(WhatsAppTemplateController.list));

export default router;
