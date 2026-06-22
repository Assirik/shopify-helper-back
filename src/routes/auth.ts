import { AuthController as Auth } from '../controllers/auth.controller';
import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { requireAdmin } from '../middlewares/requireAdmin';
import { requireAuth } from '../middlewares/requireAuth';
import { requireBootstrapSecret } from '../middlewares/requireBootstrapSecret';

const router = Router();

router.post('/bootstrap', requireBootstrapSecret, asyncHandler(Auth.bootstrapAdmin));
router.post('/login', asyncHandler(Auth.login));
router.get('/me', asyncHandler(requireAuth), asyncHandler(Auth.me));
router.put('/me/password', asyncHandler(requireAuth), asyncHandler(Auth.changeOwnPassword));

router.get('/users', asyncHandler(requireAuth), asyncHandler(requireAdmin), asyncHandler(Auth.listUsers));
router.post('/users', asyncHandler(requireAuth), asyncHandler(requireAdmin), asyncHandler(Auth.createUser));
router.get('/users/:userId', asyncHandler(requireAuth), asyncHandler(requireAdmin), asyncHandler(Auth.getUser));
router.patch('/users/:userId', asyncHandler(requireAuth), asyncHandler(requireAdmin), asyncHandler(Auth.updateUser));
router.put('/users/:userId/password', asyncHandler(requireAuth), asyncHandler(requireAdmin), asyncHandler(Auth.resetUserPassword));
router.patch('/users/:userId/status', asyncHandler(requireAuth), asyncHandler(requireAdmin), asyncHandler(Auth.setUserStatus));

export default router;
