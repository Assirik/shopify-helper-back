import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Message } from '../../models/Message';
import { OrderEvent } from '../../models/OrderEvent';
import { CapiPurchaseStatus, CustomerConfirmationStatus, DeliveryChannel, Order, OrderOperationalStatus } from '../../models/Order';
import { enqueueCapiPurchase, enqueueCapiPurchaseWithOutcome } from '../../queues/capi.queue';
import log from '../logger/logger';
import {
  CAPI_PURCHASE_SWEEP_BATCH_SIZE,
  CAPI_PURCHASE_SWEEP_STALE_MS,
  runCapiPurchaseSweep,
  triggerCapiPurchase
} from './capiPurchase.service';
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

const enqueue = jest.mocked(enqueueCapiPurchase);
const enqueueWithOutcome = jest.mocked(enqueueCapiPurchaseWithOutcome);

type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };

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

  it('marks the Purchase pending only when no status exists, then enqueues it', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    enqueue.mockResolvedValueOnce({} as never);

    await triggerCapiPurchase(orderId, 'confirmation');

    expect(update.mock.calls[0]).toEqual([
      { _id: orderId.toString(), capiPurchaseStatus: { $exists: false } },
      { $set: { capiPurchaseStatus: CapiPurchaseStatus.PENDING } },
      { new: true }
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(orderId.toString());
  });

  it('does nothing when a status already exists (pending, sent, failed or skipped)', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);

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
  const matches = (state: State, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, condition]) => {
      if (key === '_id') {
        return String(condition) === String(state._id);
      }

      if (condition && typeof condition === 'object' && '$in' in condition) {
        return (condition.$in as unknown[]).includes(state[key]);
      }

      if (condition && typeof condition === 'object' && '$exists' in condition) {
        return (state[key] !== undefined) === condition.$exists;
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
