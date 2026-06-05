import { AuthController as Auth } from '../controllers/auth.controller';
import { Router } from 'express';

const router = Router();

router.post('/signup', Auth.signup);
router.post('/login', Auth.login);

export default router;
