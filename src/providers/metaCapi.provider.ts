import axios from 'axios';
import { createHash } from 'crypto';
import config from '../utilities/config/env.config';
import { splitFullName } from '../utilities/services/nameParser';
import { ConfirmationSource, IOrder } from '../models/Order';

// Meta Conversions API — événement « Purchase ».
// Ce module construit et envoie l'événement ; il ne touche pas à la base (le worker
// enregistre `meta` sur la commande). Meta n'accepte pas le XOF : tout part en EUR à
// la parité fixe `config.metaCapi.fxXofEur`. Aucun email n'est jamais envoyé.

export type CapiActionSource = 'website' | 'chat' | 'phone_call';

export interface CapiUserData {
  ph?: string[];
  fn?: string[];
  ln?: string[];
  country?: string[];
  st?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
}

export interface CapiContent {
  id: string;
  quantity: number;
  item_price: number;
}

export interface CapiPurchasePayload {
  event_name: 'Purchase';
  event_time: number;
  event_id: string;
  action_source: CapiActionSource;
  event_source_url?: string;
  user_data: CapiUserData;
  custom_data: {
    currency: 'EUR';
    value: number;
    contents: CapiContent[];
    content_type: 'product';
  };
}

export interface CapiPurchaseMeta {
  eventId: string;
  valueEur: number;
  fxRate: number;
}

export interface CapiSendResult {
  fbtraceId?: string;
  eventsReceived?: number;
  meta: CapiPurchaseMeta;
}

export interface MetaCapiErrorDetails {
  status?: number;
  metaCode?: number;
  metaSubcode?: number;
  fbtraceId?: string;
  retryable: boolean;
}

export class MetaCapiError extends Error {
  public readonly status?: number;
  public readonly metaCode?: number;
  public readonly metaSubcode?: number;
  public readonly fbtraceId?: string;
  public readonly retryable: boolean;

  constructor(message: string, details: MetaCapiErrorDetails) {
    super(message);
    this.name = 'MetaCapiError';
    this.status = details.status;
    this.metaCode = details.metaCode;
    this.metaSubcode = details.metaSubcode;
    this.fbtraceId = details.fbtraceId;
    this.retryable = details.retryable;
  }
}

const DEFAULT_COUNTRY = 'sn';
const REQUEST_TIMEOUT_MS = 10_000;

const sha256 = (normalized: string): string => createHash('sha256').update(normalized, 'utf8').digest('hex');

// Normalise (trim + minuscules) puis hache en SHA-256 hex minuscule ; undefined si vide.
export const hashSha256 = (value?: string | null): string | undefined => {
  const normalized = (value ?? '').toString().trim().toLowerCase();
  return normalized ? sha256(normalized) : undefined;
};

const hashPhone = (e164?: string): string | undefined => {
  const digits = (e164 || '').replace(/\D/g, '');
  return digits ? sha256(digits) : undefined;
};

const hashCountry = (code: string = DEFAULT_COUNTRY): string | undefined => {
  const letters = code.trim().toLowerCase();
  return /^[a-z]{2}$/.test(letters) ? sha256(letters) : undefined;
};

const hashRegion = (region?: string): string | undefined => {
  const normalized = (region || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return normalized ? sha256(normalized) : undefined;
};

export const toEur = (xof: number): number => Math.round((xof / config.metaCapi.fxXofEur) * 100) / 100;

const toNumber = (value?: string | number | null): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const resolveActionSource = (order: IOrder): CapiActionSource => {
  if (order.capiClientUserAgent) {
    return 'website';
  }
  if (order.confirmationSource === ConfirmationSource.WHATSAPP_BUTTON) {
    return 'chat';
  }
  return 'phone_call';
};

export const buildFbc = (order: IOrder): string | undefined => {
  if (order.capiFbc) {
    return order.capiFbc;
  }
  if (order.fbclid && order.createdAt) {
    return `fb.1.${new Date(order.createdAt).getTime()}.${order.fbclid}`;
  }
  return undefined;
};

// Valeur XOF des articles après remise, livraison exclue.
const computeValueXof = (order: IOrder): number => {
  const subtotal = toNumber(order.subtotalPrice);
  if (subtotal !== undefined && subtotal >= 0) {
    return subtotal;
  }
  const linesTotal = (order.lineItems || []).reduce(
    (sum, line) => sum + (toNumber(line.price) ?? 0) * (line.quantity || 0),
    0
  );
  return Math.max(0, linesTotal - (toNumber(order.totalDiscounts) ?? 0));
};

const compact = <T extends object>(input: T): T => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as T;
};

const hashed = (value?: string): string[] | undefined => (value ? [value] : undefined);

const buildUserData = (order: IOrder): CapiUserData => {
  const { firstName, lastName } = splitFullName(order.customerName);
  const externalId = order.customerId ? hashSha256(order.customerId.toString()) : hashPhone(order.customerPhoneE164);

  return compact<CapiUserData>({
    ph: hashed(hashPhone(order.customerPhoneE164)),
    fn: hashed(hashSha256(firstName)),
    ln: hashed(hashSha256(lastName)),
    country: hashed(hashCountry()),
    st: hashed(hashRegion(order.deliveryRegion || order.shippingRegion)),
    external_id: hashed(externalId),
    client_ip_address: order.browserIp,
    fbp: order.capiFbp,
    fbc: buildFbc(order),
    client_user_agent: order.capiClientUserAgent
  });
};

export const buildPurchasePayload = (order: IOrder): { payload: CapiPurchasePayload; meta: CapiPurchaseMeta } => {
  const eventDate = order.confirmedAt ?? order.deliveredAt;
  if (!eventDate) {
    throw new MetaCapiError('Order has neither confirmedAt nor deliveredAt', { retryable: false });
  }

  const eventId = `purchase_${order.shopifyOrderId}`;
  const valueEur = toEur(computeValueXof(order));

  const contents: CapiContent[] = [];
  for (const line of order.lineItems || []) {
    const id = line.variantId || line.productId;
    const quantity = line.quantity || 0;
    if (!id || quantity <= 0) continue;
    contents.push({ id, quantity, item_price: toEur(toNumber(line.price) ?? 0) });
  }

  const payload: CapiPurchasePayload = compact({
    event_name: 'Purchase' as const,
    event_time: Math.floor(new Date(eventDate).getTime() / 1000),
    event_id: eventId,
    action_source: resolveActionSource(order),
    event_source_url: order.capiEventSourceUrl || order.noteAttributes?.full_url,
    user_data: buildUserData(order),
    custom_data: {
      currency: 'EUR' as const,
      value: valueEur,
      contents,
      content_type: 'product' as const
    }
  });

  return { payload, meta: { eventId, valueEur, fxRate: config.metaCapi.fxXofEur } };
};

interface MetaCapiResponse {
  events_received?: number;
  fbtrace_id?: string;
}

interface MetaErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export const sendPurchase = async (order: IOrder): Promise<CapiSendResult> => {
  const { accessToken, datasetId, graphApiVersion } = config.metaCapi;
  if (!accessToken || !datasetId) {
    throw new MetaCapiError('Meta CAPI dataset id or access token is missing', { retryable: false });
  }

  const { payload, meta } = buildPurchasePayload(order);
  const url = `https://graph.facebook.com/${graphApiVersion}/${datasetId}/events`;
  // test_event_code va à la racine du corps (pas dans l'événement) pour activer Test Events.
  const body = {
    access_token: accessToken,
    data: [payload],
    ...(config.metaCapi.testEventCode ? { test_event_code: config.metaCapi.testEventCode } : {})
  };

  try {
    const response = await axios.post<MetaCapiResponse>(
      url,
      body,
      { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
    );

    return {
      fbtraceId: response.data?.fbtrace_id,
      eventsReceived: response.data?.events_received,
      meta
    };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const metaError = (err.response?.data as MetaErrorBody | undefined)?.error;
      // Réseau / timeout (pas de réponse), 5xx et 429 : on peut réessayer ; autres 4xx : non.
      const retryable = status === undefined || status >= 500 || status === 429;
      const reason = metaError?.message || err.message;
      throw new MetaCapiError(`Meta CAPI request failed: ${status ?? 'NO_STATUS'} ${reason}`, {
        status,
        metaCode: metaError?.code,
        metaSubcode: metaError?.error_subcode,
        fbtraceId: metaError?.fbtrace_id,
        retryable
      });
    }
    throw err;
  }
};
