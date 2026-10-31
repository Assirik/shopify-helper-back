import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { Job } from 'bullmq';
import * as bullmq from 'bullmq';
import { Types } from 'mongoose';

// End-to-end flow of the Meta Purchase (Chantier 5), on the real services, controllers,
// queue modules, worker and provider. Only the three boundaries are simulated: Mongoose
// (in-memory documents honouring the conditional writes), BullMQ (in-memory queues, jobs
// are run by hand) and axios (the Graph call is captured).

jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq') as typeof import('bullmq');

  interface FakeJob {
    id: string;
    name: string;
    queueName: string;
    data: Record<string, unknown>;
    opts: Record<string, unknown>;
    attemptsMade: number;
    state: string;
    getState: () => Promise<string>;
    remove: () => Promise<void>;
  }

  const queues = new Map<string, Map<string, FakeJob>>();
  const added: Array<{ queueName: string; name: string; id: string }> = [];
  const control = { failAddsOn: new Set<string>(), counter: 0 };
  const processors = new Map<string, (job: unknown) => Promise<unknown>>();

  class Queue {
    public readonly name: string;

    constructor(name: string) {
      this.name = name;
      if (!queues.has(name)) {
        queues.set(name, new Map());
      }
    }

    async add(name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) {
      if (control.failAddsOn.has(this.name)) {
        throw new Error('ECONNREFUSED');
      }

      const store = queues.get(this.name) as Map<string, FakeJob>;
      control.counter += 1;
      const id = typeof opts.jobId === 'string' ? opts.jobId : String(control.counter);
      const existing = store.get(id);

      // BullMQ silently ignores an add whose custom id already exists.
      if (existing) {
        return existing;
      }

      const job: FakeJob = {
        id,
        name,
        queueName: this.name,
        data,
        opts,
        attemptsMade: 0,
        state: opts.delay ? 'delayed' : 'waiting',
        getState: async () => job.state,
        remove: async () => {
          store.delete(id);
        }
      };

      store.set(id, job);
      added.push({ queueName: this.name, name, id });
      return job;
    }

    async getJob(id: string) {
      return queues.get(this.name)?.get(id);
    }
  }

  class Worker {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      processors.set(name, processor);
    }

    on() {
      return this;
    }

    async close() {
      return undefined;
    }
  }

  return { ...actual, Queue, Worker, __fake: { queues, added, control, processors } };
});

jest.mock('axios', () => {
  const actual = jest.requireActual('axios') as typeof import('axios');
  return {
    __esModule: true,
    default: { post: jest.fn(), get: jest.fn(), create: jest.fn(), isAxiosError: actual.isAxiosError }
  };
});

// The real pino logger writes through a pino-pretty worker thread that keeps Jest alive.
jest.mock('../utilities/logger/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import { WhatsAppWebhookController } from '../controllers/whatsappWebhook.controller';
import { ShopifyWebhookController } from '../controllers/shopifyWebhook.controller';
import { BrowserSession } from '../models/BrowserSession';
import { Customer } from '../models/Customer';
import { InboundWhatsAppEvent } from '../models/InboundWhatsAppEvent';
import { Message, MessageStatus, TemplatePurpose } from '../models/Message';
import {
  AttentionReasonCode,
  CapiPurchaseStatus,
  ConfirmationSource,
  CustomerConfirmationStatus,
  NotificationStatus,
  Order,
  OrderOperationalStatus
} from '../models/Order';
import { OrderEvent, OrderEventType } from '../models/OrderEvent';
import { Product } from '../models/Product';
import { WebhookEvent } from '../models/WebhookEvent';
import config from '../utilities/config/env.config';
import { runCapiPurchaseSweep } from '../utilities/services/capiPurchase.service';
import { ChatwootForwardService } from '../utilities/services/chatwootForward.service';
import { ChatwootOutboundMirrorService } from '../utilities/services/chatwootOutboundMirror.service';
import { MessageVariableConfigService } from '../utilities/services/messageVariableConfig.service';
import { OrderConfirmationService } from '../utilities/services/orderConfirmation.service';
import { OrderFulfillmentService } from '../utilities/services/orderFulfillment.service';
import { processCapiPurchaseJob } from '../workers/capiPurchase.worker';
import { processInitialConfirmationRequest, startNotificationWorker } from '../workers/notification.worker';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;

interface FakeJob {
  id: string;
  name: string;
  queueName: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  attemptsMade: number;
  state: string;
}

const fake = (bullmq as unknown as {
  __fake: {
    queues: Map<string, Map<string, FakeJob>>;
    added: Array<{ queueName: string; name: string; id: string }>;
    control: { failAddsOn: Set<string>; counter: number };
    processors: Map<string, (job: unknown) => Promise<unknown>>;
  };
}).__fake;

const mockedPost = axios.post as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const flush = () => new Promise(resolve => setImmediate(resolve));
const MINUTE = 60 * 1000;

const ORDER_PHONE_E164 = '+221776986780';
const CUSTOMER_ID = new Types.ObjectId('64b7f0c2a1b2c3d4e5f60718');
const SHOPIFY_ORDER_ID = 9001;
const ORDER_NAME = '#1201';

// --- In-memory MongoDB ---------------------------------------------------------------------

const matchesCondition = (key: string, value: unknown, condition: unknown): boolean => {
  if (key === '_id') {
    return String(value) === String(condition);
  }

  if (condition === null) {
    return value === null || value === undefined;
  }

  if (condition && typeof condition === 'object' && !(condition instanceof Date) && !(condition instanceof Types.ObjectId)) {
    return Object.entries(condition).every(([operator, argument]) => {
      switch (operator) {
        // `$ne` and `$nin` also match a missing field, as in MongoDB.
        case '$in':
          return (argument as unknown[]).includes(value);
        case '$nin':
          return !(argument as unknown[]).includes(value ?? null);
        case '$ne':
          return value !== argument;
        case '$exists':
          return (value !== undefined) === argument;
        case '$lte':
          return value instanceof Date && value.getTime() <= (argument as Date).getTime();
        default:
          throw new Error(`Unsupported operator in the in-memory MongoDB: ${operator}`);
      }
    });
  }

  return value === condition;
};

const matches = (doc: Doc, filter: Record<string, unknown>) =>
  Object.entries(filter).every(([key, condition]) => matchesCondition(key, doc[key], condition));

// Mongoose strict mode: a path missing from the schema is silently dropped from an update.
const inSchema = (model: { schema: { pathType: (path: string) => string } }, key: string) =>
  model.schema.pathType(key) !== 'adhocOrUndefined';

// A document as the real schema builds it (defaults applied, unknown fields dropped, no
// timestamps: Mongoose adds those on save).
const fromSchema = (Model: new (input: Doc) => { toObject: () => Doc }, input: Doc): Doc => {
  const now = new Date();
  return { ...new Model(input).toObject(), createdAt: now, updatedAt: now };
};

const applyUpdate = (doc: Doc, update: Doc, model: { schema: { pathType: (path: string) => string } } = Order) => {
  const known = (record: Doc = {}) => Object.fromEntries(Object.entries(record).filter(([key]) => inSchema(model, key)));
  Object.assign(doc, known(update.$set));
  Object.keys(known(update.$unset)).forEach(key => delete doc[key]);
  Object.entries(known(update.$inc)).forEach(([key, amount]) => {
    doc[key] = (doc[key] ?? 0) + (amount as number);
  });
  Object.entries(known(update.$push)).forEach(([key, value]) => {
    doc[key] = [...(doc[key] ?? []), value];
  });
  // Mongoose timestamps: every write bumps updatedAt.
  doc.updatedAt = new Date();
};

describe('Meta Purchase, end to end (C5)', () => {
  const originalCapi = { ...config.metaCapi };
  const originalWhatsApp = { ...config.metaWhatsApp };
  let orders: Map<string, Doc>;
  let events: Doc[];
  let messages: Doc[];
  let inboundEvents: Doc[];
  let browserSession: Doc | null;
  let orderCreatedAt: Date;
  let webhookCounter = 0;
  let inboundCounter = 0;

  const queue = (name: string) => [...(fake.queues.get(name)?.values() ?? [])];
  const addedTo = (name: string) => fake.added.filter(entry => entry.queueName === name);
  const capiJobs = () => queue('capi-purchase');
  const stored = (id: string) => orders.get(id) as Doc;
  const eventCount = (type: OrderEventType) => events.filter(event => event.type === type).length;
  const messageCount = (purpose: TemplatePurpose) => messages.filter(message => message.templatePurpose === purpose).length;
  // Conversions API calls (`/events`) and WhatsApp template sends (`/messages`) share axios.
  const capiCalls = () => mockedPost.mock.calls.filter(call => String(call[0]).endsWith('/events'));
  const whatsappCalls = () => mockedPost.mock.calls.filter(call => String(call[0]).endsWith('/messages'));

  // Live document with `save`, as a Mongoose document read from the database.
  const snapshot = (doc: Doc): Doc => {
    const copy: Doc = { ...doc };
    copy.save = async () => {
      const { save: _save, ...fields } = copy;
      Object.assign(doc, fields);
      doc.updatedAt = new Date();
      return copy;
    };
    return copy;
  };

  const findAll = (filter: Record<string, unknown>) => [...orders.values()].filter(doc => matches(doc, filter));

  beforeEach(() => {
    orders = new Map();
    events = [];
    messages = [];
    inboundEvents = [];
    browserSession = null;
    orderCreatedAt = new Date();
    fake.queues.forEach(store => store.clear());
    fake.added.length = 0;
    fake.control.failAddsOn.clear();

    Object.assign(config.metaCapi, {
      enabled: true,
      datasetId: '999',
      accessToken: 'token-flow',
      graphApiVersion: 'v26.0',
      fxXofEur: 655.957,
      testEventCode: ''
    });
    mockedPost.mockImplementation(async (url: unknown) =>
      String(url).endsWith('/events')
        ? { data: { events_received: 1, fbtrace_id: 'trace-flow' } }
        : { data: { messages: [{ id: 'wamid.out.flow' }] } }
    );
    Object.assign(config.metaWhatsApp, { accessToken: 'wa-token-flow', phoneNumberId: '555', templateName: 'confirm_order_flow' });
    inboundCounter = 0;

    jest.spyOn(Order, 'create').mockImplementation((async (input: Doc) => {
      const doc = fromSchema(Order as never, input);
      orders.set(String(doc._id), doc);
      return { ...doc };
    }) as never);
    jest.spyOn(Order, 'findOne').mockImplementation(((filter: Record<string, unknown>) => {
      const found = findAll(filter)[0];
      const result = found ? snapshot(found) : null;
      return Object.assign(Promise.resolve(result), { sort: () => Promise.resolve(result) });
    }) as never);
    jest
      .spyOn(Order, 'findById')
      .mockImplementation(((id: unknown) => {
        const found = orders.get(String(id));
        return Promise.resolve(found ? snapshot(found) : null);
      }) as never);
    jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((filter: Record<string, unknown>, update: Doc) =>
      Promise.resolve().then(() => {
        const found = findAll(filter)[0];
        if (!found) {
          return null;
        }
        applyUpdate(found, update);
        return snapshot(found);
      })) as never);
    jest.spyOn(Order, 'findByIdAndUpdate').mockImplementation(((id: unknown, update: Doc) =>
      Promise.resolve().then(() => {
        const found = orders.get(String(id));
        if (!found) {
          return null;
        }
        applyUpdate(found, update);
        return snapshot(found);
      })) as never);
    jest.spyOn(Order, 'updateOne').mockImplementation(((filter: Record<string, unknown>, update: Doc) =>
      Promise.resolve().then(() => {
        const found = findAll(filter)[0];
        if (found) {
          applyUpdate(found, update);
        }
        return { modifiedCount: found ? 1 : 0 };
      })) as never);
    jest.spyOn(Order, 'exists').mockImplementation(((filter: Record<string, unknown>) =>
      Promise.resolve(findAll(filter)[0] ? { _id: findAll(filter)[0]._id } : null)) as never);
    jest.spyOn(Order, 'find').mockImplementation(((filter: Record<string, unknown>) => {
      const chain = {
        select: () => chain,
        sort: () => chain,
        limit: () => Promise.resolve(findAll(filter).map(doc => ({ _id: doc._id })))
      };
      return chain;
    }) as never);

    jest.spyOn(OrderEvent, 'create').mockImplementation((async (input: Doc) => {
      events.push(input);
      return input;
    }) as never);
    jest.spyOn(Message, 'create').mockImplementation((async (input: Doc) => {
      const message = fromSchema(Message as never, input);
      messages.push(message);
      return { ...message };
    }) as never);
    jest.spyOn(Message, 'find').mockResolvedValue([] as never);
    jest.spyOn(Message, 'findOne').mockImplementation(((filter: Doc) =>
      Promise.resolve(
        messages.find(message => String(message.orderId) === String(filter.orderId) && message.templatePurpose === filter.templatePurpose) ??
          null
      )) as never);
    jest.spyOn(Message, 'findById').mockImplementation(((id: unknown) =>
      Promise.resolve(messages.find(message => String(message._id) === String(id)) ?? null)) as never);
    jest.spyOn(Message, 'findByIdAndUpdate').mockImplementation(((id: unknown, update: Doc) =>
      Promise.resolve().then(() => {
        const found = messages.find(message => String(message._id) === String(id));
        if (!found) {
          return null;
        }
        applyUpdate(found, update, Message);
        return { ...found };
      })) as never);
    jest.spyOn(Message, 'updateOne').mockImplementation(((filter: Doc, update: Doc) =>
      Promise.resolve().then(() => {
        const found = messages.find(message => matches(message, filter));
        if (found) {
          applyUpdate(found, update, Message);
        }
        return { modifiedCount: found ? 1 : 0 };
      })) as never);
    jest.spyOn(Customer, 'findById').mockResolvedValue(null as never);
    jest.spyOn(MessageVariableConfigService, 'resolveForRegion').mockResolvedValue({} as never);
    jest.spyOn(ChatwootOutboundMirrorService, 'mirrorTemplateMessage').mockResolvedValue(undefined as never);

    jest.spyOn(WebhookEvent, 'findOne').mockResolvedValue(null as never);
    jest.spyOn(WebhookEvent, 'create').mockImplementation((async () => ({ _id: new Types.ObjectId(), status: 'processed' })) as never);
    jest.spyOn(Customer, 'findOneAndUpdate').mockResolvedValue({ _id: CUSTOMER_ID, save: async () => undefined } as never);
    jest.spyOn(Product, 'findOneAndUpdate').mockImplementation((async () => ({ variants: [], save: async () => undefined })) as never);
    jest.spyOn(BrowserSession, 'findOne').mockImplementation(((filter: Doc) => {
      const result = browserSession && browserSession.phoneE164 === filter.phoneE164 ? browserSession : null;
      const query = { maxTimeMS: () => query, lean: () => Promise.resolve(result) };
      return query;
    }) as never);

    jest.spyOn(InboundWhatsAppEvent, 'exists').mockImplementation(((filter: Doc) =>
      Promise.resolve(
        inboundEvents.some(event => event.waMessageId === filter.waMessageId && (!filter.type || event.type === filter.type)) ? { _id: 1 } : null
      )) as never);
    jest.spyOn(InboundWhatsAppEvent, 'create').mockImplementation((async (input: Doc) => {
      inboundEvents.push(input);
      return input;
    }) as never);
    jest.spyOn(ChatwootForwardService, 'forwardWhatsAppPayload').mockResolvedValue(true as never);
  });

  afterEach(() => {
    Object.assign(config.metaCapi, originalCapi);
    Object.assign(config.metaWhatsApp, originalWhatsApp);
    jest.restoreAllMocks();
    mockedPost.mockReset();
  });

  // --- Entry points: the real controllers ----------------------------------------------------

  const captureFromTheBrowser = () => {
    browserSession = {
      phoneE164: ORDER_PHONE_E164,
      fbp: 'fb.1.1730000000000.111',
      fbc: 'fb.1.1730000000000.abc',
      fbclid: 'abc',
      userAgent: 'Mozilla/5.0 (Flow)',
      pageUrl: 'https://shop.example.com/products/x',
      ip: '41.82.10.5',
      updatedAt: new Date(orderCreatedAt.getTime() - 2 * MINUTE)
    };
  };

  const shopifyPayload = () => ({
    id: SHOPIFY_ORDER_ID,
    name: ORDER_NAME,
    created_at: orderCreatedAt.toISOString(),
    // 14 000 XOF of articles + 3 000 XOF of delivery: only the articles are sent to Meta.
    subtotal_price: '14000',
    total_price: '17000',
    total_discounts: '0',
    currency: 'XOF',
    phone: '77 698 67 80',
    browser_ip: '41.82.10.5',
    customer: { id: 5001, first_name: 'Aïssatou', last_name: 'Diallo' },
    shipping_address: { province: 'Thiès', city: 'Thiès', address1: 'Quartier Randoulène' },
    payment_gateway_names: ['Cash on Delivery (COD)'],
    note_attributes: [
      { name: 'utm_campaign', value: 'camp-1' },
      { name: 'utm_source', value: 'facebook' },
      { name: 'full_url', value: 'https://shop.example.com/products/x?fbclid=FBCLID1' }
    ],
    line_items: [
      { id: 1, product_id: 'p-1', variant_id: 'v-1', title: 'Robe', quantity: 2, price: '5000' },
      { id: 2, product_id: 'p-2', title: 'Foulard', quantity: 1, price: '4000' }
    ]
  });

  const ingest = async () => {
    webhookCounter += 1;
    const body = shopifyPayload();
    const headers: Record<string, string> = { 'x-shopify-webhook-id': `wh-flow-${webhookCounter}` };
    const req = {
      body,
      rawBody: Buffer.from(JSON.stringify(body)),
      get: (name: string) => headers[name.toLowerCase()]
    } as unknown as Request;
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      }
    };

    await ShopifyWebhookController.ordersCreate(req, res as unknown as Response);
    await flush();
    expect(res.statusCode).toBe(202);
    const orderId = String((res.body as { orderId: unknown }).orderId);
    expect(orders.has(orderId)).toBe(true);
    return orderId;
  };

  const whatsapp = async (message: Record<string, unknown>, waMessageId?: string) => {
    inboundCounter += 1;
    const req = {
      body: {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { messages: [{ id: waMessageId ?? `wamid.flow.${inboundCounter}`, ...message }] } }] }]
      }
    } as unknown as Request;
    const json = jest.fn((_body: unknown) => undefined);
    const res = { status: jest.fn((_code: number) => ({ json })) } as unknown as Response;

    await WhatsAppWebhookController.receive(req, res);
    await flush();
    return json.mock.calls[0]?.[0] as { accepted: boolean; inboundEvents: number; duplicates: number };
  };

  const prefilledText = (from: string, waMessageId?: string) =>
    whatsapp({ from, type: 'text', text: { body: `Je confirme ma commande ${ORDER_NAME}` } }, waMessageId);
  const pressConfirm = (orderId: string) =>
    whatsapp({ from: '221776986780', type: 'button', button: { payload: `CONFIRM_ORDER:${orderId}`, text: 'Confirmer' } });

  // --- Jobs: run by hand, as the BullMQ workers would ----------------------------------------

  const asJob = (job: FakeJob) => job as unknown as Job<any>;
  const runCapiJob = async () => {
    const [job] = capiJobs();
    expect(job).toBeDefined();
    await processCapiPurchaseJob(asJob(job));
    job.state = 'completed';
    await flush();
  };
  const runInitialRequest = async () => {
    const [job] = queue('notifications').filter(entry => entry.name === 'sendInitialConfirmationRequest');
    expect(job).toBeDefined();
    await processInitialConfirmationRequest(asJob(job));
    job.state = 'completed';
    await flush();
  };
  // The send job handed over by the delayed request, through the processor registered by the real worker.
  const runSendOrderConfirmation = async () => {
    startNotificationWorker();
    const processor = fake.processors.get('notifications');
    const [job] = queue('notifications').filter(entry => entry.name === 'sendOrderConfirmation');
    expect(processor).toBeDefined();
    expect(job).toBeDefined();
    await (processor as (job: unknown) => Promise<unknown>)(job);
    job.state = 'completed';
    await flush();
    return job;
  };

  const startDelivery = (orderId: string) => {
    stored(orderId).operationalStatus = OrderOperationalStatus.IN_DELIVERY;
  };
  const deliver = async (orderId: string) => {
    await OrderFulfillmentService.deliver(orderId, { collectedAmount: 17000 });
    await flush();
  };

  const expectOnePurchase = (expected: { actionSource: string }) => {
    expect(capiCalls()).toHaveLength(1);
    const [url, body, options] = capiCalls()[0] as [string, Doc, Doc];
    expect(url).toBe('https://graph.facebook.com/v26.0/999/events');
    expect(options).toEqual(expect.objectContaining({ timeout: 10_000 }));
    expect(body.access_token).toBe('token-flow');
    expect(body).not.toHaveProperty('test_event_code');
    expect(body.data).toHaveLength(1);

    const [purchase] = body.data as Doc[];
    expect(purchase.event_name).toBe('Purchase');
    expect(purchase.event_id).toBe(`purchase_${SHOPIFY_ORDER_ID}`);
    expect(purchase.action_source).toBe(expected.actionSource);
    // 14 000 XOF of articles (delivery excluded) at 655.957 XOF per EUR.
    expect(purchase.custom_data).toEqual({
      currency: 'EUR',
      value: 21.34,
      contents: [
        { id: 'v-1', quantity: 2, item_price: 7.62 },
        { id: 'p-2', quantity: 1, item_price: 6.1 }
      ],
      content_type: 'product'
    });
    expect(purchase.user_data.ph).toEqual([sha('221776986780')]);
    expect(purchase.user_data.client_ip_address).toBe('41.82.10.5');
    expect(JSON.stringify(body)).not.toContain('221776986780');
    expect(JSON.stringify(purchase)).not.toContain('"em"');
    return purchase;
  };

  const expectSentOnOrder = (orderId: string) => {
    const order = stored(orderId);
    expect(order.capiPurchaseStatus).toBe(CapiPurchaseStatus.SENT);
    expect(order.capiEventId).toBe(`purchase_${SHOPIFY_ORDER_ID}`);
    expect(order.capiValueEur).toBe(21.34);
    expect(order.capiFxRate).toBe(655.957);
    expect(eventCount(OrderEventType.CAPI_PURCHASE_SENT)).toBe(1);
  };

  const expectNoPurchase = (orderId: string) => {
    expect(stored(orderId).capiPurchaseStatus).toBeUndefined();
    expect(addedTo('capi-purchase')).toEqual([]);
    expect(capiCalls()).toEqual([]);
    expect(eventCount(OrderEventType.CAPI_PURCHASE_SENT)).toBe(0);
  };

  // --- Scenarios -------------------------------------------------------------------------------

  describe('pre-filled message from the order number', () => {
    it('ingestion, pre-filled message, CAPI trigger, worker, delivery: a single Purchase from the website', async () => {
      captureFromTheBrowser();
      const orderId = await ingest();

      // Ingestion: ad origin and browser signals on the order, only the delayed T+5 job queued.
      expect(stored(orderId)).toEqual(
        expect.objectContaining({
          customerPhoneE164: ORDER_PHONE_E164,
          campaignId: 'camp-1',
          utmSource: 'facebook',
          fbclid: 'FBCLID1',
          capiFbp: 'fb.1.1730000000000.111',
          capiFbc: 'fb.1.1730000000000.abc',
          capiClientUserAgent: 'Mozilla/5.0 (Flow)',
          customerConfirmationStatus: CustomerConfirmationStatus.PENDING
        })
      );
      expect(queue('notifications').map(job => [job.name, job.id, job.state])).toEqual([
        ['sendInitialConfirmationRequest', `confirm-initial-${orderId}`, 'delayed']
      ]);
      expect(messages).toEqual([]);

      // The customer sends the pre-filled message from the order phone: confirmed through the button path.
      const WAMID = 'wamid.flow.prefilled';
      expect(await prefilledText('221776986780', WAMID)).toEqual(expect.objectContaining({ inboundEvents: 1, duplicates: 0 }));

      expect(stored(orderId)).toEqual(
        expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
          confirmationSource: ConfirmationSource.WHATSAPP_BUTTON,
          operationalStatus: OrderOperationalStatus.TO_DELIVER,
          capiPurchaseStatus: CapiPurchaseStatus.PENDING
        })
      );
      expect(eventCount(OrderEventType.CONFIRMED)).toBe(1);
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMED)).toBe(1);
      expect(capiJobs().map(job => job.id)).toEqual([`capi-purchase-${orderId}`]);
      expect(mockedPost).not.toHaveBeenCalled();

      // Meta redelivers the very same message (same wamid): detected as a duplicate, nothing is written or mirrored again.
      const forward = ChatwootForwardService.forwardWhatsAppPayload as unknown as jest.Mock;
      const writes = () => (Order.findOneAndUpdate as unknown as jest.Mock).mock.calls.length;
      const before = { inbound: inboundEvents.length, events: events.length, messages: messages.length, writes: writes(), forward: forward.mock.calls.length };
      expect(inboundEvents.filter(event => event.waMessageId === WAMID)).toHaveLength(1);

      expect(await prefilledText('221776986780', WAMID)).toEqual({ accepted: true, inboundEvents: 0, updatedStatusCount: 0, duplicates: 1 });

      expect({ inbound: inboundEvents.length, events: events.length, messages: messages.length, writes: writes(), forward: forward.mock.calls.length }).toEqual(before);
      // A press of the button on the confirmed order does nothing more either.
      await pressConfirm(orderId);
      expect(addedTo('capi-purchase')).toHaveLength(1);
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMED)).toBe(1);

      // The delayed request finds the order confirmed: nothing is sent to the customer.
      await runInitialRequest();
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMATION_REQUEST)).toBe(0);
      expect(queue('notifications').filter(job => job.name === 'sendOrderConfirmation')).toEqual([]);
      expect(stored(orderId).notificationStatus).toBe(NotificationStatus.SKIPPED);
      expect(stored(orderId).reminderCount).toBe(0);

      // Worker: the Graph call is made once, the result recorded.
      await runCapiJob();
      const purchase = expectOnePurchase({ actionSource: 'website' });
      expect(purchase.user_data).toEqual(
        expect.objectContaining({
          client_user_agent: 'Mozilla/5.0 (Flow)',
          fbp: 'fb.1.1730000000000.111',
          fbc: 'fb.1.1730000000000.abc',
          external_id: [sha(CUSTOMER_ID.toString())]
        })
      );
      expect(purchase.event_source_url).toBe('https://shop.example.com/products/x');
      expectSentOnOrder(orderId);

      // Delivery: the fallback trigger finds the Purchase already handled; a replayed job does nothing either.
      startDelivery(orderId);
      await deliver(orderId);
      await processCapiPurchaseJob(asJob(capiJobs()[0]));

      expect(stored(orderId).operationalStatus).toBe(OrderOperationalStatus.DELIVERED);
      expect(addedTo('capi-purchase')).toHaveLength(1);
      expect(capiCalls()).toHaveLength(1);
      expectSentOnOrder(orderId);
    });

    it('without a browser capture the Purchase leaves as a chat event and invents no user agent', async () => {
      const orderId = await ingest();
      expect(stored(orderId).capiClientUserAgent).toBeUndefined();

      await prefilledText('221776986780');
      await runCapiJob();

      const purchase = expectOnePurchase({ actionSource: 'chat' });
      expect(purchase.user_data).not.toHaveProperty('client_user_agent');
      expect(purchase.user_data).not.toHaveProperty('fbp');
      // Rebuilt from the full_url fbclid and the order creation date.
      expect(purchase.user_data.fbc).toBe(`fb.1.${stored(orderId).createdAt.getTime()}.FBCLID1`);
      expectSentOnOrder(orderId);
    });

    it('from another number: no confirmation, phone_mismatch, no Purchase, and the T+5 request still goes out', async () => {
      captureFromTheBrowser();
      const orderId = await ingest();

      await prefilledText('221771112233');
      await prefilledText('221771112233');

      expect(stored(orderId)).toEqual(
        expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
          needsHelpdeskAttention: true,
          attentionReasonCode: AttentionReasonCode.PHONE_MISMATCH
        })
      );
      expect(stored(orderId).confirmedAt).toBeUndefined();
      expect(stored(orderId).operationalStatus).toBeUndefined();
      // The gap is counted once per order.
      expect(eventCount(OrderEventType.PHONE_MISMATCH)).toBe(1);
      expect(eventCount(OrderEventType.CONFIRMED)).toBe(0);
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMED)).toBe(0);
      expectNoPurchase(orderId);

      // The order is still pending: the delayed request is handed over despite the flag, without touching reminderCount.
      await runInitialRequest();
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMATION_REQUEST)).toBe(1);
      expect(queue('notifications').filter(job => job.name === 'sendOrderConfirmation')).toHaveLength(1);
      expect(stored(orderId).reminderCount).toBe(0);
      expect(whatsappCalls()).toEqual([]);

      // ...and the send job really reaches the customer: the template with the confirm button goes to Meta.
      await runSendOrderConfirmation();
      expect(whatsappCalls()).toHaveLength(1);
      const [url, body] = whatsappCalls()[0] as [string, Doc];
      expect(url).toBe('https://graph.facebook.com/v26.0/555/messages');
      expect(body.to).toBe('221776986780');
      expect(body.template.name).toBe('confirm_order_flow');
      expect(JSON.stringify(body)).toContain(`CONFIRM_ORDER:${orderId}`);
      const request = messages.find(message => message.templatePurpose === TemplatePurpose.ORDER_CONFIRMATION_REQUEST) as Doc;
      expect(request.status).toBe(MessageStatus.SENT);
      expect(request.providerMessageId).toBe('wamid.out.flow');
      expect(stored(orderId).notificationStatus).toBe(NotificationStatus.SENT);
      // Still pending, still flagged, still no reminder consumed, still no Purchase.
      expect(stored(orderId)).toEqual(
        expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
          attentionReasonCode: AttentionReasonCode.PHONE_MISMATCH,
          reminderCount: 0
        })
      );
      expectNoPurchase(orderId);
    });
  });

  describe('order cancelled by an agent', () => {
    it('press, pre-filled message, press: never confirmed and no Purchase', async () => {
      captureFromTheBrowser();
      const orderId = await ingest();

      await OrderConfirmationService.cancelByAdmin(orderId, 'Client injoignable depuis 3 jours');
      expect(stored(orderId).customerConfirmationStatus).toBe(CustomerConfirmationStatus.CANCELLED);

      await pressConfirm(orderId);
      expect(stored(orderId)).toEqual(
        expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.NEEDS_ATTENTION,
          attentionReasonCode: AttentionReasonCode.LATE_CONFIRM
        })
      );

      await prefilledText('221776986780');
      await pressConfirm(orderId);

      const order = stored(orderId);
      expect(order.customerConfirmationStatus).toBe(CustomerConfirmationStatus.NEEDS_ATTENTION);
      expect(order.attentionReasonCode).toBe(AttentionReasonCode.LATE_CONFIRM);
      expect(order.confirmationCancelledAt).toBeInstanceOf(Date);
      expect(order.confirmedAt).toBeUndefined();
      expect(order.operationalStatus).toBeUndefined();
      expect(eventCount(OrderEventType.CONFIRMED)).toBe(0);
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMED)).toBe(0);
      expectNoPurchase(orderId);

      // The delayed request does not go out to a cancelled order either.
      await runInitialRequest();
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMATION_REQUEST)).toBe(0);
      expectNoPurchase(orderId);
    });

    it('a Purchase queued before the cancellation is skipped by the worker, without any Graph call', async () => {
      const orderId = await ingest();

      await prefilledText('221776986780');
      expect(capiJobs()).toHaveLength(1);

      await OrderConfirmationService.cancelByAdmin(orderId, 'Le client a changé d’avis');
      await runCapiJob();

      expect(capiCalls()).toEqual([]);
      expect(stored(orderId).capiPurchaseStatus).toBe(CapiPurchaseStatus.SKIPPED);
      expect(events.find(event => event.type === OrderEventType.CAPI_PURCHASE_SKIPPED)?.metadata).toEqual({ reason: 'cancelled' });
    });
  });

  describe('delivery without any confirmation', () => {
    it('triggers the fallback once and sends one Purchase as a phone call', async () => {
      const orderId = await ingest();

      startDelivery(orderId);
      await deliver(orderId);
      expect(stored(orderId).capiPurchaseStatus).toBe(CapiPurchaseStatus.PENDING);
      expect(addedTo('capi-purchase')).toHaveLength(1);

      await runCapiJob();

      expectOnePurchase({ actionSource: 'phone_call' });
      expectSentOnOrder(orderId);
    });
  });

  describe('enqueue failure and catch-up sweep', () => {
    it('keeps the confirmation intact and the Purchase pending, then the sweep sends a single Purchase', async () => {
      const orderId = await ingest();
      fake.control.failAddsOn.add('capi-purchase');

      await prefilledText('221776986780');

      // The confirmation answered normally; the Purchase stays pending with no job.
      expect(stored(orderId)).toEqual(
        expect.objectContaining({
          customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
          capiPurchaseStatus: CapiPurchaseStatus.PENDING
        })
      );
      expect(messageCount(TemplatePurpose.ORDER_CONFIRMED)).toBe(1);
      expect(capiJobs()).toEqual([]);

      // Redis is back; the sweep only picks orders pending for more than 15 minutes.
      fake.control.failAddsOn.clear();
      expect(await runCapiPurchaseSweep()).toEqual({ candidates: 0, enqueued: 0, alreadyQueued: 0, failed: 0 });
      expect(await runCapiPurchaseSweep(new Date(Date.now() + 16 * MINUTE))).toEqual({
        candidates: 1,
        enqueued: 1,
        alreadyQueued: 0,
        failed: 0
      });
      // A second tick finds the job still waiting: no duplicate.
      expect(await runCapiPurchaseSweep(new Date(Date.now() + 21 * MINUTE))).toEqual({
        candidates: 1,
        enqueued: 0,
        alreadyQueued: 1,
        failed: 0
      });
      expect(capiJobs().map(job => job.id)).toEqual([`capi-purchase-${orderId}`]);

      await runCapiJob();

      expectOnePurchase({ actionSource: 'chat' });
      expectSentOnOrder(orderId);
    });
  });
});
