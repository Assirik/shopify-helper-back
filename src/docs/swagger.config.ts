import swaggerJSDoc from 'swagger-jsdoc';
import path from 'path';
import config from '../utilities/config/env.config';

const serverCandidates = [
  { url: `http://localhost:${config.port}`, description: 'Développement local' },
  ...(config.ngrokEndpoint ? [{ url: config.ngrokEndpoint, description: 'Tunnel ngrok / développement' }] : []),
  ...(config.productionApiEndpoint
    ? [{ url: config.productionApiEndpoint, description: 'Production' }]
    : []),
  ...(config.apiEndpoint !== `http://localhost:${config.port}`
    ? [{ url: config.apiEndpoint, description: 'Endpoint configuré' }]
    : [])
];

const servers = serverCandidates.filter(
  (server, index, all) => all.findIndex(candidate => candidate.url === server.url) === index
);

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$', example: '6650f1d7a7b3c42f842b1234' };
const dateTime = { type: 'string', format: 'date-time', example: '2026-06-20T10:00:00.000Z' };
const docsExtension = path.extname(__filename) === '.ts' ? 'ts' : 'js';

const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Shopify Order Handler API',
      version: '1.0.0',
      description:
        'API MVP d’ingestion des commandes Shopify, de confirmation client WhatsApp/SMS et de gestion helpdesk.'
    },
    servers,
    tags: [
      { name: 'Health', description: 'État du service' },
      { name: 'Auth', description: 'Authentification du helpdesk' },
      { name: 'Customers', description: 'Consultation des clients Shopify' },
      { name: 'Orders', description: 'Consultation et confirmation des commandes' },
      { name: 'Messages', description: 'Suivi et relance des messages' },
      { name: 'Shopify Webhooks', description: 'Ingestion signée des commandes Shopify' },
      { name: 'WhatsApp Webhooks', description: 'Vérification et événements entrants Meta' },
      { name: 'WhatsApp Templates', description: 'Catalogue des templates Meta' },
      { name: 'Message Config', description: 'Variables régionales des messages' }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT retourné par POST /api/auth/login.'
        }
      },
      responses: {
        Unauthorized: {
          description: 'JWT absent ou invalide.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } }
        },
        Forbidden: {
          description: 'Droits insuffisants.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } }
        },
        InternalError: {
          description: 'Erreur interne.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } }
        }
      },
      schemas: {
        ApiError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', example: 'OrderNotFound' },
            message: { type: 'string' },
            status: { type: 'string' }
          }
        },
        ValidationError: {
          allOf: [
            { $ref: '#/components/schemas/ApiError' },
            {
              type: 'object',
              properties: {
                details: { type: 'object', additionalProperties: { type: 'string' } }
              }
            }
          ]
        },
        Pagination: {
          type: 'object',
          required: ['page', 'limit', 'total', 'pages'],
          properties: {
            page: { type: 'integer', minimum: 1, example: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, example: 20 },
            total: { type: 'integer', minimum: 0, example: 42 },
            pages: { type: 'integer', minimum: 0, example: 3 }
          }
        },
        User: {
          type: 'object',
          required: ['_id', 'userName', 'email', 'role'],
          properties: {
            _id: objectId,
            userName: { type: 'string', example: 'helpdesk.agent' },
            email: { type: 'string', format: 'email', example: 'agent@example.com' },
            phone: { type: 'string', example: '+221770000000' },
            role: { type: 'string', enum: ['ADMIN', 'USER', 'IOT', 'DEVELOPER', 'DEVICE'] },
            fcmTokens: { type: 'array', items: { type: 'string' } },
            createdAt: dateTime,
            updatedAt: dateTime
          }
        },
        Customer: {
          type: 'object',
          required: ['_id', 'orderCount'],
          properties: {
            _id: objectId,
            shopifyCustomerId: { type: 'string' },
            shopifyCustomerGraphqlId: { type: 'string' },
            fullName: { type: 'string', example: 'Awa Ndiaye' },
            firstName: { type: 'string', example: 'Awa' },
            lastName: { type: 'string', example: 'Ndiaye' },
            phoneRaw: { type: 'string' },
            phoneE164: { type: 'string', example: '+221770000000' },
            email: { type: 'string', format: 'email' },
            address1: { type: 'string' },
            address2: { type: 'string' },
            city: { type: 'string' },
            region: { type: 'string', example: 'Dakar' },
            country: { type: 'string', example: 'Sénégal' },
            countryCode: { type: 'string', example: 'SN' },
            orderCount: { type: 'integer', minimum: 0 },
            lastOrderId: objectId,
            lastOrderName: { type: 'string', example: '#1001' },
            lastOrderAt: dateTime,
            createdAt: dateTime,
            updatedAt: dateTime
          }
        },
        OrderLineItem: {
          type: 'object',
          required: ['quantity'],
          properties: {
            shopifyLineItemId: { type: 'string' },
            productId: { type: 'string' },
            variantId: { type: 'string' },
            title: { type: 'string', example: 'Produit exemple' },
            name: { type: 'string' },
            quantity: { type: 'integer', minimum: 0, example: 1 },
            price: { type: 'string', example: '12000' },
            sku: { type: 'string', example: 'SKU-001' },
            vendor: { type: 'string' },
            productExists: { type: 'boolean' },
            variantInventoryManagement: { type: 'string' },
            variantTitle: { type: 'string' },
            fulfillmentStatus: { type: 'string', nullable: true }
          }
        },
        Order: {
          type: 'object',
          required: [
            '_id',
            'shopifyOrderId',
            'shopifyOrderName',
            'lineItems',
            'totalPrice',
            'currency',
            'notificationStatus',
            'customerConfirmationStatus'
          ],
          properties: {
            _id: objectId,
            shopifyOrderId: { type: 'string', example: '1000000001' },
            shopifyOrderName: { type: 'string', example: '#1001' },
            customerId: objectId,
            customerName: { type: 'string', example: 'Awa Ndiaye' },
            customerPhoneRaw: { type: 'string' },
            customerPhoneE164: { type: 'string', example: '+221770000000' },
            customerEmail: { type: 'string', format: 'email' },
            lineItems: { type: 'array', items: { $ref: '#/components/schemas/OrderLineItem' } },
            totalPrice: { type: 'string', example: '14000' },
            subtotalPrice: { type: 'string' },
            currentTotalPrice: { type: 'string' },
            totalOutstanding: { type: 'string' },
            totalDiscounts: { type: 'string' },
            shippingPrice: { type: 'string' },
            shippingTitle: { type: 'string' },
            shippingRegion: { type: 'string' },
            deliveryRegion: { type: 'string', example: 'Ziguinchor' },
            deliveryRegionCode: {
              type: 'string',
              enum: ['SN_DK', 'SN_DB', 'SN_FK', 'SN_KA', 'SN_KL', 'SN_KE', 'SN_KD', 'SN_LG', 'SN_MT', 'SN_SL', 'SN_SE', 'SN_TC', 'SN_TH', 'SN_ZG']
            },
            deliveryPreferredMoment: {
              type: 'string',
              example: 'Après Midi',
              description: 'Valeur Easysell stockée à titre informatif, sans scheduling.'
            },
            deliveryAddress: { type: 'string', example: 'Point de livraison convenu' },
            deliveryLatitude: { type: 'number', format: 'double' },
            deliveryLongitude: { type: 'number', format: 'double' },
            browserIp: { type: 'string', description: 'Adresse IP fournie par Shopify/Easysell.' },
            customerLocale: { type: 'string', example: 'fr-SN' },
            currency: { type: 'string', example: 'XOF' },
            paymentGatewayNames: { type: 'array', items: { type: 'string' } },
            isCashOnDelivery: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
            sourceName: { type: 'string' },
            orderStatusUrl: { type: 'string', format: 'uri' },
            noteAttributes: { type: 'object', additionalProperties: { type: 'string' } },
            isTest: { type: 'boolean' },
            shopifyCancelledAt: dateTime,
            shopifyCancelReason: { type: 'string' },
            financialStatus: { type: 'string' },
            fulfillmentStatus: { type: 'string', nullable: true },
            notificationStatus: { type: 'string', enum: ['pending', 'sent', 'failed', 'skipped', 'partially_sent'] },
            customerConfirmationStatus: { type: 'string', enum: ['pending', 'confirmed', 'needs_attention', 'expired', 'cancelled', 'sms_only'] },
            confirmationSource: { type: 'string', enum: ['whatsapp_button', 'admin'] },
            confirmedAt: dateTime,
            confirmationCancelledAt: dateTime,
            expiredAt: dateTime,
            confirmationCancelReason: { type: 'string' },
            lastCustomerMessageAt: dateTime,
            lastCustomerMessageText: { type: 'string' },
            reminderCount: { type: 'integer', minimum: 0 },
            lastReminderAt: dateTime,
            lastReminderSource: { type: 'string', enum: ['admin', 'auto'] },
            confirmationPayload: { type: 'object', additionalProperties: true },
            attentionReason: { type: 'string' },
            needsHelpdeskAttention: { type: 'boolean' },
            createdAt: dateTime,
            updatedAt: dateTime
          }
        },
        MessageAttempt: {
          type: 'object',
          required: ['status', 'at'],
          properties: {
            attemptNumber: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['sent', 'failed'] },
            providerMessageId: { type: 'string' },
            providerResponse: { type: 'object', additionalProperties: true },
            errorCode: { type: 'string' },
            errorMessage: { type: 'string' },
            at: dateTime
          }
        },
        Message: {
          type: 'object',
          required: ['_id', 'orderId', 'channel', 'provider', 'status', 'attemptCount'],
          properties: {
            _id: objectId,
            orderId: objectId,
            channel: { type: 'string', enum: ['whatsapp', 'sms'] },
            provider: { type: 'string', enum: ['meta', 'termii'] },
            status: { type: 'string', enum: ['queued', 'sending', 'sent', 'delivered', 'read', 'failed'] },
            templateName: { type: 'string' },
            templateLanguage: { type: 'string', example: 'fr' },
            templatePurpose: { type: 'string', enum: ['order_confirmation_request', 'order_confirmed', 'order_cancelled', 'reminder', 'sms_fallback'] },
            buttonPayload: { type: 'string', example: 'CONFIRM_ORDER:6650f1d7a7b3c42f842b1234' },
            attemptCount: { type: 'integer', minimum: 0 },
            providerMessageId: { type: 'string' },
            providerResponse: { type: 'object', additionalProperties: true },
            errorCode: { type: 'string' },
            errorMessage: { type: 'string' },
            attempts: { type: 'array', items: { $ref: '#/components/schemas/MessageAttempt' } },
            fallbackOfMessageId: objectId,
            createdAt: dateTime,
            updatedAt: dateTime
          }
        },
        WebhookEvent: {
          type: 'object',
          properties: {
            _id: objectId,
            webhookId: { type: 'string' },
            topic: { type: 'string', example: 'orders/create' },
            shopDomain: { type: 'string', example: 'example-shop.myshopify.com' },
            payloadHash: { type: 'string' },
            status: { type: 'string', enum: ['received', 'processed', 'duplicate', 'failed'] },
            orderId: objectId,
            errorMessage: { type: 'string' },
            createdAt: dateTime,
            updatedAt: dateTime
          }
        },
        InboundWhatsAppEvent: {
          type: 'object',
          properties: {
            _id: objectId,
            messageId: objectId,
            waMessageId: { type: 'string' },
            from: { type: 'string' },
            type: { type: 'string' },
            text: { type: 'string' },
            buttonPayload: { type: 'string' },
            buttonText: { type: 'string' },
            orderId: objectId,
            rawPayload: { type: 'object', additionalProperties: true },
            processedStatus: { type: 'string', enum: ['processed', 'ignored', 'needs_attention', 'failed'] },
            createdAt: dateTime,
            updatedAt: dateTime
          }
        },
        RegionVariant: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dakar: { type: 'string', nullable: true },
            nonDakar: { type: 'string', nullable: true }
          }
        },
        MessageVariableConfig: {
          type: 'object',
          properties: {
            _id: objectId,
            key: { type: 'string', enum: ['global'] },
            shippingNote: { $ref: '#/components/schemas/RegionVariant' },
            paymentMethod: { $ref: '#/components/schemas/RegionVariant' },
            updatedBy: objectId,
            createdAt: dateTime,
            updatedAt: dateTime
          }
        },
        QueueJob: {
          type: 'object',
          properties: {
            jobId: { type: 'string', nullable: true },
            queueName: { type: 'string', example: 'notifications' }
          }
        },
        MessageJobResponse: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              allOf: [
                { $ref: '#/components/schemas/QueueJob' },
                { type: 'object', properties: { message: { $ref: '#/components/schemas/Message' } } }
              ]
            }
          }
        },
        OrderJobResponse: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              allOf: [
                { $ref: '#/components/schemas/QueueJob' },
                {
                  type: 'object',
                  properties: {
                    order: { $ref: '#/components/schemas/Order' },
                    message: { $ref: '#/components/schemas/Message', nullable: true }
                  }
                }
              ]
            }
          }
        }
      }
    }
  },
  apis: [path.join(__dirname, 'routes', `*.docs.${docsExtension}`)]
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
