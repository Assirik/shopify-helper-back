import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const port = Number(process.env.PORT) || 3600;
const apiEndpoint = process.env.API_ENDPOINT || `http://localhost:${port}`;
const ngrokEndpoint = process.env.NGROK_ENDPOINT || '';
const productionApiEndpoint = process.env.PRODUCTION_API_ENDPOINT || '';
const allowedOrigins =
  !process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS.trim() === '*'
    ? '*'
    : process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim());
const jwtSecret = process.env.JWT_SECRET || 'change-me-in-env';
const initialAdminBootstrapSecret = process.env.INITIAL_ADMIN_BOOTSTRAP_SECRET || '';

export default {
  port,
  apiEndpoint,
  ngrokEndpoint,
  productionApiEndpoint,
  environment: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/starter-kit',
  mongodbDbName: process.env.MONGODB_DB_NAME || 'starter-kit',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  allowedOrigins,
  jwtSecret,
  initialAdminBootstrapSecret,
  shopify: {
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || ''
  },
  metaWhatsApp: {
    accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || '',
    appSecret: process.env.META_WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '',
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    templateName: process.env.META_WHATSAPP_TEMPLATE_NAME || '',
    confirmedTemplateName: process.env.META_WHATSAPP_CONFIRMED_TEMPLATE_NAME || 'order_confirmed',
    cancelledTemplateName: process.env.META_WHATSAPP_CANCELLED_TEMPLATE_NAME || '',
    webhookVerifyToken: process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
    templateLanguage:
      process.env.META_WHATSAPP_TEMPLATE_LANGUAGE || process.env.META_WHATSAPP_TEMPLATE_LANGUAGE_CODE || 'fr',
    graphApiVersion: process.env.META_WHATSAPP_GRAPH_API_VERSION || 'v20.0'
  },
  termii: {
    apiKey: process.env.TERMII_API_KEY || '',
    senderId: process.env.TERMII_SENDER_ID || '',
    baseUrl: process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'
  },
  confirmation: {
    firstReminderHours: Number(process.env.CONFIRMATION_FIRST_REMINDER_HOURS) || 24,
    secondReminderHours: Number(process.env.CONFIRMATION_SECOND_REMINDER_HOURS) || 48,
    expireHours: Number(process.env.CONFIRMATION_EXPIRE_HOURS) || 72,
    maxReminders: Number(process.env.CONFIRMATION_MAX_REMINDERS) || 2,
    reminderCooldownMinutes: Number(process.env.CONFIRMATION_REMINDER_COOLDOWN_MINUTES) || 60,
    sweepIntervalMinutes: Number(process.env.CONFIRMATION_SWEEP_INTERVAL_MINUTES) || 30
  },
  delivery: {
    defaultFee: Number(process.env.DELIVERY_DEFAULT_FEE) || 0
  }
};
