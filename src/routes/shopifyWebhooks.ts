import { Router } from 'express';
import { ShopifyWebhookController } from '../controllers/shopifyWebhook.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { verifyShopifyWebhook } from '../middlewares/verifyShopifyWebhook';

const router = Router();

router.post('/orders-create', verifyShopifyWebhook, asyncHandler(ShopifyWebhookController.ordersCreate));

export default router;
