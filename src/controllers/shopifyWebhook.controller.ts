import crypto from 'crypto';
import { Request, Response } from 'express';
import config from '../utilities/config/env.config';
import { PhoneNormalizationService } from '../utilities/services/phoneNormalization.service';
import { Customer } from '../models/Customer';
import { Message, MessageChannel, MessageProvider, MessageStatus, TemplatePurpose } from '../models/Message';
import { AttentionReasonCode, CustomerConfirmationStatus, NotificationStatus, Order } from '../models/Order';
import { BrowserSession } from '../models/BrowserSession';
import { Product } from '../models/Product';
import { WebhookEvent, WebhookEventStatus } from '../models/WebhookEvent';
import { scheduleInitialConfirmationRequest } from '../queues/notification.queue';
import { QUEUE_ADD_TIMEOUT_MS, TimeoutError, withTimeout } from '../queues/queueTimeout';
import { resolveRegion } from '../utilities/reference/senegalRegions';
import log from '../utilities/logger/logger';
import { splitFullName } from '../utilities/services/nameParser';
import { parseAdAttribution } from '../utilities/services/adAttribution';

/**
 * Types locaux pour les champs Shopify utilisés par le MVP.
 *
 * On ne modélise pas tout le payload Shopify ici: seulement les champs qui
 * alimentent les commandes, les clients, les produits, les logs et la décision
 * d'envoyer ou non une notification.
 */
interface ShopifyAddressPayload {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  country_code?: string | null;
  phone?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
}

interface ShopifyCustomerPayload {
  id?: number | string;
  admin_graphql_api_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  default_address?: ShopifyAddressPayload | null;
}

interface ShopifyNoteAttributePayload {
  name?: string | null;
  value?: string | null;
}

interface ShopifyLineItemPayload {
  id?: number | string;
  product_id?: number | string | null;
  variant_id?: number | string | null;
  title?: string | null;
  name?: string | null;
  quantity?: number;
  price?: string | null;
  sku?: string | null;
  vendor?: string | null;
  product_exists?: boolean;
  variant_title?: string | null;
  variant_inventory_management?: string | null;
  fulfillment_status?: string | null;
}

interface ShopifyShippingLinePayload {
  title?: string | null;
  price?: string | null;
}

interface ShopifyOrderPayload {
  id?: number | string;
  name?: string;
  created_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  customer?: ShopifyCustomerPayload | null;
  contact_email?: string | null;
  email?: string | null;
  phone?: string | null;
  shipping_address?: ShopifyAddressPayload | null;
  billing_address?: ShopifyAddressPayload | null;
  note_attributes?: ShopifyNoteAttributePayload[];
  line_items?: ShopifyLineItemPayload[];
  shipping_lines?: ShopifyShippingLinePayload[];
  total_price?: string;
  subtotal_price?: string;
  current_total_price?: string;
  total_outstanding?: string;
  total_discounts?: string;
  total_shipping_price_set?: {
    shop_money?: {
      amount?: string | null;
    };
  } | null;
  currency?: string;
  payment_gateway_names?: string[];
  tags?: string | null;
  source_name?: string | null;
  order_status_url?: string | null;
  test?: boolean;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  browser_ip?: string | null;
  customer_locale?: string | null;
}

interface ShopifyWebhookBody {
  payload?: ShopifyOrderPayload;
}

// Retourne la première chaîne exploitable dans une liste de valeurs candidates.
// Shopify/Easysell dupliquent souvent les mêmes infos dans plusieurs endroits.
const getFirstString = (...values: Array<string | null | undefined>) => {
  return values.find(value => typeof value === 'string' && value.trim().length > 0)?.trim();
};

// Easysell met parfois "-" comme nom de famille. On le traite comme une valeur
// vide pour éviter d'enregistrer des clients avec des noms du type "Moussa -".
const isUsefulNamePart = (value?: string | null): value is string => {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() !== '-';
};

// Construit le nom depuis le bloc customer Shopify quand il est suffisamment propre.
const buildCustomerName = (customer?: ShopifyCustomerPayload | null) => {
  return [customer?.first_name, customer?.last_name]
    .filter(isUsefulNamePart)
    .map(value => value.trim())
    .join(' ');
};

// Lit une note Shopify/Easysell par nom. Les formulaires Easysell stockent des
// champs critiques dans note_attributes: "Nom complet", "Téléphone", "Adresse", etc.
const getNoteAttribute = (payload: ShopifyOrderPayload, ...names: string[]) => {
  const normalizedNames = names.map(name => name.toLowerCase());
  return payload.note_attributes?.find(attribute => {
    return typeof attribute.name === 'string' && normalizedNames.includes(attribute.name.toLowerCase());
  })?.value;
};

// Shopify envoie normalement l'objet commande directement. Nos fichiers de test
// locaux peuvent aussi être enveloppés dans { payload: ... }, donc on supporte les deux.
const getShopifyPayload = (body: ShopifyOrderPayload | ShopifyWebhookBody): ShopifyOrderPayload => {
  return 'payload' in body && body.payload ? body.payload : (body as ShopifyOrderPayload);
};

// Priorité du nom client: customer, adresse de livraison/facturation, puis notes Easysell.
const getCustomerName = (payload: ShopifyOrderPayload) => {
  return getFirstString(
    buildCustomerName(payload.customer),
    payload.shipping_address?.name,
    payload.billing_address?.name,
    payload.customer?.default_address?.name,
    getNoteAttribute(payload, 'Nom complet', 'Full name', 'name')
  );
};

// Priorité du téléphone: adresses, customer, order.phone, puis note_attributes Easysell.
const getCustomerPhone = (payload: ShopifyOrderPayload) => {
  return getFirstString(
    payload.shipping_address?.phone,
    payload.billing_address?.phone,
    payload.customer?.phone,
    payload.customer?.default_address?.phone,
    payload.phone,
    getNoteAttribute(payload, 'Téléphone', 'Telephone', 'Phone')
  );
};

// Email moins fiable sur les commandes COD Easysell, mais utile quand Shopify le fournit.
const getCustomerEmail = (payload: ShopifyOrderPayload) => {
  return getFirstString(payload.customer?.email, payload.email, payload.contact_email);
};

// Adresse prioritaire pour la livraison, avec fallback Easysell lorsque Shopify
// ne remplit pas toute l'adresse standard.
const getCustomerAddress = (payload: ShopifyOrderPayload) => {
  const address = payload.shipping_address || payload.billing_address || payload.customer?.default_address;

  return {
    address1: getFirstString(address?.address1, getNoteAttribute(payload, 'Adresse', 'Address')),
    address2: getFirstString(address?.address2),
    city: getFirstString(address?.city, getNoteAttribute(payload, 'Région', 'Region')),
    region: getFirstString(address?.province, getNoteAttribute(payload, 'Région', 'Region')),
    country: getFirstString(address?.country),
    countryCode: getFirstString(address?.country_code, getNoteAttribute(payload, 'country'))
  };
};

const toFiniteNumber = (value?: number | string | null) => {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Comparaison tolérante aux accents/casse/tirets: on stocke toujours la valeur
// Easysell telle quelle, mais on ne loggue un avertissement que si elle ne
// correspond à aucun créneau connu, même écrit légèrement différemment
// (ex. "Après-midi" vs "Après Midi").
export const normalizeDeliveryMoment = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const KNOWN_DELIVERY_MOMENTS = new Set(
  ['Toute la journée', 'Matinée', 'Après Midi', 'Soir (avant 20h)'].map(normalizeDeliveryMoment)
);

export const extractDeliverySnapshot = (payload: ShopifyOrderPayload) => {
  const rawRegion = getFirstString(
    payload.shipping_address?.province,
    getNoteAttribute(payload, 'Région', 'Region'),
    payload.shipping_address?.city
  );
  const canonicalRegion = resolveRegion(rawRegion);

  return {
    deliveryRegion: canonicalRegion?.label || rawRegion,
    deliveryRegionCode: canonicalRegion?.code,
    deliveryPreferredMoment: getFirstString(
      getNoteAttribute(payload, 'Moment de livraison préféré')
    ),
    deliveryAddress: getFirstString(
      payload.shipping_address?.address2,
      getNoteAttribute(payload, 'Adresse de livraison'),
      payload.shipping_address?.address1,
      getNoteAttribute(payload, 'Adresse', 'Address')
    ),
    deliveryLatitude: toFiniteNumber(payload.shipping_address?.latitude),
    deliveryLongitude: toFiniteNumber(payload.shipping_address?.longitude),
    browserIp: getFirstString(payload.browser_ip, getNoteAttribute(payload, 'IP Address')),
    customerLocale: getFirstString(payload.customer_locale)
  };
};

// Shopify stocke tags comme une chaîne "tag1, tag2"; on normalise en tableau
// pour les filtres dashboard et les règles métier futures.
const getTags = (payload: ShopifyOrderPayload) => {
  return (payload.tags || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0);
};

// Conserve les note_attributes dans un format clé/valeur simple.
// Cela évite de perdre les champs Easysell non encore modélisés explicitement.
const getNoteAttributesMap = (payload: ShopifyOrderPayload) => {
  return (payload.note_attributes || []).reduce<Record<string, string>>((acc, attribute) => {
    if (attribute.name && typeof attribute.value === 'string') {
      acc[attribute.name] = attribute.value;
    }

    return acc;
  }, {});
};

// Normalise les lignes produits de Shopify vers une structure stable pour Order.
// Le modèle Product est aussi alimenté depuis cette représentation.
const getLineItems = (payload: ShopifyOrderPayload) => {
  return (payload.line_items || []).map(lineItem => ({
    shopifyLineItemId: lineItem.id?.toString(),
    productId: lineItem.product_id?.toString(),
    variantId: lineItem.variant_id?.toString(),
    title: lineItem.title || undefined,
    name: lineItem.name || undefined,
    quantity: lineItem.quantity || 0,
    price: lineItem.price || undefined,
    sku: lineItem.sku || undefined,
    vendor: lineItem.vendor || undefined,
    productExists: lineItem.product_exists,
    variantInventoryManagement: lineItem.variant_inventory_management || undefined,
    variantTitle: lineItem.variant_title || undefined,
    fulfillmentStatus: lineItem.fulfillment_status || undefined
  }));
};

// Pour le MVP on prend la première ligne de livraison. Les payloads observés
// Easysell n'en contiennent qu'une seule.
const getShippingLine = (payload: ShopifyOrderPayload) => {
  return payload.shipping_lines?.[0];
};

// Détection simple du paiement à la livraison. Cette info sera importante pour
// les messages WhatsApp/SMS et le futur dashboard opérationnel.
const isCashOnDelivery = (payload: ShopifyOrderPayload) => {
  return (payload.payment_gateway_names || []).some(gateway => gateway.toLowerCase().includes('cash on delivery'));
};

// Les commandes test, annulées ou voided sont persistées pour audit, mais ne
// doivent pas déclencher de notification client.
const shouldSkipNotification = (payload: ShopifyOrderPayload) => {
  if (payload.test) {
    return 'Shopify test order';
  }

  if (payload.cancelled_at) {
    return 'Shopify order is cancelled';
  }

  if (payload.financial_status === 'voided') {
    return 'Shopify order financial status is voided';
  }

  return null;
};

// Hash stable du payload brut. Sert à tracer/auditer les webhooks sans logger
// tout le body Shopify, qui peut contenir des données personnelles et des URLs sensibles.
const getPayloadHash = (req: Request) => {
  const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
  return crypto.createHash('sha256').update(body).digest('hex');
};

// Browser signals (POST /api/session) are linked to the order when the capture happened
// between 30 min before and 5 min after the order creation (clock skew tolerance).
export const BROWSER_SESSION_LINK_WINDOW_BEFORE_MS = 30 * 60 * 1000;
export const BROWSER_SESSION_LINK_WINDOW_AFTER_MS = 5 * 60 * 1000;
// The lookup must never hold the ingestion: server-side limit on the query, plus an overall
// deadline in case the driver itself hangs (pool exhausted, network stall).
export const BROWSER_SESSION_QUERY_MAX_TIME_MS = 1000;
export const BROWSER_SESSION_LOOKUP_TIMEOUT_MS = 1500;

export interface BrowserSessionCapiFields {
  capiFbp?: string;
  capiFbc?: string;
  capiClientUserAgent?: string;
  capiEventSourceUrl?: string;
  // Session fallback for Order.fbclid (the order's full_url takes precedence).
  fbclid?: string;
}

export const NOTIFICATION_NOT_SCHEDULED_ATTENTION_REASON = 'Demande de confirmation non programmée';

// C5.15: the delayed initial request could not be scheduled (Redis error or no answer within
// QUEUE_ADD_TIMEOUT_MS), so a helpdesk agent takes over. Conditional writes: the send status
// only leaves PENDING (FAILED while the order awaits confirmation, SKIPPED once it no longer
// does, as the delayed job would), and an attention reason already set (e.g. `invalid_number`
// at ingestion, a WhatsApp message received meanwhile) or an order no longer pending is never
// overwritten. Returns true when the attention reason was set.
export const flagUnscheduledConfirmationRequest = async (orderId: string) => {
  await Order.updateOne(
    {
      _id: orderId,
      notificationStatus: NotificationStatus.PENDING,
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING
    },
    { $set: { notificationStatus: NotificationStatus.FAILED } }
  );
  await Order.updateOne(
    {
      _id: orderId,
      notificationStatus: NotificationStatus.PENDING,
      customerConfirmationStatus: { $ne: CustomerConfirmationStatus.PENDING }
    },
    { $set: { notificationStatus: NotificationStatus.SKIPPED } }
  );

  const result = await Order.updateOne(
    {
      _id: orderId,
      needsHelpdeskAttention: { $ne: true },
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING
    },
    {
      $set: {
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.NOTIFICATION_NOT_SCHEDULED,
        attentionReason: NOTIFICATION_NOT_SCHEDULED_ATTENTION_REASON,
        attentionRequiredAt: new Date()
      }
    }
  );

  return result.modifiedCount > 0;
};

const getOrderCreatedAt = (payload: ShopifyOrderPayload) => {
  const createdAt = payload.created_at ? new Date(payload.created_at) : new Date();
  return Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
};

// Latest capture for the same phone (one record per phone), kept only inside the window.
export const findBrowserSessionCapiFields = async (
  phoneE164: string | undefined,
  orderCreatedAt: Date
): Promise<{ linked: boolean; fields: BrowserSessionCapiFields }> => {
  if (!phoneE164) {
    return { linked: false, fields: {} };
  }

  const session = await BrowserSession.findOne({ phoneE164 }).maxTimeMS(BROWSER_SESSION_QUERY_MAX_TIME_MS).lean();

  if (!session?.updatedAt) {
    return { linked: false, fields: {} };
  }

  const capturedAt = new Date(session.updatedAt).getTime();
  const createdAt = orderCreatedAt.getTime();

  if (
    capturedAt < createdAt - BROWSER_SESSION_LINK_WINDOW_BEFORE_MS ||
    capturedAt > createdAt + BROWSER_SESSION_LINK_WINDOW_AFTER_MS
  ) {
    return { linked: false, fields: {} };
  }

  const fields: BrowserSessionCapiFields = {
    ...(session.fbp ? { capiFbp: session.fbp } : {}),
    ...(session.fbc ? { capiFbc: session.fbc } : {}),
    ...(session.userAgent ? { capiClientUserAgent: session.userAgent } : {}),
    ...(session.pageUrl ? { capiEventSourceUrl: session.pageUrl } : {}),
    ...(session.fbclid ? { fbclid: session.fbclid } : {})
  };

  return { linked: Object.keys(fields).length > 0, fields };
};

// Prépare le catalogue produit futur à partir des commandes reçues.
// Ce n'est pas encore une gestion de stock: on garde seulement la dernière vue
// connue du produit/variant et un compteur total commandé.
const upsertProductsFromLineItems = async (
  lineItems: ReturnType<typeof getLineItems>,
  orderId: string,
  orderName: string
) => {
  const upsertedProducts = [];

  for (const lineItem of lineItems) {
    // Les frais/options non liés à un vrai produit peuvent ne pas avoir product_id.
    // On les garde dans Order.lineItems mais on ne crée pas de Product pour eux.
    if (!lineItem.productId) {
      continue;
    }

    // Upsert par product_id Shopify pour construire progressivement le catalogue.
    const product = await Product.findOneAndUpdate(
      { shopifyProductId: lineItem.productId },
      {
        $set: {
          shopifyProductId: lineItem.productId,
          title: lineItem.title || lineItem.name || 'Untitled Shopify product',
          vendor: lineItem.vendor,
          productExists: lineItem.productExists ?? true,
          lastOrderId: orderId,
          lastOrderName: orderName,
          lastSeenAt: new Date()
        },
        $inc: {
          totalOrderedQuantity: lineItem.quantity
        }
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    // Les variantes sont embarquées dans Product pour préparer le futur stock par SKU/variant.
    if (lineItem.variantId) {
      const existingVariantIndex = product.variants.findIndex(variant => variant.shopifyVariantId === lineItem.variantId);
      const variantData = {
        shopifyVariantId: lineItem.variantId,
        title: lineItem.variantTitle,
        sku: lineItem.sku,
        lastKnownPrice: lineItem.price,
        inventoryManagement: lineItem.variantInventoryManagement,
        lastSeenAt: new Date()
      };

      // On remplace la variante si elle existe déjà, sinon on l'ajoute.
      if (existingVariantIndex >= 0) {
        product.variants[existingVariantIndex] = variantData;
      } else {
        product.variants.push(variantData);
      }

      await product.save();
    }

    upsertedProducts.push(product);
  }

  return upsertedProducts;
};

export class ShopifyWebhookController {
  public static async ordersCreate(req: Request, res: Response) {
    // 1. Normalisation minimale du contexte webhook.
    // A ce stade la signature HMAC a déjà été vérifiée par verifyShopifyWebhook.
    // log.info('------------------------------------------------------');
    // log.info({ body: req.body }, 'Received Shopify orders/create webhook request');
    const payload = getShopifyPayload(req.body as ShopifyOrderPayload | ShopifyWebhookBody);
    const shopifyOrderId = payload.id?.toString();
    const topic = req.get('X-Shopify-Topic') || 'orders/create';
    const shopDomain = req.get('X-Shopify-Shop-Domain') || config.shopify.shopDomain || undefined;
    const webhookId = req.get('X-Shopify-Webhook-Id') || undefined;
    const payloadHash = getPayloadHash(req);
    const existingWebhook = webhookId ? await WebhookEvent.findOne({ webhookId }) : null;

    // Log d'entrée volontairement compact: on trace les identifiants et le hash,
    // mais pas le payload complet pour éviter les données personnelles dans les logs.
    log.info(
      {
        topic,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName: payload.name,
        webhookId,
        payloadHash,
        hasWrappedPayload: Boolean((req.body as ShopifyWebhookBody).payload)
      },
      'Received Shopify orders/create webhook'
    );

    // 2. Idempotence niveau webhook Shopify.
    // Si Shopify réessaie le même webhook avec le même X-Shopify-Webhook-Id,
    // on ack en 202 sans recréer commande/message/job.
    if (existingWebhook) {
      log.info(
        {
          webhookId,
          orderId: existingWebhook.orderId,
          webhookEventId: existingWebhook._id
        },
        'Ignored duplicate Shopify webhook by webhook id'
      );

      return res.status(202).json({
        accepted: true,
        duplicate: true,
        orderId: existingWebhook.orderId
      });
    }

    // 3. Validation minimale des champs dont l'ingestion dépend.
    // Les webhooks invalides sont audités dans WebhookEvent pour debug.
    if (!shopifyOrderId || !payload.name || !payload.total_price || !payload.currency) {
      const failedEvent = await WebhookEvent.create({
        webhookId,
        topic,
        shopDomain,
        payloadHash,
        status: WebhookEventStatus.FAILED,
        errorMessage: 'Missing required Shopify order fields'
      });

      log.warn(
        {
          webhookId,
          webhookEventId: failedEvent._id,
          shopifyOrderId,
          shopifyOrderName: payload.name,
          hasTotalPrice: Boolean(payload.total_price),
          hasCurrency: Boolean(payload.currency)
        },
        'Rejected Shopify webhook because required order fields are missing'
      );

      return res.status(400).json({ error: 'MissingRequiredOrderFields' });
    }

    // 4. Idempotence secondaire par order id.
    // Certains tests/replays peuvent ne pas avoir de webhookId mais porter la même commande.
    const existingOrder = await Order.findOne({ shopifyOrderId });

    if (existingOrder) {
      const duplicateEvent = await WebhookEvent.create({
        webhookId,
        topic,
        shopDomain,
        payloadHash,
        status: WebhookEventStatus.DUPLICATE,
        orderId: existingOrder._id
      });

      log.info(
        {
          shopifyOrderId,
          orderId: existingOrder._id,
          webhookEventId: duplicateEvent._id
        },
        'Ignored duplicate Shopify webhook by existing order'
      );

      return res.status(202).json({
        accepted: true,
        duplicate: true,
        orderId: existingOrder._id,
        webhookEventId: duplicateEvent._id
      });
    }

    // 5. Extraction métier depuis les différents emplacements Shopify/Easysell.
    // Les payloads observés mettent parfois les mêmes données dans customer,
    // adresses, order.phone et note_attributes.
    const customerName = getCustomerName(payload);
    const parsedCustomerName = splitFullName(customerName);
    const customerPhoneRaw = getCustomerPhone(payload);
    const customerEmail = getCustomerEmail(payload);
    const customerAddress = getCustomerAddress(payload);
    const deliverySnapshot = extractDeliverySnapshot(payload);
    const phone = PhoneNormalizationService.normalizeSenegalPhone(customerPhoneRaw);
    const lineItems = getLineItems(payload);
    const tags = getTags(payload);
    const shippingLine = getShippingLine(payload);
    const noteAttributes = getNoteAttributesMap(payload);
    const skipNotificationReason = shouldSkipNotification(payload);
    const notificationStatus = !phone.isValid
      ? NotificationStatus.FAILED
      : skipNotificationReason
        ? NotificationStatus.SKIPPED
        : NotificationStatus.PENDING;
    const cod = isCashOnDelivery(payload);

    if (
      deliverySnapshot.deliveryPreferredMoment &&
      !KNOWN_DELIVERY_MOMENTS.has(normalizeDeliveryMoment(deliverySnapshot.deliveryPreferredMoment))
    ) {
      log.warn(
        {
          shopifyOrderId,
          deliveryPreferredMoment: deliverySnapshot.deliveryPreferredMoment
        },
        'Stored unknown Easysell preferred delivery moment'
      );
    }

    // Log de diagnostic après extraction: utile pour vérifier quel champ source
    // a réellement été retenu sans exposer tout le payload.
    log.info(
      {
        shopifyOrderId,
        shopifyOrderName: payload.name,
        shopifyCustomerId: payload.customer?.id?.toString(),
        customerName,
        customerPhoneRaw,
        customerPhoneE164: phone.e164,
        customerEmail,
        phoneValid: phone.isValid,
        phoneErrorReason: phone.errorReason,
        lineItemCount: lineItems.length,
        tags,
        paymentGatewayNames: payload.payment_gateway_names || [],
        isCashOnDelivery: cod,
        sourceName: payload.source_name,
        isTest: Boolean(payload.test),
        shopifyCancelledAt: payload.cancelled_at,
        shopifyCancelReason: payload.cancel_reason,
        skipNotificationReason
      },
      'Extracted Shopify order and customer data'
    );

    // 6. Upsert client.
    // On matche par Shopify customer id, téléphone E.164 ou email selon ce que le payload fournit.
    const customerLookupConditions = [
      ...(payload.customer?.id ? [{ shopifyCustomerId: payload.customer.id.toString() }] : []),
      ...(phone.e164 ? [{ phoneE164: phone.e164 }] : []),
      ...(customerEmail ? [{ email: customerEmail }] : [])
    ];
    const customerData = {
      shopifyCustomerId: payload.customer?.id?.toString(),
      shopifyCustomerGraphqlId: payload.customer?.admin_graphql_api_id || undefined,
      fullName: customerName,
      firstName: parsedCustomerName.firstName,
      lastName: parsedCustomerName.lastName,
      phoneRaw: customerPhoneRaw,
      phoneE164: phone.e164,
      email: customerEmail,
      ...customerAddress,
      region: deliverySnapshot.deliveryRegion || customerAddress.region,
      lastOrderName: payload.name,
      lastOrderAt: payload.created_at ? new Date(payload.created_at) : new Date()
    };

    // $or vide est invalide en MongoDB; si aucune clé stable n'existe,
    // on crée un client isolé pour ne pas perdre la commande.
    const customer =
      customerLookupConditions.length > 0
        ? await Customer.findOneAndUpdate(
            { $or: customerLookupConditions },
            {
              $set: customerData,
              $inc: {
                orderCount: 1
              }
            },
            {
              new: true,
              upsert: true,
              setDefaultsOnInsert: true
            }
          )
        : await Customer.create({
            ...customerData,
            orderCount: 1
          });

    log.info(
      {
        customerId: customer._id,
        shopifyCustomerId: customer.shopifyCustomerId,
        customerPhoneE164: customer.phoneE164,
        customerEmail: customer.email
      },
      'Upserted customer from Shopify order'
    );

    // 6b. Browser signals captured by the theme script (C5.12a).
    // Filled only on creation: a replayed webhook stops earlier (steps 2 and 4) so it can
    // never overwrite existing values. A failure here never blocks the ingestion.
    let browserSessionLink: Awaited<ReturnType<typeof findBrowserSessionCapiFields>> = { linked: false, fields: {} };
    let browserSessionLookupFailed = false;

    try {
      browserSessionLink = await withTimeout(
        findBrowserSessionCapiFields(phone.e164, getOrderCreatedAt(payload)),
        BROWSER_SESSION_LOOKUP_TIMEOUT_MS
      );
    } catch (err) {
      browserSessionLookupFailed = true;
      log.warn({ err, shopifyOrderId }, 'Browser session lookup failed, order ingested without browser signals');
    }

    // Advertising origin (C5.2): utm_* attributes first, full_url as fallback.
    const adAttribution = parseAdAttribution(noteAttributes);

    // 7. Création de la commande enrichie.
    // Elle garde les infos utiles pour le dashboard, les notifications et le futur stock.
    const order = await Order.create({
      shopifyOrderId,
      shopifyOrderName: payload.name,
      customerId: customer._id,
      customerName,
      customerPhoneRaw,
      customerPhoneE164: phone.e164,
      customerEmail,
      lineItems,
      totalPrice: payload.total_price,
      subtotalPrice: payload.subtotal_price,
      currentTotalPrice: payload.current_total_price,
      totalOutstanding: payload.total_outstanding,
      totalDiscounts: payload.total_discounts,
      shippingPrice: payload.total_shipping_price_set?.shop_money?.amount || shippingLine?.price || undefined,
      shippingTitle: shippingLine?.title || undefined,
      shippingRegion: deliverySnapshot.deliveryRegion || customerAddress.region,
      ...deliverySnapshot,
      currency: payload.currency,
      paymentGatewayNames: payload.payment_gateway_names || [],
      isCashOnDelivery: cod,
      tags,
      sourceName: payload.source_name || undefined,
      orderStatusUrl: payload.order_status_url || undefined,
      noteAttributes,
      isTest: Boolean(payload.test),
      shopifyCancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : undefined,
      shopifyCancelReason: payload.cancel_reason || undefined,
      financialStatus: payload.financial_status || undefined,
      fulfillmentStatus: payload.fulfillment_status || undefined,
      notificationStatus,
      // Spread after the session: the order's own full_url fbclid wins, the session's is the fallback.
      ...browserSessionLink.fields,
      ...adAttribution,
      ...(!phone.isValid && !skipNotificationReason
        ? {
            needsHelpdeskAttention: true,
            attentionReasonCode: AttentionReasonCode.INVALID_NUMBER,
            attentionReason: phone.errorReason || 'Invalid customer phone number',
            attentionRequiredAt: new Date()
          }
        : {})
    });

    // On rattache la dernière commande au client après création, car on a besoin de l'_id Order.
    customer.lastOrderId = order._id;
    await customer.save();

    // 8. Alimentation progressive du catalogue produit.
    // Les produits sont mis à jour depuis line_items, sans décrément de stock pour le moment.
    const products = await upsertProductsFromLineItems(lineItems, order._id.toString(), order.shopifyOrderName);

    log.info(
      {
        orderId: order._id,
        shopifyOrderId,
        shopifyOrderName: order.shopifyOrderName,
        customerId: customer._id,
        notificationStatus: order.notificationStatus,
        lineItemCount: order.lineItems.length,
        productCount: products.length,
        isCashOnDelivery: order.isCashOnDelivery,
        totalOutstanding: order.totalOutstanding,
        shippingPrice: order.shippingPrice
      },
      'Created order from Shopify webhook'
    );

    // Tracks the browser session → order link rate.
    log.info(
      {
        orderId: order._id,
        shopifyOrderId,
        browserSessionLinked: browserSessionLink.linked,
        browserSessionLookupFailed
      },
      'Browser session link checked'
    );

    // 9. Audit webhook après succès d'ingestion.
    // On le crée après l'ordre pour pouvoir relier l'événement à orderId.
    const webhookEvent = await WebhookEvent.create({
      webhookId,
      topic,
      shopDomain,
      payloadHash,
      status: WebhookEventStatus.PROCESSED,
      orderId: order._id
    });

    log.info(
      {
        webhookEventId: webhookEvent._id,
        orderId: order._id,
        webhookId,
        status: webhookEvent.status
      },
      'Stored Shopify webhook event'
    );

    // 10. Décision de notification.
    // Téléphone invalide => échec traçable.
    // Commande test/annulée/voided => skip volontaire, aucun job envoyé au worker.
    if (!phone.isValid || skipNotificationReason) {
      const failedMessage = await Message.create({
        orderId: order._id,
        channel: MessageChannel.WHATSAPP,
        provider: MessageProvider.META,
        status: MessageStatus.FAILED,
        templateName: config.metaWhatsApp.templateName,
        templatePurpose: TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
        errorCode: phone.isValid ? 'NOTIFICATION_SKIPPED' : 'INVALID_PHONE',
        errorMessage: phone.errorReason || skipNotificationReason || undefined
      });

      log[phone.isValid ? 'info' : 'warn'](
        {
          orderId: order._id,
          messageId: failedMessage._id,
          customerId: customer._id,
          customerPhoneRaw,
          errorReason: phone.errorReason || skipNotificationReason
        },
        'Skipped notification queue'
      );

      return res.status(202).json({
        accepted: true,
        orderId: order._id,
        customerId: customer._id,
        webhookEventId: webhookEvent._id,
        messageId: failedMessage._id,
        notificationQueued: false,
        phoneValid: phone.isValid,
        errorReason: phone.errorReason || skipNotificationReason
      });
    }

    // 11. Delayed initial WhatsApp confirmation request (C5.6a).
    // The customer often confirms within a minute through the pre-filled EasySell message, so
    // no Message is created here: a delayed job (deterministic jobId) re-checks the order when
    // the delay expires and only then creates the Message and hands over to the send flow.
    // A scheduling failure never fails the ingestion. With Redis unreachable the add never
    // settles (offline queue, `maxRetriesPerRequest: null`), hence the bounded wait (C5.15):
    // on error or timeout the order goes to the helpdesk queue and the webhook still gets 202.
    // If the hung add lands later anyway, the T+5 job runs under the worker guards: sent when
    // the order is still pending and not reminded (the hand-over clears `notification_not_scheduled`,
    // then notificationStatus goes FAILED → SENT), skipped otherwise (status and flag stay; a
    // reminder that is actually sent clears the flag).
    let scheduledJobId: string | undefined;

    try {
      const job = await withTimeout(scheduleInitialConfirmationRequest(order._id.toString()), QUEUE_ADD_TIMEOUT_MS);
      scheduledJobId = job.id;

      log.info(
        {
          orderId: order._id,
          jobId: job.id,
          queueName: job.queueName,
          delayMinutes: config.confirmation.initialRequestDelayMinutes
        },
        'Scheduled delayed initial confirmation request'
      );
    } catch (err) {
      log.error(
        { err, orderId: order._id, shopifyOrderId, timedOut: err instanceof TimeoutError },
        'Failed to schedule the initial confirmation request; order ingested without it'
      );

      try {
        const flagged = await flagUnscheduledConfirmationRequest(order._id.toString());
        log.info(
          { orderId: order._id, attentionReasonCode: AttentionReasonCode.NOTIFICATION_NOT_SCHEDULED, flagged },
          'Unscheduled confirmation request handed over to the helpdesk'
        );
      } catch (flagErr) {
        log.error(
          { err: flagErr, orderId: order._id, shopifyOrderId },
          'Failed to flag the unscheduled confirmation request for helpdesk attention'
        );
      }
    }

    // Réponse volontairement courte: IDs de suivi pour debug/dashboard.
    return res.status(202).json({
      accepted: true,
      orderId: order._id,
      customerId: customer._id,
      webhookEventId: webhookEvent._id,
      jobId: scheduledJobId,
      notificationQueued: Boolean(scheduledJobId),
      phoneValid: true
    });
  }
}
