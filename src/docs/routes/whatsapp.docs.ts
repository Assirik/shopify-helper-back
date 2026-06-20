/**
 * @openapi
 * /api/whatsapp/templates:
 *   get:
 *     tags: [WhatsApp Templates]
 *     operationId: listWhatsAppTemplates
 *     summary: Lister les templates du compte Meta
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 100 } }
 *       - { in: query, name: after, schema: { type: string }, description: Curseur Meta }
 *     responses:
 *       200:
 *         description: Réponse catalogue retournée par Meta.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   additionalProperties: true
 *                   description: Contient généralement data[] et paging.
 *       400:
 *         description: La limite doit être un entier compris entre 1 et 100.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500:
 *         description: Credentials Meta absents ou erreur interne.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       502:
 *         description: Échec réseau ou HTTP du provider Meta.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *
 * /api/whatsapp/message-config:
 *   get:
 *     tags: [Message Config]
 *     operationId: getMessageVariableConfig
 *     summary: Lire les variables régionales
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Configuration globale, éventuellement null si elle n’existe pas encore.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   allOf:
 *                     - { $ref: '#/components/schemas/MessageVariableConfig' }
 *                   nullable: true
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *   put:
 *     tags: [Message Config]
 *     operationId: updateMessageVariableConfig
 *     summary: Modifier les variables régionales
 *     description: >-
 *       Réservé au rôle ADMIN: un JWT valide ne suffit pas, l'utilisateur doit avoir
 *       role=ADMIN sinon la requête est refusée en 403. Mise à jour partielle;
 *       null ou chaîne vide supprime une variante.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               shippingNote: { $ref: '#/components/schemas/RegionVariant' }
 *               paymentMethod: { $ref: '#/components/schemas/RegionVariant' }
 *           example:
 *             shippingNote:
 *               dakar: Livraison à domicile
 *               nonDakar: Livraison par expédition régionale
 *             paymentMethod:
 *               dakar: Paiement à la livraison
 *     responses:
 *       200:
 *         description: Configuration enregistrée avec updatedBy.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { $ref: '#/components/schemas/MessageVariableConfig' }
 *       400:
 *         description: Champ, variante ou type invalide.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: JWT valide mais rôle ≠ ADMIN; modification interdite.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500: { $ref: '#/components/responses/InternalError' }
 */
export const whatsappDocs = true;
