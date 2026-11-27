import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Message } from '../../models/Message';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import {
  CapiPurchaseStatus,
  CapiSkipReason,
  CustomerConfirmationStatus,
  DeliveryChannel,
  Order,
  OrderOperationalStatus
} from '../../models/Order';
import { enqueueCapiPurchaseWithOutcome } from '../../queues/capi.queue';
import config from '../config/env.config';
import log from '../logger/logger';
import {
  CAPI_PURCHASE_SWEEP_BATCH_SIZE,
  CAPI_PURCHASE_SWEEP_STALE_MS,
  CapiPurchaseResendError,
  resendCapiPurchase,
  runCapiPurchaseSweep,
  triggerCapiPurchase
} from './capiPurchase.service';
import { CAPI_MAX_EVENT_AGE_MS, CAPI_RESEND_DEDUP_WINDOW_MS, getOrderActionCapabilities } from './orderCapabilities.service';
import { OrderConfirmationService } from './orderConfirmation.service';
import { OrderFulfillmentService } from './orderFulfillment.service';

jest.mock('../../queues/capi.queue', () => ({
  enqueueCapiPurchase: jest.fn(),
  enqueueCapiPurchaseWithOutcome: jest.fn()
}));

jest.mock('../../queues/notification.queue', () => ({
  enqueueConfirmationReminder: jest.fn(),
  enqueueOrderCancelled: jest.fn(),
  enqueueOrderConfirmed: jest.fn()
}));

// The real pino logger writes through a pino-pretty worker thread that keeps Jest alive.
jest.mock('../logger/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

// The trigger and the resend enqueue through the outcome variant (reused job or added job).
const enqueue = jest.mocked(enqueueCapiPurchaseWithOutcome);
const enqueueWithOutcome = jest.mocked(enqueueCapiPurchaseWithOutcome);

type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; $min?: Record<string, unknown> };

// Any update that removes the Purchase status, or sets it back to empty, by any write path.
const clearsCapiStatus = (update: Update | undefined) =>
  Boolean(update) &&
  ('capiPurchaseStatus' in (update?.$unset ?? {}) ||
    ('capiPurchaseStatus' in (update?.$set ?? {}) && update?.$set?.capiPurchaseStatus == null));

// Every Order write method other than `findOneAndUpdate`: none of them may touch the status.
const OTHER_WRITES = ['updateOne', 'updateMany', 'findByIdAndUpdate'] as const;
const never = () => new Promise<never>(() => undefined);
// Lets the fire-and-forget trigger run its pending microtasks.
const flush = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => {
  jest.restoreAllMocks();
});

describe('triggerCapiPurchase', () => {
  const orderId = new Types.ObjectId();

  it('marks the Purchase pending only when no status exists or it was skipped as cancelled, then enqueues it', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    enqueue.mockResolvedValueOnce({} as never);

    await triggerCapiPurchase(orderId, 'confirmation');

    expect(update.mock.calls[0]).toEqual([
      {
        _id: orderId.toString(),
        $or: [
          { capiPurchaseStatus: { $exists: false } },
          {
            capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
            capiSkipReason: CapiSkipReason.CANCELLED,
            // Not when an attempt may have reached Meta 47 h or more ago.
            $or: [{ capiPossiblyReceivedAt: null }, { capiPossiblyReceivedAt: { $gt: expect.any(Date) } }]
          }
        ]
      },
      {
        $set: { capiPurchaseStatus: CapiPurchaseStatus.PENDING },
        $unset: { capiSkipReason: '', capiPurchaseError: '', capiPurchaseFailedAt: '', capiPurchaseFailureDefinitive: '' }
      },
      { new: true }
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(orderId.toString());
  });

  it('does nothing when a status already exists (pending, sent, failed or skipped)', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Order, 'findById').mockResolvedValue({ capiPurchaseStatus: CapiPurchaseStatus.SENT } as never);

    await triggerCapiPurchase(orderId, 'delivery');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps the order pending (never unset) and does not throw when the enqueue rejects', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    enqueue.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const otherWrites = OTHER_WRITES.map(method => jest.spyOn(Order, method).mockResolvedValue({} as never));

    await expect(triggerCapiPurchase(orderId, 'confirmation')).resolves.toBeUndefined();
    await flush();

    expect(update).toHaveBeenCalledTimes(1);
    expect(clearsCapiStatus(update.mock.calls[0]?.[1] as Update)).toBe(false);
    otherWrites.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: orderId.toString(), error: 'ECONNREFUSED' }),
      expect.any(String)
    );
  });

  it('treats a locked job (already active) as nothing to do', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    enqueue.mockRejectedValueOnce(new Error(`Job capi-purchase-${orderId} could not be removed because it is locked by another worker`));

    await expect(triggerCapiPurchase(orderId, 'delivery')).resolves.toBeUndefined();

    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a reused job (with its state) as reused, not as enqueued, and adds no job', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    enqueue.mockResolvedValueOnce({ job: {}, reused: true, state: 'active' } as never);

    await triggerCapiPurchase(orderId, 'confirmation');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { orderId: orderId.toString(), trigger: 'confirmation', jobState: 'active' },
      'CAPI purchase job reused, nothing enqueued'
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'CAPI purchase enqueued');
  });

  it('does not throw nor enqueue when the pending write fails', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockRejectedValue(new Error('mongo down') as never);

    await expect(triggerCapiPurchase(orderId, 'confirmation')).resolves.toBeUndefined();

    expect(enqueue).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('Meta Purchase across confirmation and delivery (real services)', () => {
  const orderId = new Types.ObjectId();
  type State = Record<string, unknown>;

  // In-memory order honouring the conditional writes, as MongoDB would.
  const matches = (state: State, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, condition]) => {
      if (key === '$or') {
        return (condition as Record<string, unknown>[]).some(branch => matches(state, branch));
      }

      if (key === '_id') {
        return String(condition) === String(state._id);
      }

      if (condition && typeof condition === 'object' && '$in' in condition) {
        return (condition.$in as unknown[]).includes(state[key]);
      }

      if (condition && typeof condition === 'object' && '$gt' in condition) {
        return state[key] instanceof Date && state[key].getTime() > (condition.$gt as Date).getTime();
      }

      if (condition && typeof condition === 'object' && '$exists' in condition) {
        return (state[key] !== undefined) === condition.$exists;
      }

      // `null` and `$ne` also match a missing field.
      if (condition === null) {
        return state[key] === null || state[key] === undefined;
      }

      if (condition && typeof condition === 'object' && '$ne' in condition) {
        return state[key] !== condition.$ne;
      }

      return state[key] === condition;
    });

  const useInMemoryOrder = (initial: State) => {
    const state: State = { _id: orderId, ...initial };
    const updates: Update[] = [];

    // Records and applies an update, whatever the write method used.
    const apply = (filter: Record<string, unknown>, update: Update) => {
      updates.push(update);

      if (!matches(state, filter)) {
        return false;
      }

      Object.assign(state, update.$set);
      Object.keys(update.$unset ?? {}).forEach(key => delete state[key]);
      Object.entries(update.$min ?? {}).forEach(([key, value]) => {
        if (state[key] === undefined || (value as Date) < (state[key] as Date)) {
          state[key] = value;
        }
      });
      return true;
    };

    jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((filter: State, update: Update) =>
      Promise.resolve(apply(filter, update) ? { ...state } : null)) as never);
    jest.spyOn(Order, 'findByIdAndUpdate').mockImplementation(((id: unknown, update: Update) =>
      Promise.resolve(apply({ _id: id }, update) ? { ...state } : null)) as never);
    jest.spyOn(Order, 'updateOne').mockImplementation(((filter: State, update: Update) =>
      Promise.resolve({ modifiedCount: apply(filter, update) ? 1 : 0 })) as never);
    jest.spyOn(Order, 'updateMany').mockImplementation(((filter: State, update: Update) =>
      Promise.resolve({ modifiedCount: apply(filter, update) ? 1 : 0 })) as never);
    jest.spyOn(Order, 'findById').mockImplementation((() => Promise.resolve({ ...state })) as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);

    return { state, updates };
  };

  const pendingOrder = {
    customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
    totalPrice: '25000',
    deliveryChannel: DeliveryChannel.INTERNAL
  };

  const startDelivery = (state: State) => {
    state.operationalStatus = OrderOperationalStatus.IN_DELIVERY;
  };

  it('confirmation then delivery: a single trigger, no second one at delivery', async () => {
    const { state } = useInMemoryOrder(pendingOrder);
    enqueue.mockResolvedValue({} as never);

    await OrderConfirmationService.confirmByAdmin(orderId.toString());
    await flush();
    startDelivery(state);
    await OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount: 25000 });
    await flush();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
  });

  it('delivery without confirmation: a single trigger', async () => {
    const { state } = useInMemoryOrder({ ...pendingOrder, operationalStatus: OrderOperationalStatus.IN_DELIVERY });
    enqueue.mockResolvedValue({} as never);

    await OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount: 25000 });
    await flush();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(orderId.toString());
    expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['never settles', never]
  ] as const)('confirmation (button and agent) and delivery answer normally when the enqueue %s', async (_label, outcome) => {
    enqueue.mockImplementation(outcome as never);

    const button = useInMemoryOrder(pendingOrder);
    const buttonResult = await OrderConfirmationService.confirmByWhatsAppButton(orderId.toString(), { buttonText: 'Confirmer' });
    await flush();
    expect(buttonResult.alreadyConfirmed).toBe(false);
    expect(button.state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
    expect(button.updates.some(clearsCapiStatus)).toBe(false);
    jest.restoreAllMocks();

    const agent = useInMemoryOrder(pendingOrder);
    const agentResult = await OrderConfirmationService.confirmByAdmin(orderId.toString());
    await flush();
    expect(agentResult.order).toEqual(expect.objectContaining({ customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }));
    expect(agent.state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
    expect(agent.updates.some(clearsCapiStatus)).toBe(false);
    jest.restoreAllMocks();

    const delivery = useInMemoryOrder({ ...pendingOrder, operationalStatus: OrderOperationalStatus.IN_DELIVERY });
    const delivered = await OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount: 25000 });
    await flush();
    expect(delivered).toEqual(expect.objectContaining({ operationalStatus: OrderOperationalStatus.DELIVERED }));
    expect(delivery.state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
    expect(delivery.updates.some(clearsCapiStatus)).toBe(false);
  });

  describe('second chance for a Purchase skipped as cancelled (C5.7)', () => {
    const skippedCancelled = {
      ...pendingOrder,
      customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION,
      capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
      capiSkipReason: CapiSkipReason.CANCELLED
    };

    it('agent confirmation of the reopened order: back to pending, reason cleared, one job', async () => {
      const { state } = useInMemoryOrder(skippedCancelled);
      enqueue.mockResolvedValue({} as never);

      await OrderConfirmationService.confirmByAdmin(orderId.toString());
      await flush();

      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(state).not.toHaveProperty('capiSkipReason');
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(orderId.toString());
    });

    it('delivery of the order: back to pending, reason cleared, one job', async () => {
      const { state } = useInMemoryOrder({
        ...skippedCancelled,
        customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED,
        operationalStatus: OrderOperationalStatus.IN_DELIVERY
      });
      enqueue.mockResolvedValue({} as never);

      await OrderFulfillmentService.deliver(orderId.toString(), { collectedAmount: 25000 });
      await flush();

      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(state).not.toHaveProperty('capiSkipReason');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('confirmation and delivery at the same time: a single reservation, a single job', async () => {
      const { state, updates } = useInMemoryOrder(skippedCancelled);
      enqueue.mockResolvedValue({} as never);
      const write = jest.mocked(Order.findOneAndUpdate);

      await Promise.all([triggerCapiPurchase(orderId, 'confirmation'), triggerCapiPurchase(orderId, 'delivery')]);
      await flush();

      // Both writes were attempted; only the first one applied (the second finds PENDING).
      expect(updates).toHaveLength(2);
      const results = await Promise.all(write.mock.results.map(result => result.value));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
    });

    it('S12: not taken back when an earlier attempt may have reached Meta 47 h or more ago', async () => {
      const possiblyReceivedAt = new Date(Date.now() - 50 * 60 * 60 * 1000);
      const { state } = useInMemoryOrder({ ...skippedCancelled, capiPossiblyReceivedAt: possiblyReceivedAt });
      enqueue.mockResolvedValue({} as never);

      await OrderConfirmationService.confirmByAdmin(orderId.toString());
      await flush();

      expect(state.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.SKIPPED);
      expect(state.capiSkipReason).toBe(CapiSkipReason.CANCELLED);
      expect(enqueue).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        { orderId: orderId.toString(), trigger: 'confirmation', capiPossiblyReceivedAt: possiblyReceivedAt },
        'CAPI purchase skipped as cancelled not taken back: Meta may have received it 47 h or more ago'
      );
    });

    it('taken back within 47 h of an attempt that may have reached Meta, the mark kept', async () => {
      const possiblyReceivedAt = new Date(Date.now() - 10 * 60 * 60 * 1000);
      const { state } = useInMemoryOrder({ ...skippedCancelled, capiPossiblyReceivedAt: possiblyReceivedAt });
      enqueue.mockResolvedValue({} as never);

      await OrderConfirmationService.confirmByAdmin(orderId.toString());
      await flush();

      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(state.capiPossiblyReceivedAt).toBe(possiblyReceivedAt);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['skipped as disabled', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.DISABLED }],
      ['skipped as test', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.TEST }],
      ['skipped as too_old', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.TOO_OLD }],
      ['failed', { capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseError: 'Meta 400' }],
      ['sent', { capiPurchaseStatus: CapiPurchaseStatus.SENT, capiPurchaseSentAt: new Date() }],
      ['pending', { capiPurchaseStatus: CapiPurchaseStatus.PENDING }]
    ])('a Purchase %s is not taken back by a confirmation nor a delivery', async (_label, capi) => {
      const { state } = useInMemoryOrder({ ...pendingOrder, ...capi });
      const before = { ...state };
      enqueue.mockResolvedValue({} as never);

      await triggerCapiPurchase(orderId, 'confirmation');
      await triggerCapiPurchase(orderId, 'delivery');
      await flush();

      expect(enqueue).not.toHaveBeenCalled();
      expect(state).toEqual(before);
    });
  });

  describe('resendCapiPurchase (admin)', () => {
    const actorId = new Types.ObjectId().toString();
    const originalEnabled = config.metaCapi.enabled;
    const recent = () => new Date(Date.now() - 60 * 60 * 1000);
    const confirmed = {
      ...pendingOrder,
      customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED
    };
    // As markFailed writes it: an ambiguous final failure (timeout) one hour ago.
    const failedRecently = () => ({
      capiPurchaseStatus: CapiPurchaseStatus.FAILED,
      capiPurchaseFailedAt: recent(),
      capiPurchaseFailureDefinitive: false
    });

    beforeEach(() => {
      config.metaCapi.enabled = true;
    });

    afterEach(() => {
      config.metaCapi.enabled = originalEnabled;
    });

    const expectRejected = async (promise: Promise<unknown>, code: string, status = 409) => {
      const error = await promise.then(
        () => undefined,
        (err: unknown) => err
      );
      expect(error).toBeInstanceOf(CapiPurchaseResendError);
      expect(error).toEqual(expect.objectContaining({ code, status }));
    };

    it('failed: back to pending, error cleared, one job, an event with the admin and the previous status', async () => {
      const { state } = useInMemoryOrder({
        ...confirmed,
        confirmedAt: recent(),
        ...failedRecently(),
        capiPurchaseError: 'Meta 400'
      });
      enqueue.mockResolvedValue({} as never);

      const order = await resendCapiPurchase(orderId.toString(), actorId);

      expect(order.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(state).not.toHaveProperty('capiPurchaseError');
      expect(state).not.toHaveProperty('capiPurchaseFailedAt');
      expect(state).not.toHaveProperty('capiPurchaseFailureDefinitive');
      expect(jest.mocked(Order.findOneAndUpdate).mock.calls[0]?.[0]).toEqual({
        _id: orderId,
        capiPurchaseStatus: CapiPurchaseStatus.FAILED,
        capiPurchaseFailedAt: expect.any(Date),
        capiPossiblyReceivedAt: null
      });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(orderId.toString());
      expect(OrderEvent.create).toHaveBeenCalledTimes(1);
      expect(OrderEvent.create).toHaveBeenCalledWith({
        orderId,
        type: OrderEventType.CAPI_PURCHASE_RESEND_REQUESTED,
        actorId: new Types.ObjectId(actorId),
        metadata: { previousStatus: CapiPurchaseStatus.FAILED }
      });
    });

    it.each([CapiSkipReason.CANCELLED, CapiSkipReason.DISABLED])(
      'skipped as %s: back to pending, reason cleared, one job',
      async reason => {
        const { state } = useInMemoryOrder({
          ...confirmed,
          confirmedAt: recent(),
          capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
          capiSkipReason: reason
        });
        enqueue.mockResolvedValue({} as never);

        await resendCapiPurchase(orderId.toString(), actorId);

        expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
        expect(state).not.toHaveProperty('capiSkipReason');
        expect(jest.mocked(Order.findOneAndUpdate).mock.calls[0]?.[0]).toEqual({
          _id: orderId,
          capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
          capiSkipReason: reason,
          capiPossiblyReceivedAt: null
        });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(OrderEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: OrderEventType.CAPI_PURCHASE_RESEND_REQUESTED,
            metadata: { previousStatus: CapiPurchaseStatus.SKIPPED, previousSkipReason: reason }
          })
        );
      }
    );

    it.each([
      ['CapiPurchaseAlreadySent', 'sent', { capiPurchaseStatus: CapiPurchaseStatus.SENT }],
      ['CapiPurchaseAlreadySent', 'sent date only', { ...failedRecently(), capiPurchaseSentAt: new Date() }],
      ['CapiPurchaseNotResendable', 'pending', { capiPurchaseStatus: CapiPurchaseStatus.PENDING }],
      ['CapiPurchaseNotResendable', 'without status', {}],
      ['CapiPurchaseNotResendable', 'skipped as test', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.TEST }],
      ['CapiPurchaseNotResendable', 'skipped as too_old', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.TOO_OLD }],
      ['CapiPurchaseNotResendable', 'skipped without reason', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED }],
      [
        'CapiPurchaseTooOld',
        'confirmed too long ago',
        { ...failedRecently(), confirmedAt: new Date(Date.now() - CAPI_MAX_EVENT_AGE_MS - 60_000) }
      ],
      [
        'CapiPurchaseTooOld',
        'delivered too long ago (no confirmation)',
        {
          capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
          capiSkipReason: CapiSkipReason.CANCELLED,
          deliveredAt: new Date(Date.now() - CAPI_MAX_EVENT_AGE_MS - 60_000)
        }
      ]
    ])('answers %s (%s) without any write, job or event', async (code, _label, capi) => {
      const { state } = useInMemoryOrder({ ...confirmed, confirmedAt: recent(), ...capi });
      if ('deliveredAt' in capi) {
        delete state.confirmedAt;
      }
      const before = { ...state };

      await expectRejected(resendCapiPurchase(orderId.toString(), actorId), code);

      expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
      expect(state).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();
      expect(OrderEvent.create).not.toHaveBeenCalled();
    });

    it.each([
      [
        'skipped as cancelled, order still cancelled',
        { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED, capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.CANCELLED }
      ],
      [
        'skipped as cancelled, order reopened (needs_attention)',
        { customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION, capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.CANCELLED }
      ],
      [
        'skipped as cancelled, cancelled on Shopify though confirmed',
        { shopifyCancelledAt: new Date(), capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.CANCELLED }
      ],
      ['failed, cancelled on Shopify', { shopifyCancelledAt: new Date(), ...failedRecently() }],
      ['failed, test order', { isTest: true, ...failedRecently() }],
      ['skipped as disabled, test order', { isTest: true, capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.DISABLED }]
    ])('answers CapiPurchaseNotResendable when the skip still holds (%s), without any write', async (_label, capi) => {
      const { state } = useInMemoryOrder({ ...confirmed, confirmedAt: recent(), ...capi });
      const before = { ...state };

      await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiPurchaseNotResendable');

      expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
      expect(state).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();
      expect(OrderEvent.create).not.toHaveBeenCalled();
    });

    it.each([
      ['now confirmed (automatic take-back missed)', { customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }],
      ['cancelled but delivered', { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED, deliveredAt: new Date() }]
    ])('accepts a Purchase skipped as cancelled whose reason no longer holds (%s)', async (_label, sale) => {
      const { state } = useInMemoryOrder({
        ...confirmed,
        confirmedAt: recent(),
        capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
        capiSkipReason: CapiSkipReason.CANCELLED,
        ...sale
      });
      enqueue.mockResolvedValue({} as never);

      await expect(resendCapiPurchase(orderId.toString(), actorId)).resolves.toEqual(
        expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.PENDING })
      );

      expect(state).not.toHaveProperty('capiSkipReason');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['failed', { ...failedRecently() }],
      ['skipped as disabled', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.DISABLED }]
    ])('still accepts %s on an order cancelled since (the worker decides again)', async (_label, capi) => {
      useInMemoryOrder({ ...confirmed, confirmedAt: recent(), customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED, ...capi });
      enqueue.mockResolvedValue({} as never);

      await expect(resendCapiPurchase(orderId.toString(), actorId)).resolves.toEqual(
        expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.PENDING })
      );
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('a failed history event does not fail the resend: logged, the order is pending and queued', async () => {
      const { state } = useInMemoryOrder({ ...confirmed, confirmedAt: recent(), ...failedRecently() });
      enqueue.mockResolvedValue({} as never);
      jest.mocked(OrderEvent.create).mockRejectedValueOnce(new Error('mongo write timeout') as never);

      await expect(resendCapiPurchase(orderId.toString(), actorId)).resolves.toEqual(
        expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.PENDING })
      );

      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        { orderId: orderId.toString(), actorId, error: 'mongo write timeout' },
        'Failed to record CAPI purchase resend event'
      );
    });

    describe('failed Purchase: resend only when Meta cannot have counted it', () => {
      const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

      it.each([
        ['certain refusal by Meta (4xx), long ago', { capiPurchaseFailedAt: hoursAgo(72), capiPurchaseFailureDefinitive: true }],
        ['ambiguous failure (timeout) less than 47 h ago', { capiPurchaseFailedAt: hoursAgo(46), capiPurchaseFailureDefinitive: false }]
      ])('accepts: %s', async (_label, failure) => {
        const { state } = useInMemoryOrder({
          ...confirmed,
          confirmedAt: hoursAgo(80),
          capiPurchaseStatus: CapiPurchaseStatus.FAILED,
          ...failure
        });
        enqueue.mockResolvedValue({} as never);
        // Same answer as the capability shown to the front.
        expect(getOrderActionCapabilities(state as never).canResendCapi).toBe(true);

        await expect(resendCapiPurchase(orderId.toString(), actorId)).resolves.toEqual(
          expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.PENDING })
        );
        expect(state).not.toHaveProperty('capiPurchaseFailedAt');
        expect(state).not.toHaveProperty('capiPurchaseFailureDefinitive');
        expect(enqueue).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['ambiguous failure exactly 47 h ago', { capiPurchaseFailedAt: new Date(Date.now() - CAPI_RESEND_DEDUP_WINDOW_MS), capiPurchaseFailureDefinitive: false }],
        ['ambiguous failure (timeout) 60 h ago', { capiPurchaseFailedAt: hoursAgo(60), capiPurchaseFailureDefinitive: false }],
        ['non-Meta error (write of sent failed) long ago', { capiPurchaseFailedAt: hoursAgo(100), capiPurchaseFailureDefinitive: false }],
        ['failure without date nor classification', {}]
      ])('answers CapiPurchaseMayHaveBeenReceived: %s, without any write', async (_label, failure) => {
        const { state } = useInMemoryOrder({
          ...confirmed,
          confirmedAt: hoursAgo(110),
          capiPurchaseStatus: CapiPurchaseStatus.FAILED,
          ...failure
        });
        const before = { ...state };
        expect(getOrderActionCapabilities(state as never).canResendCapi).toBe(false);

        await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiPurchaseMayHaveBeenReceived');

        expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
        expect(state).toEqual(before);
        expect(enqueue).not.toHaveBeenCalled();
        expect(OrderEvent.create).not.toHaveBeenCalled();
      });
    });

    describe('an attempt may have reached Meta (capiPossiblyReceivedAt)', () => {
      const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

      it.each([
        // S13 / S14: a certain refusal recorded last does not erase an earlier ambiguous attempt.
        ['failed, last error a certain refusal', { capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseFailedAt: hoursAgo(1), capiPurchaseFailureDefinitive: true }],
        ['failed, ambiguous failure recent', { capiPurchaseStatus: CapiPurchaseStatus.FAILED, capiPurchaseFailedAt: hoursAgo(1), capiPurchaseFailureDefinitive: false }],
        ['skipped as cancelled, order now confirmed', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.CANCELLED }],
        ['skipped as disabled', { capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.DISABLED }]
      ])('answers CapiPurchaseMayHaveBeenReceived 47 h or more after the first attempt (%s)', async (_label, capi) => {
        const { state } = useInMemoryOrder({ ...confirmed, confirmedAt: hoursAgo(2), ...capi, capiPossiblyReceivedAt: hoursAgo(72) });
        const before = { ...state };
        expect(getOrderActionCapabilities(state as never).canResendCapi).toBe(false);

        await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiPurchaseMayHaveBeenReceived');

        expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
        expect(state).toEqual(before);
        expect(enqueue).not.toHaveBeenCalled();
      });

      it('N13: MayHaveBeenReceived takes priority over TooOld', async () => {
        useInMemoryOrder({
          ...confirmed,
          confirmedAt: new Date(Date.now() - CAPI_MAX_EVENT_AGE_MS - 60_000),
          capiPurchaseStatus: CapiPurchaseStatus.FAILED,
          capiPurchaseFailedAt: hoursAgo(60),
          capiPurchaseFailureDefinitive: false,
          capiPossiblyReceivedAt: hoursAgo(170)
        });

        await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiPurchaseMayHaveBeenReceived');
      });

      it('S14: resent within 47 h of the first attempt, the mark is kept (never cleared)', async () => {
        const possiblyReceivedAt = hoursAgo(10);
        const { state } = useInMemoryOrder({
          ...confirmed,
          confirmedAt: hoursAgo(12),
          capiPurchaseStatus: CapiPurchaseStatus.FAILED,
          capiPurchaseFailedAt: hoursAgo(9),
          capiPurchaseFailureDefinitive: false,
          capiPossiblyReceivedAt: possiblyReceivedAt
        });
        enqueue.mockResolvedValue({} as never);
        expect(getOrderActionCapabilities(state as never).canResendCapi).toBe(true);

        await resendCapiPurchase(orderId.toString(), actorId);

        expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
        expect(state.capiPossiblyReceivedAt).toBe(possiblyReceivedAt);
        expect(jest.mocked(Order.findOneAndUpdate).mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({ capiPossiblyReceivedAt: possiblyReceivedAt })
        );

        // That resend fails in turn (even on a certain refusal): 62 h later it is refused.
        Object.assign(state, {
          capiPurchaseStatus: CapiPurchaseStatus.FAILED,
          capiPurchaseFailedAt: new Date(),
          capiPurchaseFailureDefinitive: true
        });
        expect(getOrderActionCapabilities(state as never, Date.now() + 62 * 60 * 60 * 1000).canResendCapi).toBe(false);
      });

      it('an attempt that may have reached Meta between the read and the write: 409, nothing enqueued', async () => {
        const { state } = useInMemoryOrder({
          ...confirmed,
          confirmedAt: recent(),
          capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
          capiSkipReason: CapiSkipReason.DISABLED,
          capiPossiblyReceivedAt: hoursAgo(1)
        });
        jest.spyOn(Order, 'findById').mockResolvedValue({ ...state, capiPossiblyReceivedAt: undefined } as never);

        await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiPurchaseNotResendable');

        expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.SKIPPED);
        expect(enqueue).not.toHaveBeenCalled();
      });
    });

    it('answers CapiPurchaseTooOld from the confirmation date even when the delivery is recent', async () => {
      useInMemoryOrder({
        ...confirmed,
        ...failedRecently(),
        confirmedAt: new Date(Date.now() - CAPI_MAX_EVENT_AGE_MS - 60_000),
        deliveredAt: recent()
      });

      await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiPurchaseTooOld');

      expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('answers within the 3 s bound when the enqueue never settles (Redis unreachable)', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const { state } = useInMemoryOrder({ ...confirmed, confirmedAt: recent(), ...failedRecently() });
        enqueue.mockImplementation(never as never);
        let settled = false;
        const resend = resendCapiPurchase(orderId.toString(), actorId).then(order => {
          settled = true;
          return order;
        });

        await jest.advanceTimersByTimeAsync(2_999);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);

        await expect(resend).resolves.toEqual(expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.PENDING }));
        expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
        expect(OrderEvent.create).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ orderId: orderId.toString(), error: 'Timed out after 3000 ms' }),
          expect.any(String)
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('answers CapiDisabled while CAPI is switched off, without any write', async () => {
      config.metaCapi.enabled = false;
      useInMemoryOrder({ ...confirmed, confirmedAt: recent(), capiPurchaseStatus: CapiPurchaseStatus.SKIPPED, capiSkipReason: CapiSkipReason.DISABLED });

      await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiDisabled');

      expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown or invalid order id', async () => {
      jest.spyOn(Order, 'findById').mockResolvedValue(null as never);
      const write = jest.spyOn(Order, 'findOneAndUpdate');

      await expectRejected(resendCapiPurchase(new Types.ObjectId().toString(), actorId), 'OrderNotFound', 404);
      await expectRejected(resendCapiPurchase('not-an-id', actorId), 'OrderNotFound', 404);

      expect(write).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('double click: the second conditional write does not apply, a single job and a single event', async () => {
      const { state } = useInMemoryOrder({
        ...confirmed,
        confirmedAt: recent(),
        ...failedRecently(),
        capiPurchaseError: 'Meta 400'
      });
      enqueue.mockResolvedValue({} as never);

      const results = await Promise.allSettled([
        resendCapiPurchase(orderId.toString(), actorId),
        resendCapiPurchase(orderId.toString(), actorId)
      ]);

      // Both requests read FAILED before any write: the guard is the conditional write itself.
      expect(Order.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toEqual(expect.objectContaining({ code: 'CapiPurchaseNotResendable', status: 409 }));
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(OrderEvent.create).toHaveBeenCalledTimes(1);
      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
    });

    it('a skip reason changed since the read (disabled read, too_old stored): nothing written nor enqueued', async () => {
      const { state } = useInMemoryOrder({
        ...confirmed,
        confirmedAt: recent(),
        capiPurchaseStatus: CapiPurchaseStatus.SKIPPED,
        capiSkipReason: CapiSkipReason.TOO_OLD
      });
      jest
        .spyOn(Order, 'findById')
        .mockResolvedValue({ ...state, capiSkipReason: CapiSkipReason.DISABLED } as never);

      await expectRejected(resendCapiPurchase(orderId.toString(), actorId), 'CapiPurchaseNotResendable');

      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.SKIPPED);
      expect(state.capiSkipReason).toBe(CapiSkipReason.TOO_OLD);
      expect(enqueue).not.toHaveBeenCalled();
      expect(OrderEvent.create).not.toHaveBeenCalled();
    });

    it('a failed enqueue does not fail the resend: the order stays pending for the sweep', async () => {
      const { state, updates } = useInMemoryOrder({ ...confirmed, confirmedAt: recent(), ...failedRecently() });
      enqueue.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(resendCapiPurchase(orderId.toString(), actorId)).resolves.toEqual(
        expect.objectContaining({ capiPurchaseStatus: CapiPurchaseStatus.PENDING })
      );

      expect(state.capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(updates).toHaveLength(1);
      expect(OrderEvent.create).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: orderId.toString(), error: 'ECONNREFUSED' }),
        expect.any(String)
      );
    });
  });
});

describe('runCapiPurchaseSweep', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60 * 1000);

  // `Order.find(filter).select().sort().limit()` applied to an in-memory collection.
  // Without `.sort()` the documents come back in collection order, as MongoDB may return them.
  const useOrders = (orders: { _id: Types.ObjectId; capiPurchaseStatus?: string; updatedAt: Date }[]) => {
    const limit = jest.fn<(n: number) => Promise<unknown>>();
    const find = jest.spyOn(Order, 'find').mockImplementation(((filter: {
      capiPurchaseStatus: string;
      updatedAt: { $lte: Date };
    }) => {
      let direction = 0;
      const query = {
        select: () => query,
        sort: (spec: { updatedAt?: number }) => {
          direction = spec.updatedAt ?? 0;
          return query;
        },
        limit: (n: number) => {
          limit(n);
          const matching = orders.filter(
            order => order.capiPurchaseStatus === filter.capiPurchaseStatus && order.updatedAt <= filter.updatedAt.$lte
          );
          const sorted = direction
            ? [...matching].sort((a, b) => direction * (a.updatedAt.getTime() - b.updatedAt.getTime()))
            : matching;
          return Promise.resolve(sorted.slice(0, n));
        }
      };
      return query;
    }) as never);

    return { find, limit };
  };

  const pendingSince = (minutes: number) => ({
    _id: new Types.ObjectId(),
    capiPurchaseStatus: CapiPurchaseStatus.PENDING,
    updatedAt: minutesAgo(minutes)
  });

  it('re-enqueues orders pending for more than 15 min and ignores recent or settled ones', async () => {
    const stale = { _id: new Types.ObjectId(), capiPurchaseStatus: CapiPurchaseStatus.PENDING, updatedAt: minutesAgo(16) };
    const recent = { _id: new Types.ObjectId(), capiPurchaseStatus: CapiPurchaseStatus.PENDING, updatedAt: minutesAgo(5) };
    const sent = { _id: new Types.ObjectId(), capiPurchaseStatus: CapiPurchaseStatus.SENT, updatedAt: minutesAgo(60) };
    const { find, limit } = useOrders([stale, recent, sent]);
    enqueueWithOutcome.mockResolvedValue({ job: {}, reused: false } as never);

    const result = await runCapiPurchaseSweep(now);

    expect(find.mock.calls[0]?.[0]).toEqual({
      capiPurchaseStatus: CapiPurchaseStatus.PENDING,
      updatedAt: { $lte: new Date(now.getTime() - CAPI_PURCHASE_SWEEP_STALE_MS) }
    });
    expect(limit).toHaveBeenCalledWith(CAPI_PURCHASE_SWEEP_BATCH_SIZE);
    expect(enqueueWithOutcome).toHaveBeenCalledTimes(1);
    expect(enqueueWithOutcome).toHaveBeenCalledWith(stale._id.toString());
    expect(result).toEqual({ candidates: 1, enqueued: 1, alreadyQueued: 0, failed: 0 });
  });

  it('handles the oldest pending orders first, so a full batch keeps the oldest ones', async () => {
    const orders = [pendingSince(20), pendingSince(240), pendingSince(60), pendingSince(30)];
    // One more than a batch: the extra, most recent order waits for the next run.
    const filler = Array.from({ length: CAPI_PURCHASE_SWEEP_BATCH_SIZE - orders.length }, () => pendingSince(90));
    const newest = pendingSince(16);
    useOrders([newest, ...orders, ...filler]);
    enqueueWithOutcome.mockResolvedValue({ job: {}, reused: false } as never);

    await runCapiPurchaseSweep(now);

    const handled = enqueueWithOutcome.mock.calls.map(call => call[0]);
    expect(handled).toHaveLength(CAPI_PURCHASE_SWEEP_BATCH_SIZE);
    expect(handled[0]).toBe(orders[1]._id.toString());
    expect(handled).not.toContain(newest._id.toString());
    expect(handled.slice(-3)).toEqual([orders[2], orders[3], orders[0]].map(order => order._id.toString()));
  });

  it('counts a job kept in the queue (retry in progress) apart from a job added', async () => {
    useOrders([pendingSince(20), pendingSince(30)]);
    enqueueWithOutcome
      .mockResolvedValueOnce({ job: {}, reused: true } as never)
      .mockResolvedValueOnce({ job: {}, reused: false } as never);

    const result = await runCapiPurchaseSweep(now);

    expect(result).toEqual({ candidates: 2, enqueued: 1, alreadyQueued: 1, failed: 0 });
    expect(log.info).toHaveBeenCalledWith(
      { candidates: 2, enqueued: 1, alreadyQueued: 1, failed: 0 },
      'CAPI purchase sweep completed'
    );
  });

  it('keeps going when one enqueue fails and counts a locked job as already handled', async () => {
    useOrders([pendingSince(40), pendingSince(30), pendingSince(20)]);
    enqueueWithOutcome
      .mockRejectedValueOnce(new Error('redis timeout'))
      .mockRejectedValueOnce(new Error('Job x could not be removed because it is locked by another worker'))
      .mockResolvedValueOnce({ job: {}, reused: false } as never);

    const result = await runCapiPurchaseSweep(now);

    expect(enqueueWithOutcome).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ candidates: 3, enqueued: 1, alreadyQueued: 1, failed: 1 });
  });
});
