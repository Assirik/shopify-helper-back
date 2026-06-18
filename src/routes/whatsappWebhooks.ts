import { Router } from 'express';
import { WhatsAppWebhookController } from '../controllers/whatsappWebhook.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { verifyWhatsAppWebhook } from '../middlewares/verifyWhatsAppWebhook';

const router = Router();

router.get('/', asyncHandler(WhatsAppWebhookController.verify));
router.post('/', verifyWhatsAppWebhook, asyncHandler(WhatsAppWebhookController.receive));

export default router;
