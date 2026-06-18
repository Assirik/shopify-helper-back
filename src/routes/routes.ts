import express from 'express';
import health from './health';
import auth from './auth';
import shopifyWebhooks from './shopifyWebhooks';
import customers from './customers';
import orders from './orders';
import messages from './messages';

const router = express.Router();

router.use('/api/health', health);
router.use('/api/auth', auth);
router.use('/api/webhooks/shopify', shopifyWebhooks);
router.use('/api/customers', customers);
router.use('/api/orders', orders);
router.use('/api/messages', messages);

export default router;
