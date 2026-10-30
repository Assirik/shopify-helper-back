/**
 * @openapi
 * /api/webhooks/shopify/orders-create:
 *   post:
 *     tags: [Shopify Webhooks]
 *     operationId: receiveShopifyOrder
 *     summary: Ingérer une commande Shopify
 *     description: Webhook public authentifié par HMAC SHA-256 calculé sur le corps brut. Les doublons sont acquittés sans recréer la commande. La demande de confirmation WhatsApp n'est pas envoyée tout de suite ; elle est programmée après CONFIRMATION_INITIAL_REQUEST_DELAY_MINUTES (5 min minimum) et ne part que si la commande est toujours en attente à l'échéance.
 *     parameters:
 *       - in: header
 *         name: X-Shopify-Hmac-Sha256
 *         required: true
 *         schema: { type: string }
 *         description: Signature Base64 du corps brut avec SHOPIFY_WEBHOOK_SECRET.
 *       - in: header
 *         name: X-Shopify-Topic
 *         schema: { type: string, example: orders/create }
 *       - in: header
 *         name: X-Shopify-Shop-Domain
 *         schema: { type: string, example: example-shop.myshopify.com }
 *       - in: header
 *         name: X-Shopify-Webhook-Id
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, name, total_price, currency]
 *             additionalProperties: true
 *             properties:
 *               id: { oneOf: [{ type: string }, { type: integer }] }
 *               name: { type: string, example: '#1001' }
 *               total_price: { type: string, example: '14000' }
 *               currency: { type: string, example: XOF }
 *               phone: { type: string, example: '+221770000000' }
 *               line_items: { type: array, items: { type: object, additionalProperties: true } }
 *               note_attributes: { type: array, items: { type: object, additionalProperties: true } }
 *     responses:
 *       202:
 *         description: Webhook accepté, qu’il soit nouveau, ignoré ou dupliqué.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [accepted]
 *               properties:
 *                 accepted: { type: boolean, example: true }
 *                 duplicate: { type: boolean }
 *                 orderId: { type: string, pattern: '^[a-fA-F0-9]{24}$' }
 *                 customerId: { type: string, pattern: '^[a-fA-F0-9]{24}$' }
 *                 webhookEventId: { type: string, pattern: '^[a-fA-F0-9]{24}$' }
 *                 messageId:
 *                   type: string
 *                   pattern: '^[a-fA-F0-9]{24}$'
 *                   description: Présent seulement quand aucune demande n'est programmée (téléphone invalide, commande test ou annulée) — message tracé en échec.
 *                 jobId:
 *                   type: string
 *                   nullable: true
 *                   example: confirm-initial-6650f0c2a1b2c3d4e5f60718
 *                   description: Identifiant du job différé de demande de confirmation. Absent si sa programmation a échoué.
 *                 notificationQueued:
 *                   type: boolean
 *                   description: Vrai quand la demande de confirmation différée est programmée.
 *                 phoneValid: { type: boolean }
 *                 errorReason: { type: string }
 *       400:
 *         description: Corps brut indisponible ou champs Shopify requis absents.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Signature Shopify absente ou invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500:
 *         description: Secret webhook absent ou erreur interne.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *
 * /api/webhooks/whatsapp:
 *   get:
 *     tags: [WhatsApp Webhooks]
 *     operationId: verifyWhatsAppWebhook
 *     summary: Vérifier le webhook auprès de Meta
 *     parameters:
 *       - { in: query, name: hub.mode, required: true, schema: { type: string, enum: [subscribe] } }
 *       - { in: query, name: hub.verify_token, required: true, schema: { type: string, writeOnly: true } }
 *       - { in: query, name: hub.challenge, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Challenge Meta retourné en texte brut.
 *         content:
 *           text/plain:
 *             schema: { type: string }
 *       403:
 *         description: Mode ou verify token incorrect.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *   post:
 *     tags: [WhatsApp Webhooks]
 *     operationId: receiveWhatsAppWebhook
 *     summary: Recevoir les messages et statuts Meta
 *     description: Acquitte rapidement les clics bouton, messages libres, médias et statuts sent/delivered/read/failed. Les doublons sont ignorés.
 *     parameters:
 *       - in: header
 *         name: X-Hub-Signature-256
 *         required: true
 *         schema: { type: string, pattern: '^sha256=' }
 *         description: Signature hexadécimale du corps brut avec META_WHATSAPP_APP_SECRET.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             description: Payload webhook Meta pouvant contenir messages, boutons interactifs et statuts.
 *     responses:
 *       200:
 *         description: Événements acquittés et traités sans bloquer les retries Meta.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [accepted, inboundEvents, updatedStatusCount, duplicates]
 *               properties:
 *                 accepted: { type: boolean, example: true }
 *                 inboundEvents: { type: integer, minimum: 0 }
 *                 updatedStatusCount: { type: integer, minimum: 0 }
 *                 duplicates: { type: integer, minimum: 0 }
 *       400:
 *         description: Corps brut indisponible.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Signature Meta absente ou invalide.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500:
 *         description: Secret Meta absent ou erreur interne.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
export const webhookDocs = true;
