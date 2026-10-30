import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import config from '../utilities/config/env.config';
import { ConfirmationSource, IOrder } from '../models/Order';
import {
  MetaCapiError,
  buildFbc,
  buildPurchasePayload,
  hashSha256,
  resolveActionSource,
  sendPurchase,
  toEur
} from './metaCapi.provider';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios') as typeof import('axios');
  return {
    __esModule: true,
    default: { post: jest.fn(), isAxiosError: actual.isAxiosError }
  };
});

const mockedPost = axios.post as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const customerId = new Types.ObjectId('64b7f0c2a1b2c3d4e5f60718');

const baseOrder = (overrides: Record<string, unknown> = {}): IOrder =>
  ({
    shopifyOrderId: '1234567890',
    customerId,
    customerName: 'Aïssatou Marie Diallo',
    customerPhoneE164: '+221776986780',
    deliveryRegion: 'Thiès',
    browserIp: '41.82.10.5',
    subtotalPrice: '14000',
    totalDiscounts: '0',
    lineItems: [
      { variantId: 'v-1', productId: 'p-1', quantity: 2, price: '5000' },
      { productId: 'p-2', quantity: 1, price: '4000' }
    ],
    confirmedAt: new Date('2026-10-29T10:00:00.000Z'),
    createdAt: new Date('2026-10-28T08:00:00.000Z'),
    capiClientUserAgent: 'Mozilla/5.0 (test)',
    capiFbp: 'fb.1.1700000000000.123',
    capiFbc: 'fb.1.1700000000000.abc',
    capiEventSourceUrl: 'https://shop.example/products/x',
    ...overrides
  }) as unknown as IOrder;

const originalCapi = { ...config.metaCapi };

beforeEach(() => {
  Object.assign(config.metaCapi, {
    enabled: true,
    datasetId: '999',
    accessToken: 'token-test',
    graphApiVersion: 'v26.0',
    fxXofEur: 655.957,
    testEventCode: ''
  });
});

afterEach(() => {
  Object.assign(config.metaCapi, originalCapi);
});

describe('hashSha256', () => {
  it('trims, lowercases and hashes to lowercase hex', () => {
    expect(hashSha256('  Diallo ')).toBe(sha('diallo'));
    expect(hashSha256('DIALLO')).toBe(hashSha256('diallo'));
    expect(hashSha256('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns undefined for empty values', () => {
    expect(hashSha256('')).toBeUndefined();
    expect(hashSha256('   ')).toBeUndefined();
    expect(hashSha256(undefined)).toBeUndefined();
    expect(hashSha256(null)).toBeUndefined();
  });
});

describe('toEur', () => {
  it('converts XOF to EUR at the fixed parity, rounded to cents', () => {
    expect(toEur(14000)).toBe(21.34);
    expect(toEur(0)).toBe(0);
  });
});

describe('resolveActionSource', () => {
  it('returns website whenever a user agent is present, whatever the confirmation source', () => {
    for (const source of [ConfirmationSource.WHATSAPP_BUTTON, ConfirmationSource.PHONE_CALL, ConfirmationSource.ADMIN, undefined]) {
      expect(resolveActionSource(baseOrder({ confirmationSource: source }))).toBe('website');
    }
  });

  it('returns chat for a WhatsApp button confirmation without user agent', () => {
    const order = baseOrder({ capiClientUserAgent: undefined, confirmationSource: ConfirmationSource.WHATSAPP_BUTTON });
    expect(resolveActionSource(order)).toBe('chat');
  });

  it('returns phone_call for phone_call and admin confirmations without user agent', () => {
    expect(
      resolveActionSource(baseOrder({ capiClientUserAgent: undefined, confirmationSource: ConfirmationSource.PHONE_CALL }))
    ).toBe('phone_call');
    expect(
      resolveActionSource(baseOrder({ capiClientUserAgent: undefined, confirmationSource: ConfirmationSource.ADMIN }))
    ).toBe('phone_call');
  });

  it('falls back to phone_call for a delivery without confirmation', () => {
    const order = baseOrder({ capiClientUserAgent: undefined, confirmationSource: undefined, confirmedAt: undefined });
    expect(resolveActionSource(order)).toBe('phone_call');
  });
});

describe('buildFbc', () => {
  it('prefers the stored capiFbc', () => {
    expect(buildFbc(baseOrder({ fbclid: 'zzz' }))).toBe('fb.1.1700000000000.abc');
  });

  it('builds fb.1.<createdAt ms>.<fbclid> from fbclid', () => {
    const order = baseOrder({ capiFbc: undefined, fbclid: 'IwAR123' });
    expect(buildFbc(order)).toBe(`fb.1.${new Date('2026-10-28T08:00:00.000Z').getTime()}.IwAR123`);
  });

  it('returns undefined without capiFbc nor fbclid', () => {
    expect(buildFbc(baseOrder({ capiFbc: undefined }))).toBeUndefined();
  });
});

describe('buildPurchasePayload', () => {
  it('builds a complete payload with hashed personal data, no email and no empty key', () => {
    const { payload, meta } = buildPurchasePayload(
      baseOrder({ customerEmail: 'secret@example.com' })
    );

    expect(payload.event_name).toBe('Purchase');
    expect(payload.event_time).toBe(Math.floor(new Date('2026-10-29T10:00:00.000Z').getTime() / 1000));
    expect(payload.event_id).toBe('purchase_1234567890');
    expect(payload.action_source).toBe('website');
    expect(payload.event_source_url).toBe('https://shop.example/products/x');
    expect(payload.user_data).toEqual({
      ph: [sha('221776986780')],
      fn: [sha('aïssatou marie')],
      ln: [sha('diallo')],
      country: [sha('sn')],
      st: [sha('thies')],
      external_id: [sha(customerId.toString())],
      client_ip_address: '41.82.10.5',
      client_user_agent: 'Mozilla/5.0 (test)',
      fbp: 'fb.1.1700000000000.123',
      fbc: 'fb.1.1700000000000.abc'
    });
    expect(payload.custom_data).toEqual({
      currency: 'EUR',
      value: 21.34,
      contents: [
        { id: 'v-1', quantity: 2, item_price: 7.62 },
        { id: 'p-2', quantity: 1, item_price: 6.1 }
      ],
      content_type: 'product'
    });
    expect(meta).toEqual({ eventId: 'purchase_1234567890', valueEur: 21.34, fxRate: 655.957 });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('"em"');
    expect(serialized).not.toContain('secret@example.com');
    expect(serialized).not.toContain('221776986780');
    expect(serialized).not.toContain('Diallo');
    const hasEmpty = (value: unknown): boolean =>
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) ? value.length === 0 || value.some(hasEmpty) : false) ||
      (typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.values(value).some(hasEmpty)
        : false);
    expect(hasEmpty(payload)).toBe(false);
  });

  it('omits absent optional data instead of emitting empty keys, and falls back to phone for external_id', () => {
    const { payload } = buildPurchasePayload(
      baseOrder({
        customerId: undefined,
        customerName: undefined,
        deliveryRegion: undefined,
        browserIp: undefined,
        capiFbp: undefined,
        capiFbc: undefined,
        capiClientUserAgent: undefined,
        capiEventSourceUrl: undefined,
        confirmationSource: ConfirmationSource.ADMIN
      })
    );

    expect(payload.event_source_url).toBeUndefined();
    expect('event_source_url' in payload).toBe(false);
    expect(payload.action_source).toBe('phone_call');
    expect(payload.user_data).toEqual({
      ph: [sha('221776986780')],
      country: [sha('sn')],
      external_id: [sha('221776986780')]
    });
  });

  it('uses noteAttributes.full_url when capiEventSourceUrl is missing', () => {
    const { payload } = buildPurchasePayload(
      baseOrder({ capiEventSourceUrl: undefined, noteAttributes: { full_url: 'https://shop.example/?utm=1' } })
    );
    expect(payload.event_source_url).toBe('https://shop.example/?utm=1');
  });

  it('uses deliveredAt when there is no confirmedAt', () => {
    const { payload } = buildPurchasePayload(
      baseOrder({ confirmedAt: undefined, deliveredAt: new Date('2026-10-30T12:00:00.000Z') })
    );
    expect(payload.event_time).toBe(Math.floor(new Date('2026-10-30T12:00:00.000Z').getTime() / 1000));
  });

  it('falls back to sum(price x quantity) - discounts when subtotalPrice is absent or invalid', () => {
    // 2 x 5000 + 1 x 4000 = 14000 ; - 2000 = 12000 XOF -> 18.29 EUR
    for (const subtotalPrice of [undefined, 'abc', '']) {
      const { payload, meta } = buildPurchasePayload(baseOrder({ subtotalPrice, totalDiscounts: '2000' }));
      expect(payload.custom_data.value).toBe(18.29);
      expect(meta.valueEur).toBe(18.29);
    }
  });

  it('never puts test_event_code inside the event', () => {
    config.metaCapi.testEventCode = 'TEST123';
    expect('test_event_code' in buildPurchasePayload(baseOrder()).payload).toBe(false);
  });

  it('throws when the order has no event date', () => {
    expect(() => buildPurchasePayload(baseOrder({ confirmedAt: undefined }))).toThrow(MetaCapiError);
  });
});

describe('sendPurchase', () => {
  it('posts to the dataset events endpoint with a 10 s timeout and returns the trace', async () => {
    mockedPost.mockResolvedValueOnce({ data: { events_received: 1, fbtrace_id: 'trace-1' } });

    const result = await sendPurchase(baseOrder());

    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, options] = mockedPost.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(url).toBe('https://graph.facebook.com/v26.0/999/events');
    expect(body.access_token).toBe('token-test');
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(1);
    expect(options.timeout).toBe(10000);
    expect(result).toEqual({
      fbtraceId: 'trace-1',
      eventsReceived: 1,
      meta: { eventId: 'purchase_1234567890', valueEur: 21.34, fxRate: 655.957 }
    });
  });

  it('sends test_event_code at the root of the body, next to data, when configured', async () => {
    config.metaCapi.testEventCode = 'TEST123';
    mockedPost.mockResolvedValueOnce({ data: { events_received: 1, fbtrace_id: 'trace-2' } });

    await sendPurchase(baseOrder());

    const body = (mockedPost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(body.test_event_code).toBe('TEST123');
    expect(Object.keys(body).sort()).toEqual(['access_token', 'data', 'test_event_code']);
    expect('test_event_code' in (body.data as Record<string, unknown>[])[0]).toBe(false);
  });

  it('omits test_event_code from the body when not configured', async () => {
    mockedPost.mockResolvedValueOnce({ data: { events_received: 1 } });

    await sendPurchase(baseOrder());

    const body = (mockedPost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect('test_event_code' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['access_token', 'data']);
  });

  it('fails non-retryably when not configured, without any network call', async () => {
    config.metaCapi.accessToken = '';
    await expect(sendPurchase(baseOrder())).rejects.toMatchObject({ name: 'MetaCapiError', retryable: false });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  const axiosFailure = (status: number | undefined, data?: unknown, code?: string) => {
    const error = new Error(status ? `HTTP ${status}` : 'network down') as Error & Record<string, unknown>;
    error.isAxiosError = true;
    error.code = code;
    error.response = status ? { status, data } : undefined;
    return error;
  };

  it('classifies a 400 as non-retryable and keeps the Meta codes', async () => {
    mockedPost.mockRejectedValueOnce(
      axiosFailure(400, { error: { message: 'Invalid parameter', code: 100, error_subcode: 2804003, fbtrace_id: 'tr-9' } })
    );

    const error = await sendPurchase(baseOrder()).catch(e => e);

    expect(error).toBeInstanceOf(MetaCapiError);
    expect(error).toMatchObject({
      status: 400,
      metaCode: 100,
      metaSubcode: 2804003,
      fbtraceId: 'tr-9',
      retryable: false
    });
    expect(error.message).toContain('Invalid parameter');
    expect(error.message).not.toContain('token-test');
  });

  it.each([500, 502, 503, 429])('classifies HTTP %i as retryable', async status => {
    mockedPost.mockRejectedValueOnce(axiosFailure(status, { error: { message: 'boom', code: 2 } }));
    await expect(sendPurchase(baseOrder())).rejects.toMatchObject({ status, retryable: true });
  });

  it.each([401, 403, 404])('classifies HTTP %i as non-retryable', async status => {
    mockedPost.mockRejectedValueOnce(axiosFailure(status, { error: { message: 'nope', code: 190 } }));
    await expect(sendPurchase(baseOrder())).rejects.toMatchObject({ status, retryable: false });
  });

  it('classifies network errors and timeouts (no response) as retryable', async () => {
    mockedPost.mockRejectedValueOnce(axiosFailure(undefined, undefined, 'ECONNABORTED'));
    await expect(sendPurchase(baseOrder())).rejects.toMatchObject({ status: undefined, retryable: true });
  });
});
