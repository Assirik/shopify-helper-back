/**
 * @openapi
 * /api/auth/signup:
 *   post:
 *     tags: [Auth]
 *     operationId: signup
 *     summary: Créer un utilisateur helpdesk
 *     description: Le rôle est toujours forcé à USER côté serveur.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userName, email, password]
 *             properties:
 *               userName: { type: string, example: helpdesk.agent }
 *               email: { type: string, format: email, example: agent@example.com }
 *               phone: { type: string, example: '+221770000000' }
 *               password: { type: string, format: password, minLength: 8, writeOnly: true }
 *     responses:
 *       201:
 *         description: Utilisateur créé.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: Successful }
 *       400:
 *         description: Données invalides ou utilisateur déjà existant.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     operationId: login
 *     summary: Obtenir un JWT helpdesk
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userName, password]
 *             properties:
 *               userName: { type: string, example: helpdesk.agent }
 *               password: { type: string, format: password, writeOnly: true }
 *     responses:
 *       200:
 *         description: Authentification réussie.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [userId, token, user, message]
 *               properties:
 *                 userId: { type: string, pattern: '^[a-fA-F0-9]{24}$' }
 *                 token: { type: string, writeOnly: true, description: JWT Bearer }
 *                 user: { $ref: '#/components/schemas/User' }
 *                 message: { type: string, example: Successful }
 *       401:
 *         description: Identifiants invalides.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     operationId: getCurrentUser
 *     summary: Lire l’utilisateur authentifié
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Utilisateur courant.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Utilisateur absent.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500: { $ref: '#/components/responses/InternalError' }
 */
export const authDocs = true;
