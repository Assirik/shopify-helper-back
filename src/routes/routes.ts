import express from 'express';
import health from './health';
import auth from './auth';
import shopifyWebhooks from './shopifyWebhooks';
import customers from './customers';
import orders from './orders';
import messages from './messages';
import dashboard from './dashboard';
import whatsappWebhooks from './whatsappWebhooks';
import whatsappTemplates from './whatsappTemplates';
import messageConfig from './messageConfig';

const router = express.Router();

router.use('/api/health', health);
router.use('/api/auth', auth);
router.use('/api/webhooks/shopify', shopifyWebhooks);
router.use('/api/webhooks/whatsapp', whatsappWebhooks);
router.use('/api/whatsapp', whatsappTemplates);
router.use('/api/whatsapp/message-config', messageConfig);
router.use('/api/customers', customers);
router.use('/api/orders', orders);
router.use('/api/messages', messages);
router.use('/api/dashboard', dashboard);

export default router;
