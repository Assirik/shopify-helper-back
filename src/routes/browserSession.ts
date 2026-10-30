import { Router } from 'express';
import {
  BrowserSessionController,
  limitSessionCaptureRate,
  parseSessionBody,
  requireAllowedSessionOrigin
} from '../controllers/browserSession.controller';
import { asyncHandler } from '../middlewares/asyncHandler';

const router = Router();

// Public route called by the Shopify theme script: origin check, then rate limit, then body.
router.post(
  '/',
  requireAllowedSessionOrigin,
  asyncHandler(limitSessionCaptureRate),
  parseSessionBody,
  asyncHandler(BrowserSessionController.capture)
);

export default router;
