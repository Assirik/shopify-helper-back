import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Job, UnrecoverableError } from 'bullmq';
import axios from 'axios';
import { Types } from 'mongoose';

jest.mock('../queues/notification.queue', () => ({
  getRedisConnection: jest.fn()
}));

jest.mock('../queues/capi.queue', () => ({
  CAPI_PURCHASE_QUEUE_NAME: 'capi-purchase'
}));

jest.mock('../utilities/services/capiPurchase.service', () => ({
  triggerCapiPurchase: jest.fn(async () => undefined)
}));

jest.mock('axios', () => {
  const actual = jest.requireActual('axios') as typeof import('axios');
  return {
    __esModule: true,
    default: { post: jest.fn(), isAxiosError: actual.isAxiosError }
  };
});

jest.mock('../providers/metaCapi.provider', () => {
  const actual = jest.requireActual('../providers/metaCapi.provider') as typeof import('../providers/metaCapi.provider');
  return { ...actual, sendPurchase: jest.fn() };
});

import { CapiPurchaseStatus, CustomerConfirmationStatus, Order } from '../models/Order';
import { OrderEvent, OrderEventType } from '../models/OrderEvent';
import { MetaCapiError, sendPurchase } from '../providers/metaCapi.provider';
import { CapiPurchaseJobData } from '../queues/capi.queue';
import config from '../utilities/config/env.config';
import { triggerCapiPurchase } from '../utilities/services/capiPurchase.service';
import {
  CAPI_MAX_EVENT_AGE_MS,
  getSkipReason,
  handleCapiPurchaseJobFailed,
  isDefinitiveMetaRefusal,
  processCapiPurchaseJob,
  toShortErrorMessage
} from './capiPurchase.worker';

const mockedSend = jest.mocked(sendPurchase);
const mockedPost = axios.post as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const actualProvider = jest.requireActual('../providers/metaCapi.provider') as typeof import('../providers/metaCapi.provider');

// Axios failure shaped like the one the real provider receives from Graph.
const axiosFailure = (status: number, data: unknown) => {
  const error = new Error(`HTTP ${status}`) as Error & Record<string, unknown>;
  error.isAxiosError = true;
  error.response = { status, data };
  return error;
};
const orderId = new Types.ObjectId();
const HOUR = 60 * 60 * 1000;

const buildOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: orderId,
  shopifyOrderId: '1234567890',
  isTest: false,
  capiPurchaseStatus: CapiPurchaseStatus.PENDING,
  customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
  confirmedAt: new Date(Date.now() - HOUR),
  capiFbp: 'fb.1.1700000000000.123',
  capiClientUserAgent: 'Mozilla/5.0',
  ...overrides
});

const buildJob = (attemptsMade = 0, attempts = 5) =>
  ({
    id: `capi-purchase-${orderId.toString()}`,
    data: { orderId: orderId.toString() },
    processedOn: Date.now() - 60_000,
    attemptsMade,
    opts: { attempts }
  }) as unknown as Job<CapiPurchaseJobData>;

const sendResult = {
  fbtraceId: 'trace-1',
  eventsReceived: 1,
  meta: { eventId: 'purchase_1234567890', valueEur: 21.34, fxRate: 655.957 }
};

describe('capi purchase worker', () => {
  const originalEnabled = config.metaCapi.enabled;
  const originalToken = config.metaCapi.accessToken;
  const originalDatasetId = config.metaCapi.datasetId;

  // The possibly-received mark (`$min`, any status): recorded for inspection.
  let markWrite: jest.Mock;

  beforeEach(() => {
    config.metaCapi.enabled = true;
    markWrite = jest.spyOn(Order, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never) as unknown as jest.Mock;
  });

  afterEach(() => {
    config.metaCapi.enabled = originalEnabled;
    config.metaCapi.accessToken = originalToken;
    config.metaCapi.datasetId = originalDatasetId;
    jest.restoreAllMocks();
    mockedSend.mockReset();
    mockedPost.mockReset();
  });

  // Loosely typed spy: Mongoose's overloads make toHaveBeenCalledWith reject plain filters.
  const spyUpdate = (...result: [unknown?]) => {
    const spy = jest.spyOn(Order, 'findOneAndUpdate');
    if (result.length) spy.mockResolvedValue(result[0] as never);
    return spy as unknown as jest.Mock;
  };

  const stubOrder = (order: Record<string, unknown> | null) =>
    jest.spyOn(Order, 'findById').mockResolvedValue(order as never);

  it('sends the purchase, marks the order sent and records the event', async () => {
    stubOrder(buildOrder());
    mockedSend.mockResolvedValueOnce(sendResult);
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    const [filter, change] = update.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, any>];
    expect(filter).toEqual({ _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING });
    expect(change.$set).toEqual(
      expect.objectContaining({
        capiPurchaseStatus: CapiPurchaseStatus.SENT,
        capiPurchaseSentAt: expect.any(Date),
        capiEventId: 'purchase_1234567890',
        capiValueEur: 21.34,
        capiFxRate: 655.957
      })
    );
    expect(change.$unset).toEqual({ capiPurchaseError: '' });
    expect(createEvent).toHaveBeenCalledWith({
      orderId,
      type: OrderEventType.CAPI_PURCHASE_SENT,
      metadata: {
        eventId: 'purchase_1234567890',
        fbtraceId: 'trace-1',
        hasFbc: false,
        hasFbp: true,
        hasUserAgent: true,
        valueEur: 21.34
      }
    });
  });

  it.each([
    ['test', { isTest: true }],
    ['cancelled', { shopifyCancelledAt: new Date() }],
    ['cancelled', { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }],
    ['too_old', { confirmedAt: new Date(Date.now() - CAPI_MAX_EVENT_AGE_MS - 60_000) }],
    ['too_old', { confirmedAt: undefined, deliveredAt: new Date(Date.now() - 7 * 24 * HOUR + 30 * 60_000) }]
  ])('skips with reason %s without any network call', async (reason, overrides) => {
    stubOrder(buildOrder(overrides));
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      { $set: { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: reason } },
      expect.anything()
    );
    expect(createEvent).toHaveBeenCalledWith({
      orderId,
      type: OrderEventType.CAPI_PURCHASE_SKIPPED,
      metadata: { reason }
    });
  });

  it('does not send a purchase cancelled by an agent while the send was delayed (5xx then cancel then retry)', async () => {
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    const findById = jest.spyOn(Order, 'findById');

    // First attempt: confirmed order, Meta answers 5xx, the job is retried later.
    findById.mockResolvedValueOnce(buildOrder({ customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }) as never);
    mockedSend.mockRejectedValueOnce(new MetaCapiError('Meta 503', { status: 503, retryable: true, requestSent: true }));
    await expect(processCapiPurchaseJob(buildJob(0))).rejects.toThrow();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();

    // The agent cancels, then the retry runs: skipped, no second call to Meta.
    findById.mockResolvedValue(buildOrder({ customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }) as never);
    await processCapiPurchaseJob(buildJob(1));

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith({
      orderId,
      type: OrderEventType.CAPI_PURCHASE_SKIPPED,
      metadata: { reason: 'cancelled' }
    });
  });

  it('still sends an order cancelled by an agent but delivered anyway (a real sale)', async () => {
    stubOrder(
      buildOrder({ customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED, deliveredAt: new Date() })
    );
    mockedSend.mockResolvedValueOnce(sendResult);
    spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['reopened needs_attention', CustomerConfirmationStatus.NEEDS_ATTENTION],
    ['pending', CustomerConfirmationStatus.PENDING],
    ['sms_only', CustomerConfirmationStatus.SMS_ONLY],
    ['expired', CustomerConfirmationStatus.EXPIRED]
  ])('skips with reason cancelled an order neither confirmed nor delivered (%s)', async (_label, status) => {
    stubOrder(buildOrder({ customerConfirmationStatus: status, confirmedAt: undefined }));
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      { $set: { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: 'cancelled' } },
      expect.anything()
    );
    expect(createEvent).toHaveBeenCalledWith({
      orderId,
      type: OrderEventType.CAPI_PURCHASE_SKIPPED,
      metadata: { reason: 'cancelled' }
    });
  });

  it('does not send an order cancelled then reopened by a customer message while the send was delayed', async () => {
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    const findById = jest.spyOn(Order, 'findById');

    // First attempt: confirmed order, Meta answers 5xx, the job is retried later.
    findById.mockResolvedValueOnce(buildOrder() as never);
    mockedSend.mockRejectedValueOnce(new MetaCapiError('Meta 503', { status: 503, retryable: true, requestSent: true }));
    await expect(processCapiPurchaseJob(buildJob(0))).rejects.toThrow();

    // The agent cancels, the customer presses the button: the order is reopened (late_confirm).
    findById.mockResolvedValue(
      buildOrder({ customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION }) as never
    );
    await processCapiPurchaseJob(buildJob(1));

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith({
      orderId,
      type: OrderEventType.CAPI_PURCHASE_SKIPPED,
      metadata: { reason: 'cancelled' }
    });
  });

  it('still sends an order in needs_attention that was delivered (fallback without confirmation)', async () => {
    stubOrder(
      buildOrder({
        customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION,
        confirmedAt: undefined,
        deliveredAt: new Date()
      })
    );
    mockedSend.mockResolvedValueOnce(sendResult);
    spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('skips with reason disabled when the CAPI flag is off', async () => {
    config.metaCapi.enabled = false;
    stubOrder(buildOrder());
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      { $set: { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: 'disabled' } },
      expect.anything()
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: OrderEventType.CAPI_PURCHASE_SKIPPED, metadata: { reason: 'disabled' } })
    );
  });

  describe('order confirmed or delivered while the worker decided to skip it (C5.7)', () => {
    const notASale = buildOrder({ customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION, confirmedAt: undefined });

    it.each([
      ['confirmed', { customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED, confirmedAt: new Date() }],
      ['delivered', { deliveredAt: new Date() }]
    ])('takes the Purchase back when the order is now %s', async (_label, sale) => {
      jest
        .spyOn(Order, 'findById')
        .mockResolvedValueOnce(notASale as never)
        .mockResolvedValueOnce({ ...notASale, ...sale, capiPurchaseStatus: CapiPurchaseStatus.SKIPPED } as never);
      spyUpdate({ _id: orderId });
      jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

      await processCapiPurchaseJob(buildJob());

      expect(mockedSend).not.toHaveBeenCalled();
      expect(triggerCapiPurchase).toHaveBeenCalledTimes(1);
      expect(triggerCapiPurchase).toHaveBeenCalledWith(orderId, 'confirmation');
    });

    it('does nothing more when the order is still not a sale', async () => {
      stubOrder(notASale);
      spyUpdate({ _id: orderId });
      jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

      await processCapiPurchaseJob(buildJob());

      expect(Order.findById).toHaveBeenCalledTimes(2);
      expect(triggerCapiPurchase).not.toHaveBeenCalled();
    });

    it('does not read again when the skip was not recorded, nor for another reason', async () => {
      const findById = stubOrder(notASale);
      spyUpdate(null);
      await processCapiPurchaseJob(buildJob());
      expect(findById).toHaveBeenCalledTimes(1);

      jest.restoreAllMocks();
      const findTest = stubOrder(buildOrder({ isTest: true }));
      spyUpdate({ _id: orderId });
      jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
      await processCapiPurchaseJob(buildJob());
      expect(findTest).toHaveBeenCalledTimes(1);

      expect(triggerCapiPurchase).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['400 not retried', new MetaCapiError('bad', { status: 400, retryable: false }), true],
    ['403 not retried', new MetaCapiError('bad', { status: 403, retryable: false }), true],
    ['429 retried', new MetaCapiError('busy', { status: 429, retryable: true }), false],
    ['503', new MetaCapiError('down', { status: 503, retryable: true }), false],
    ['timeout (no status)', new MetaCapiError('timeout', { retryable: true }), false],
    ['not retried, no HTTP answer', new MetaCapiError('missing config', { retryable: false }), false],
    ['non-Meta error', new Error('MongoNetworkError'), false]
  ])('classifies a final failure as a certain refusal by Meta: %s → %p', (_label, err, expected) => {
    expect(isDefinitiveMetaRefusal(err)).toBe(expected);
  });

  it('still sends an event just inside the 7 days minus 1 hour margin', async () => {
    stubOrder(buildOrder({ confirmedAt: new Date(Date.now() - CAPI_MAX_EVENT_AGE_MS + 60_000) }));
    mockedSend.mockResolvedValueOnce(sendResult);
    spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(CAPI_MAX_EVENT_AGE_MS).toBe(7 * 24 * HOUR - HOUR);
  });

  it.each([
    ['status sent', { capiPurchaseStatus: CapiPurchaseStatus.SENT }],
    ['capiPurchaseSentAt set', { capiPurchaseSentAt: new Date() }]
  ])('does nothing when already sent (%s)', async (_label, overrides) => {
    stubOrder(buildOrder(overrides));
    const update = spyUpdate();
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('ignores an order whose status is not pending', async () => {
    stubOrder(buildOrder({ capiPurchaseStatus: CapiPurchaseStatus.SKIPPED }));
    const update = spyUpdate();

    await processCapiPurchaseJob(buildJob());

    expect(mockedSend).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('ends quietly when the order no longer exists', async () => {
    stubOrder(null);
    const update = spyUpdate();

    await expect(processCapiPurchaseJob(buildJob())).resolves.toBeUndefined();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('records no event when the status changed between read and write', async () => {
    stubOrder(buildOrder());
    mockedSend.mockResolvedValueOnce(sendResult);
    const update = spyUpdate(null);
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await processCapiPurchaseJob(buildJob());

    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      expect.anything(),
      expect.anything()
    );
    expect(createEvent).not.toHaveBeenCalled();
    // Meta accepted the event but SENT was not recorded: the fact is kept on the order.
    expect(markWrite).toHaveBeenCalledWith({ _id: orderId }, { $min: { capiPossiblyReceivedAt: expect.any(Date) } });
  });

  it('marks the order possibly received when Meta accepted but the SENT write throws', async () => {
    stubOrder(buildOrder());
    mockedSend.mockResolvedValueOnce(sendResult);
    jest.spyOn(Order, 'findOneAndUpdate').mockRejectedValue(new Error('MongoNetworkError') as never);

    await expect(processCapiPurchaseJob(buildJob())).rejects.toThrow('MongoNetworkError');

    expect(markWrite).toHaveBeenCalledWith({ _id: orderId }, { $min: { capiPossiblyReceivedAt: expect.any(Date) } });
  });

  it('does not mark a Purchase recorded as SENT', async () => {
    stubOrder(buildOrder());
    mockedSend.mockResolvedValueOnce(sendResult);
    spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await processCapiPurchaseJob(buildJob());

    expect(markWrite).not.toHaveBeenCalled();
  });

  it('records no skip event when the status changed concurrently', async () => {
    stubOrder(buildOrder({ isTest: true }));
    spyUpdate(null);
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await processCapiPurchaseJob(buildJob());

    expect(createEvent).not.toHaveBeenCalled();
  });

  it('rethrows a retryable error without touching the status while attempts remain', async () => {
    stubOrder(buildOrder());
    const err = new MetaCapiError('Meta CAPI request failed: 503 Service Unavailable', { status: 503, retryable: true, requestSent: true });
    mockedSend.mockRejectedValueOnce(err);
    const update = spyUpdate();
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await expect(processCapiPurchaseJob(buildJob(2, 5))).rejects.toBe(err);

    expect(update).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('marks failed and records the event when the last attempt fails', async () => {
    stubOrder(buildOrder());
    const err = new MetaCapiError('Meta CAPI request failed: NO_STATUS timeout', { retryable: true, requestSent: true });
    mockedSend.mockRejectedValueOnce(err);
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(processCapiPurchaseJob(buildJob(4, 5))).rejects.toBe(err);

    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      {
        $set: {
          capiPurchaseStatus: CapiPurchaseStatus.FAILED,
          capiPurchaseError: 'Meta CAPI request failed: NO_STATUS timeout',
          capiPurchaseFailedAt: expect.any(Date),
          // Timeout: Meta may have received the event.
          capiPurchaseFailureDefinitive: false
        }
      },
      expect.anything()
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        type: OrderEventType.CAPI_PURCHASE_FAILED,
        metadata: expect.objectContaining({ error: 'Meta CAPI request failed: NO_STATUS timeout', attempts: 5 })
      })
    );
  });

  it('stops retrying on a non-retryable error and marks failed', async () => {
    stubOrder(buildOrder());
    mockedSend.mockRejectedValueOnce(
      new MetaCapiError('Meta CAPI request failed: 400 Invalid OAuth access token', {
        status: 400,
        metaCode: 190,
        fbtraceId: 'trace-2',
        retryable: false,
        requestSent: true
      })
    );
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(processCapiPurchaseJob(buildJob(0, 5))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      {
        $set: expect.objectContaining({
          capiPurchaseStatus: CapiPurchaseStatus.FAILED,
          capiPurchaseFailedAt: expect.any(Date),
          // 400 not retried: a certain refusal, the event was not counted.
          capiPurchaseFailureDefinitive: true
        })
      },
      expect.anything()
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: OrderEventType.CAPI_PURCHASE_FAILED,
        metadata: expect.objectContaining({ status: 400, metaCode: 190, fbtraceId: 'trace-2', retryable: false })
      })
    );
    // A certain refusal from the first attempt never reached Meta's count: no mark.
    expect(markWrite).not.toHaveBeenCalled();
  });

  it('S13: a timeout then a 400 in the same job is not a definitive failure (the timeout is marked)', async () => {
    const findById = jest.spyOn(Order, 'findById');
    const update = spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    // Attempt 1: timeout, Meta may have recorded it.
    findById.mockResolvedValueOnce(buildOrder() as never);
    mockedSend.mockRejectedValueOnce(new MetaCapiError('Meta CAPI request failed: NO_STATUS timeout', { retryable: true, requestSent: true }));
    await expect(processCapiPurchaseJob(buildJob(0, 5))).rejects.toThrow();
    expect(markWrite).toHaveBeenCalledTimes(1);
    const [, { $min }] = markWrite.mock.calls[0] as [unknown, { $min: { capiPossiblyReceivedAt: Date } }];

    // Attempt 2 reads the mark, then Meta answers 400.
    findById.mockResolvedValueOnce(buildOrder({ capiPossiblyReceivedAt: $min.capiPossiblyReceivedAt }) as never);
    mockedSend.mockRejectedValueOnce(new MetaCapiError('Meta CAPI request failed: 400 bad', { status: 400, retryable: false, requestSent: true }));
    await expect(processCapiPurchaseJob(buildJob(1, 5))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(markWrite).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      { $set: expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseFailureDefinitive: false }) },
      expect.anything()
    );
  });

  it('a 400 after an earlier attempt of the same job is not definitive even when that attempt left no mark', async () => {
    // Attempt 1 timed out but writing its mark failed: the order read by attempt 2 has no mark.
    stubOrder(buildOrder());
    mockedSend.mockRejectedValueOnce(new MetaCapiError('Meta CAPI request failed: 400 bad', { status: 400, retryable: false, requestSent: true }));
    const update = spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(processCapiPurchaseJob(buildJob(1, 5))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      { $set: expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseFailureDefinitive: false }) },
      expect.anything()
    );
    expect(markWrite).not.toHaveBeenCalled();
  });

  it('S14: a 401 after an earlier job may have reached Meta (resend) is not a definitive failure', async () => {
    stubOrder(buildOrder({ capiPossiblyReceivedAt: new Date(Date.now() - 10 * HOUR) }));
    mockedSend.mockRejectedValueOnce(new MetaCapiError('Meta CAPI request failed: 401 token', { status: 401, retryable: false, requestSent: true }));
    const update = spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(processCapiPurchaseJob(buildJob(0, 5))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      { $set: expect.objectContaining({ capiPurchaseFailureDefinitive: false }) },
      expect.anything()
    );
    expect(markWrite).not.toHaveBeenCalled();
  });

  it('does not mark an error raised before any call to Meta (missing configuration)', async () => {
    config.metaCapi.accessToken = '';
    stubOrder(buildOrder());
    mockedSend.mockImplementationOnce(actualProvider.sendPurchase);
    const update = spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(processCapiPurchaseJob(buildJob(0, 5))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mockedPost).not.toHaveBeenCalled();
    expect(markWrite).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      { $set: expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseFailureDefinitive: false }) },
      expect.anything()
    );
  });

  // Real provider (sendPurchase not stubbed) fed with a simulated Graph error response.
  const sendThroughRealProvider = (graphError: Record<string, unknown>) => {
    config.metaCapi.accessToken = 'token-test';
    config.metaCapi.datasetId = 'dataset-test';
    mockedSend.mockImplementationOnce(actualProvider.sendPurchase);
    mockedPost.mockRejectedValueOnce(axiosFailure(400, { error: graphError }));
  };

  it.each([
    ['code 100 / subcode 2804003', { message: 'Invalid parameter', code: 100, error_subcode: 2804003, fbtrace_id: 'tr-9' }],
    [
      'error_user_title / error_user_msg',
      {
        message: 'Invalid parameter',
        code: 100,
        error_user_title: 'Event Timestamp Too Old',
        error_user_msg: 'The timestamp for this event is too far in the past.',
        fbtrace_id: 'tr-10'
      }
    ]
  ])('marks skipped (too_old) when Meta rejects the event as too old (%s)', async (_label, graphError) => {
    stubOrder(buildOrder({ customerName: 'Awa Diop', lineItems: [] }));
    sendThroughRealProvider(graphError);
    const update = spyUpdate({ _id: orderId });
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(processCapiPurchaseJob(buildJob())).resolves.toBeUndefined();

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      { $set: { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: 'too_old' } },
      expect.anything()
    );
    expect(createEvent).toHaveBeenCalledWith({
      orderId,
      type: OrderEventType.CAPI_PURCHASE_SKIPPED,
      metadata: { reason: 'too_old' }
    });
  });

  it('marks failed (not skipped) on another non-retryable Graph rejection', async () => {
    stubOrder(buildOrder({ customerName: 'Awa Diop', lineItems: [] }));
    sendThroughRealProvider({ message: 'Invalid parameter', code: 100, error_subcode: 2804050, fbtrace_id: 'tr-11' });
    const update = spyUpdate({ _id: orderId });
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await expect(processCapiPurchaseJob(buildJob())).rejects.toBeInstanceOf(UnrecoverableError);

    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      {
        $set: expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseFailureDefinitive: true })
      },
      expect.anything()
    );
  });

  it('does not mark failed on attempt 4 of 5 (a later attempt may still send)', async () => {
    stubOrder(buildOrder());
    const err = new MetaCapiError('Meta CAPI request failed: 500 boom', { status: 500, retryable: true, requestSent: true });
    mockedSend.mockRejectedValueOnce(err);
    const update = spyUpdate();
    const createEvent = jest.spyOn(OrderEvent, 'create');

    const before = Date.now();
    await expect(processCapiPurchaseJob(buildJob(3, 5))).rejects.toBe(err);

    expect(update).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    // Not final, but Meta may have recorded it: marked with the attempt date.
    expect(markWrite).toHaveBeenCalledTimes(1);
    const [filter, change] = markWrite.mock.calls[0] as [unknown, { $min: { capiPossiblyReceivedAt: Date } }];
    expect(filter).toEqual({ _id: orderId });
    expect(change.$min.capiPossiblyReceivedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(change.$min.capiPossiblyReceivedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('records nothing on a final failure when the status changed in the meantime', async () => {
    stubOrder(buildOrder());
    const err = new MetaCapiError('Meta CAPI request failed: 500 boom', { status: 500, retryable: true, requestSent: true });
    mockedSend.mockRejectedValueOnce(err);
    const update = spyUpdate(null);
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await expect(processCapiPurchaseJob(buildJob(4, 5))).rejects.toBe(err);

    expect(update).toHaveBeenCalledWith(
      { _id: orderId, capiPurchaseStatus: CapiPurchaseStatus.PENDING },
      expect.anything(),
      expect.anything()
    );
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('keeps the order of the skip reasons', () => {
    expect(getSkipReason(buildOrder({ isTest: true, customerConfirmationStatus: CustomerConfirmationStatus.PENDING }) as never)).toBe(
      'test'
    );

    config.metaCapi.enabled = false;
    expect(
      getSkipReason(buildOrder({ customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION }) as never)
    ).toBe('cancelled');
    expect(getSkipReason(buildOrder() as never)).toBe('disabled');
  });

  it('applies the 7 days minus 1 hour limit strictly', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const at = (ageMs: number) => buildOrder({ confirmedAt: new Date(now.getTime() - ageMs) }) as never;

    expect(getSkipReason(at(CAPI_MAX_EVENT_AGE_MS), now)).toBeUndefined();
    expect(getSkipReason(at(CAPI_MAX_EVENT_AGE_MS + 1), now)).toBe('too_old');
  });

  describe('failed listener', () => {
    const unrecoverable = (message: string) => {
      const err = new Error(message);
      err.name = 'UnrecoverableError';
      return err;
    };

    it.each([
      ['a job stalled beyond the limit', buildJob(1, 5), unrecoverable('job stalled more than allowable limit')],
      ['attempts exhausted by a MongoDB error', buildJob(5, 5), new Error('MongoNetworkError: connection closed')]
    ])('marks a pending order failed after %s', async (_label, job, err) => {
      const update = spyUpdate({ _id: orderId });
      const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

      await handleCapiPurchaseJobFailed(job, err);

      expect(update).toHaveBeenCalledWith(
        { _id: orderId.toString(), capiPurchaseStatus: CapiPurchaseStatus.PENDING },
        {
          $set: {
            capiPurchaseStatus: CapiPurchaseStatus.FAILED,
            capiPurchaseError: err.message,
            capiPurchaseFailedAt: expect.any(Date),
            capiPurchaseFailureDefinitive: false
          }
        },
        expect.anything()
      );
      expect(createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId,
          type: OrderEventType.CAPI_PURCHASE_FAILED,
          metadata: expect.objectContaining({ error: err.message })
        })
      );
      // Unknown whether the last attempt reached Meta: marked at the start of that attempt.
      expect(markWrite).toHaveBeenCalledWith(
        { _id: orderId.toString() },
        { $min: { capiPossiblyReceivedAt: new Date(job.processedOn as number) } }
      );
    });

    it('does not mark when the processor already recorded the failure', async () => {
      spyUpdate(null);

      await handleCapiPurchaseJobFailed(buildJob(1, 5), unrecoverable('Meta CAPI request failed: 400 bad'));

      expect(markWrite).not.toHaveBeenCalled();
    });

    it.each([3, 4])('does nothing while attempts remain (%i of 5 made)', async attemptsMade => {
      const update = spyUpdate();
      const createEvent = jest.spyOn(OrderEvent, 'create');

      await handleCapiPurchaseJobFailed(buildJob(attemptsMade, 5), new Error('MongoNetworkError'));

      expect(update).not.toHaveBeenCalled();
      expect(createEvent).not.toHaveBeenCalled();
    });

    it('records no duplicate event when the failure was already recorded', async () => {
      const update = spyUpdate(null);
      const createEvent = jest.spyOn(OrderEvent, 'create');

      await handleCapiPurchaseJobFailed(buildJob(1, 5), unrecoverable('Meta CAPI request failed: 400 nope'));

      expect(update).toHaveBeenCalledTimes(1);
      expect(createEvent).not.toHaveBeenCalled();
    });

    it('never throws, even when the write fails', async () => {
      jest.spyOn(Order, 'findOneAndUpdate').mockRejectedValue(new Error('mongo down') as never);

      await expect(handleCapiPurchaseJobFailed(buildJob(5, 5), new Error('boom'))).resolves.toBeUndefined();
      await expect(handleCapiPurchaseJobFailed(undefined, new Error('boom'))).resolves.toBeUndefined();
    });
  });

  it('never stores the access token in the error message', () => {
    config.metaCapi.accessToken = 'EAAsecretToken123';

    const message = toShortErrorMessage(
      new Error('failed with EAAsecretToken123 and access_token=otherToken456&x=1')
    );

    expect(message).not.toContain('EAAsecretToken123');
    expect(message).not.toContain('otherToken456');
    expect(toShortErrorMessage(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(300);
  });
});
