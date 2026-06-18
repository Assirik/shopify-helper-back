import { Router } from 'express';
import { CustomerController } from '../controllers/customer.controller';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.get('/', requireAuth, asyncHandler(CustomerController.list));

export default router;
