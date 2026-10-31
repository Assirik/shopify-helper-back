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

export const DEFAULT_FX_XOF_EUR = 655.957;

// META_CAPI_ENABLED: 'true' / 'false' (case and surrounding spaces ignored); absent or blank = off.
// Any other value is flagged `enabledInvalid` (sending stays off) and refused at startup by checkCapiStartup.
const parseCapiEnabled = (value?: string): { enabled: boolean; enabledInvalid: boolean } => {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === '' || normalized === 'false') return { enabled: false, enabledInvalid: false };
  if (normalized === 'true') return { enabled: true, enabledInvalid: false };
  return { enabled: false, enabledInvalid: true };
};

export const buildMetaCapiConfig = (env: NodeJS.ProcessEnv) => {
  const fx = Number(env.META_CAPI_FX_XOF_EUR);
  return {
    ...parseCapiEnabled(env.META_CAPI_ENABLED),
    datasetId: (env.META_CAPI_DATASET_ID || '').trim(),
    accessToken: (env.META_CAPI_ACCESS_TOKEN || '').trim(),
    graphApiVersion: (env.META_CAPI_GRAPH_API_VERSION || '').trim() || 'v26.0',
    fxXofEur: Number.isFinite(fx) && fx > 0 ? fx : DEFAULT_FX_XOF_EUR,
    testEventCode: (env.META_CAPI_TEST_EVENT_CODE || '').trim()
  };
};

// Origins (shop storefront domains) allowed to post browser signals to POST /api/session.
// Empty list => the route rejects every request.
export const parseSessionCaptureOrigins = (value?: string) =>
  (value || '')
    .split(',')
    .map(origin => origin.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(origin => origin.length > 0);

// Delay before the first WhatsApp confirmation request (C5.6a): the customer often confirms
// within a minute through the pre-filled EasySell message. Never shorter than 5 minutes.
export const MIN_INITIAL_CONFIRMATION_REQUEST_DELAY_MINUTES = 5;

export const parseInitialConfirmationRequestDelayMinutes = (value?: string) => {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > MIN_INITIAL_CONFIRMATION_REQUEST_DELAY_MINUTES
    ? minutes
    : MIN_INITIAL_CONFIRMATION_REQUEST_DELAY_MINUTES;
};

// Expected pre-filled WhatsApp confirmation text (C5.17), identical to the EasySell message
// with its EasySell variables. Template and message are compared in lower case, NFC, edge
// spaces and invisible characters removed; the fixed text is compared as is. Required
// {{order.number}}: `1234`, `#1234` or `##1234`. Any other variable: 1 to 100 characters on
// a single line. Message over 500 characters: no match. Absent: this default. Invalid (empty,
// without {{order.number}}, fixed text under 5 letters, adjacent variables): logged at
// startup and the confirmation by message is disabled.
export const DEFAULT_PREFILLED_CONFIRMATION_TEMPLATE = 'Je confirme ma commande #{{order.number}}';

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
    graphApiVersion: process.env.META_WHATSAPP_GRAPH_API_VERSION || 'v26.0'
  },
  metaCapi: buildMetaCapiConfig(process.env),
  sessionCapture: {
    allowedOrigins: parseSessionCaptureOrigins(process.env.SESSION_CAPTURE_ALLOWED_ORIGINS)
  },
  chatwoot: {
    // Base URL of the self-hosted Chatwoot instance. Leave empty to disable forwarding.
    url: (process.env.CHATWOOT_URL || '').replace(/\/+$/, ''),
    // E.164 phone number of the Chatwoot WhatsApp inbox (route param of
    // /webhooks/whatsapp/:phone_number) — the phone NUMBER, not the phone_number_id.
    whatsappPhoneNumber: process.env.CHATWOOT_WHATSAPP_PHONE_NUMBER || '',
    // Secret used to sign the forwarded payload (X-Hub-Signature-256). Chatwoot
    // verifies against the app secret configured on its WhatsApp channel, which is
    // the same Meta app secret unless overridden here.
    metaAppSecret: process.env.CHATWOOT_META_APP_SECRET || process.env.META_WHATSAPP_APP_SECRET || '',
    // Chatwoot REST API credentials for the outbound template mirror. Leave the
    // token empty to disable the mirror (the inbound forward above still works).
    apiAccessToken: process.env.CHATWOOT_API_ACCESS_TOKEN || '',
    accountId: process.env.CHATWOOT_ACCOUNT_ID || '1',
    inboxId: process.env.CHATWOOT_INBOX_ID || ''
  },
  termii: {
    apiKey: process.env.TERMII_API_KEY || '',
    senderId: process.env.TERMII_SENDER_ID || '',
    baseUrl: process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'
  },
  confirmation: {
    initialRequestDelayMinutes: parseInitialConfirmationRequestDelayMinutes(
      process.env.CONFIRMATION_INITIAL_REQUEST_DELAY_MINUTES
    ),
    firstReminderHours: Number(process.env.CONFIRMATION_FIRST_REMINDER_HOURS) || 24,
    secondReminderHours: Number(process.env.CONFIRMATION_SECOND_REMINDER_HOURS) || 48,
    expireHours: Number(process.env.CONFIRMATION_EXPIRE_HOURS) || 72,
    maxReminders: Number(process.env.CONFIRMATION_MAX_REMINDERS) || 2,
    reminderCooldownMinutes: Number(process.env.CONFIRMATION_REMINDER_COOLDOWN_MINUTES) || 60,
    sweepIntervalMinutes: Number(process.env.CONFIRMATION_SWEEP_INTERVAL_MINUTES) || 30,
    prefilledTemplate: process.env.PREFILLED_CONFIRMATION_TEMPLATE ?? DEFAULT_PREFILLED_CONFIRMATION_TEMPLATE
  },
  delivery: {
    defaultFee: Number(process.env.DELIVERY_DEFAULT_FEE) || 0,
    defaultCarrierFee: Number(process.env.DELIVERY_DEFAULT_CARRIER_FEE) || 2000
  }
};
