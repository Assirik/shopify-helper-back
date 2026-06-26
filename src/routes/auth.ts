import { AuthController as Auth } from '../controllers/auth.controller';
import { Router } from 'express';
import { requireAuth } from '../middlewares/requireAuth';

const router = Router();

router.post('/signup', Auth.signup);
router.post('/login', Auth.login);
router.get('/me', requireAuth, Auth.me);

export default router;
