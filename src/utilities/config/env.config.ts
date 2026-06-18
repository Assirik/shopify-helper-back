import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const port = Number(process.env.PORT) || 3600;
const apiEndpoint = process.env.API_ENDPOINT || `http://localhost:${port}`;
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : '*';
const jwtSecret = process.env.JWT_SECRET || 'change-me-in-env';

export default {
  port,
  apiEndpoint,
  environment: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/starter-kit',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  allowedOrigins,
  jwtSecret,
  shopify: {
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || ''
  },
  metaWhatsApp: {
    accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || '',
    templateName: process.env.META_WHATSAPP_TEMPLATE_NAME || '',
    templateLanguage:
      process.env.META_WHATSAPP_TEMPLATE_LANGUAGE || process.env.META_WHATSAPP_TEMPLATE_LANGUAGE_CODE || 'fr',
    graphApiVersion: process.env.META_WHATSAPP_GRAPH_API_VERSION || 'v20.0'
  },
  termii: {
    apiKey: process.env.TERMII_API_KEY || '',
    senderId: process.env.TERMII_SENDER_ID || '',
    baseUrl: process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'
  }
};
