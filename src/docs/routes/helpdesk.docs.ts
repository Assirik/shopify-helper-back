/**
 * @openapi
 * /api/customers:
 *   get:
 *     tags: [Customers]
 *     operationId: listCustomers
 *     summary: Lister les clients
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Recherche textuelle }
 *       - { in: query, name: phone, schema: { type: string }, description: Téléphone brut ou E.164 }
 *       - { in: query, name: email, schema: { type: string, format: email } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Page de clients.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Customer' } }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders:
 *   get:
 *     tags: [Orders]
 *     operationId: listOrders
 *     summary: Lister les commandes
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, sent, failed, skipped, partially_sent] }
 *       - in: query
 *         name: customerConfirmationStatus
 *         schema: { type: string, enum: [pending, confirmed, needs_attention, expired, cancelled, sms_only] }
 *       - { in: query, name: orderName, schema: { type: string }, example: '#1001' }
 *       - { in: query, name: phone, schema: { type: string } }
 *       - { in: query, name: cod, schema: { type: boolean }, description: Filtre les commandes cash on delivery si true ou false. }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Page de commandes.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Order' } }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders/attention:
 *   get:
 *     tags: [Orders]
 *     operationId: listAttentionOrders
 *     summary: Lister la file de décisions humaines
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: reason, schema: { type: string, enum: [free_text, sms_only, invalid_number, late_confirm, phone_mismatch, notification_not_scheduled] } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Page de commandes à traiter et compteurs globaux.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/AttentionOrder' } }
 *                 counts: { $ref: '#/components/schemas/AttentionCounts' }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 *       400:
 *         description: Raison de file invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders/bulk/confirm:
 *   post:
 *     tags: [Orders]
 *     operationId: bulkConfirmOrders
 *     summary: Confirmer plusieurs commandes éligibles
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/BulkOrderInput' }
 *     responses:
 *       200:
 *         description: Toutes les commandes ont été confirmées.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BulkOrderResult' } } }
 *       207:
 *         description: Résultat partiel avec une erreur détaillée par commande.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BulkOrderResult' } } }
 *       400:
 *         description: Liste d'identifiants invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders/bulk/remind:
 *   post:
 *     tags: [Orders]
 *     operationId: bulkRemindOrders
 *     summary: Relancer plusieurs commandes éligibles
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/BulkOrderInput' }
 *     responses:
 *       200:
 *         description: Toutes les relances ont été mises en file.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BulkOrderResult' } } }
 *       207:
 *         description: Résultat partiel avec une erreur détaillée par commande.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BulkOrderResult' } } }
 *       400:
 *         description: Liste d'identifiants invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders/{id}:
 *   get:
 *     tags: [Orders]
 *     operationId: getOrder
 *     summary: Lire une commande et ses messages
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' }
 *     responses:
 *       200:
 *         description: Détail de la commande.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     order: { $ref: '#/components/schemas/Order' }
 *                     messages: { type: array, items: { $ref: '#/components/schemas/Message' } }
 *                     messageSummary:
 *                       type: object
 *                       properties:
 *                         total: { type: integer }
 *                         byStatus: { type: object, additionalProperties: { type: integer } }
 *                         byChannel: { type: object, additionalProperties: { type: integer } }
 *                         byProvider: { type: object, additionalProperties: { type: integer } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Commande absente.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders/{id}/confirm:
 *   post:
 *     tags: [Orders]
 *     operationId: confirmOrder
 *     summary: Confirmer manuellement une commande
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *     responses:
 *       202:
 *         description: Commande confirmée et notification mise en file.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/OrderJobResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Commande absente.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Confirmation incompatible avec l’état actuel.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders/{id}/cancel:
 *   post:
 *     tags: [Orders]
 *     operationId: cancelOrder
 *     summary: Annuler manuellement une commande
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, minLength: 1, maxLength: 500, example: Demande du client }
 *     responses:
 *       200:
 *         description: Commande annulée; la notification est optionnelle selon la configuration Meta.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/OrderJobResponse' }
 *       400:
 *         description: Raison d’annulation absente.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Commande absente.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/orders/{id}/remind:
 *   post:
 *     tags: [Orders]
 *     operationId: remindOrder
 *     summary: Envoyer une relance de confirmation
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *     responses:
 *       202:
 *         description: Relance mise en file.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/OrderJobResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Commande absente.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Statut, limite, délai ou concurrence incompatible avec la relance.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/messages:
 *   get:
 *     tags: [Messages]
 *     operationId: listMessages
 *     summary: Lister les messages
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [queued, sending, sent, delivered, read, failed] } }
 *       - { in: query, name: channel, schema: { type: string, enum: [whatsapp, sms] } }
 *       - { in: query, name: provider, schema: { type: string, enum: [meta, termii] } }
 *       - { in: query, name: orderName, schema: { type: string }, description: Recherche insensible à la casse sur le nom de commande Shopify. }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       200:
 *         description: Page de messages.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Message' } }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/messages/{id}:
 *   get:
 *     tags: [Messages]
 *     operationId: getMessage
 *     summary: Lire un message
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *     responses:
 *       200:
 *         description: Message trouvé.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { $ref: '#/components/schemas/Message' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Message absent.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/messages/{id}/retry:
 *   post:
 *     tags: [Messages]
 *     operationId: retryMessage
 *     summary: Remettre un message échoué en file
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' } }
 *     responses:
 *       202:
 *         description: Message remis en file.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/MessageJobResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Message absent.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Le message n’est pas en échec.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /api/dashboard/stats:
 *   get:
 *     tags: [Dashboard]
 *     operationId: getDashboardStats
 *     summary: Lire les métriques opérationnelles du helpdesk
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Métriques calculées depuis Mongo, enrichies par BullMQ si disponible.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { $ref: '#/components/schemas/DashboardStats' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       500: { $ref: '#/components/responses/InternalError' }
 */
export const helpdeskDocs = true;
