/**
 * @openapi
 * /api/auth/bootstrap:
 *   post:
 *     tags: [Auth]
 *     operationId: bootstrapInitialAdmin
 *     summary: Créer le premier administrateur
 *     description: Disponible uniquement si INITIAL_ADMIN_BOOTSTRAP_SECRET est configuré et qu'aucun administrateur n'existe encore.
 *     parameters:
 *       - in: header
 *         name: X-Bootstrap-Secret
 *         required: true
 *         schema: { type: string, minLength: 32, writeOnly: true }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/InitialAdminInput' }
 *     responses:
 *       201:
 *         description: Premier administrateur créé.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: Données invalides.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ValidationError' } } }
 *       401:
 *         description: Secret de bootstrap invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bootstrap désactivé dans cet environnement.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Un administrateur existe déjà, un bootstrap concurrent a abouti ou l'identité est déjà utilisée.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500: { $ref: '#/components/responses/InternalError' }
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
 *                 token: { type: string, writeOnly: true }
 *                 user: { $ref: '#/components/schemas/User' }
 *                 message: { type: string, example: Successful }
 *       401:
 *         description: Identifiants invalides.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Compte désactivé.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
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
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *
 * /api/auth/me/password:
 *   put:
 *     tags: [Auth]
 *     operationId: changeOwnPassword
 *     summary: Changer son propre mot de passe
 *     description: Révoque tous les JWT existants du compte après le changement.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string, format: password, writeOnly: true }
 *               newPassword: { type: string, format: password, minLength: 8, maxLength: 72, writeOnly: true }
 *     responses:
 *       200: { description: Mot de passe changé et sessions révoquées. }
 *       400:
 *         description: Nouveau mot de passe invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Utilisateur absent.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *
 * /api/auth/users:
 *   get:
 *     tags: [User Administration]
 *     operationId: listUsers
 *     summary: Lister les comptes helpdesk
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: role, schema: { type: string, enum: [ADMIN, USER, DEVELOPER] } }
 *       - { in: query, name: active, schema: { type: boolean } }
 *     responses:
 *       200:
 *         description: Liste paginée des comptes.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/User' } }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [User Administration]
 *     operationId: createUser
 *     summary: Créer un compte helpdesk
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AdminCreateUserInput' }
 *     responses:
 *       201:
 *         description: Compte créé.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: Données invalides.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ValidationError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409:
 *         description: Nom, email ou téléphone déjà utilisé.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *
 * /api/auth/users/{userId}:
 *   parameters:
 *     - { in: path, name: userId, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *   get:
 *     tags: [User Administration]
 *     operationId: getUser
 *     summary: Consulter un compte helpdesk
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Compte trouvé.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { $ref: '#/components/schemas/User' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: Compte absent.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *   patch:
 *     tags: [User Administration]
 *     operationId: updateUser
 *     summary: Modifier l’identité ou le rôle d’un compte
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AdminUpdateUserInput' }
 *     responses:
 *       200: { description: Compte modifié. }
 *       400:
 *         description: Données invalides.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ValidationError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: Compte absent.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Conflit d’unicité ou tentative de modifier son propre rôle.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *
 * /api/auth/users/{userId}/password:
 *   put:
 *     tags: [User Administration]
 *     operationId: resetUserPassword
 *     summary: Réinitialiser le mot de passe d’un compte
 *     description: Révoque tous les JWT existants du compte.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: userId, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string, format: password, minLength: 8, maxLength: 72, writeOnly: true }
 *     responses:
 *       200: { description: Mot de passe réinitialisé et sessions révoquées. }
 *       400:
 *         description: Mot de passe invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: Compte absent.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *
 * /api/auth/users/{userId}/status:
 *   patch:
 *     tags: [User Administration]
 *     operationId: setUserStatus
 *     summary: Activer ou désactiver un compte
 *     description: La désactivation est une suppression logique et révoque tous les JWT du compte.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: userId, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isActive]
 *             properties:
 *               isActive: { type: boolean }
 *     responses:
 *       200: { description: Statut modifié. }
 *       400:
 *         description: Statut invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ValidationError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: Compte absent.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Un administrateur ne peut pas désactiver son propre compte.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
export const authDocs = true;
