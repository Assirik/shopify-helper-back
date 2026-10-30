import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { Message } from '../../models/Message';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import {
  AttentionReasonCode,
  ConfirmationSource,
  CustomerConfirmationStatus,
  Order,
  OrderOperationalStatus
} from '../../models/Order';
import config from '../config/env.config';
import { CONFIRMABLE_BY_ADMIN, getOrderActionCapabilities } from './orderCapabilities.service';
import {
  CONFIRMABLE_BY_BUTTON,
  OrderConfirmationService,
  PHONE_MISMATCH_ATTENTION_REASON,
  TERMINAL_OPERATIONAL_STATUSES,
  isSenderOrderPhone,
  parsePrefilledConfirmationText
} from './orderConfirmation.service';
import { enqueueConfirmationReminder, enqueueOrderConfirmed } from '../../queues/notification.queue';
import log from '../logger/logger';
import { triggerCapiPurchase } from './capiPurchase.service';
import { MAX_NOTE_LENGTH } from './orderFulfillment.service';

jest.mock('../../queues/notification.queue', () => ({
  enqueueConfirmationReminder: jest.fn(),
  enqueueOrderCancelled: jest.fn(),
  enqueueOrderConfirmed: jest.fn()
}));

jest.mock('./capiPurchase.service', () => ({
  triggerCapiPurchase: jest.fn(async () => undefined)
}));

describe('order action capabilities', () => {
  it('allows all valid actions for a fresh pending order', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
        customerPhoneE164: '+221771234567',
        reminderCount: 0
      })
    ).toEqual({
      canConfirm: true,
      canRemind: true,
      canCancel: true,
      canDispatch: false,
      canDeliver: false,
      canMarkFailed: false,
      canReturn: false,
      canMarkUnreachable: true
    });
  });

  it.each([
    ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
    ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
    ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }]
  ])('blocks a reminder for a pending order %s, like the reminder route (C5.13)', (_label, change) => {
    const pending = {
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
      customerPhoneE164: '+221771234567',
      reminderCount: 0
    };
    const capabilities = getOrderActionCapabilities({ ...pending, ...change });

    expect(capabilities.canRemind).toBe(false);
    expect(capabilities.canConfirm).toBe(getOrderActionCapabilities(pending).canConfirm);
  });

  it('still allows a reminder for a pending order with an active delivery status or none', () => {
    for (const operationalStatus of [undefined, OrderOperationalStatus.TO_DELIVER, OrderOperationalStatus.DELIVERY_FAILED]) {
      expect(
        getOrderActionCapabilities({
          customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
          customerPhoneE164: '+221771234567',
          reminderCount: 0,
          operationalStatus
        }).canRemind
      ).toBe(true);
    }
  });

  it('blocks a reminder during cooldown', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
        customerPhoneE164: '+221771234567',
        reminderCount: 1,
        lastReminderAt: new Date()
      }).canRemind
    ).toBe(false);
  });

  it('blocks reminders at the configured limit and repeated cancellation', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED,
        customerPhoneE164: '+221771234567',
        reminderCount: config.confirmation.maxReminders
      })
    ).toEqual({
      canConfirm: false,
      canRemind: false,
      canCancel: false,
      canDispatch: false,
      canDeliver: false,
      canMarkFailed: false,
      canReturn: false,
      canMarkUnreachable: false
    });
  });

  it.each([
    [CustomerConfirmationStatus.PENDING, true],
    [CustomerConfirmationStatus.NEEDS_ATTENTION, true],
    [CustomerConfirmationStatus.SMS_ONLY, true],
    [CustomerConfirmationStatus.EXPIRED, true],
    [CustomerConfirmationStatus.CONFIRMED, false],
    [CustomerConfirmationStatus.CANCELLED, false]
  ])('allows marking a %s order unreachable: %p', (customerConfirmationStatus, expected) => {
    expect(getOrderActionCapabilities({ customerConfirmationStatus, reminderCount: 0 }).canMarkUnreachable).toBe(
      expected
    );
  });

  it('exposes operational delivery capabilities from the backend status', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.TO_DELIVER
      })
    ).toEqual(
      expect.objectContaining({
        canDispatch: true,
        canDeliver: false,
        canMarkFailed: false,
        canReturn: false
      })
    );

    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.IN_DELIVERY
      })
    ).toEqual(
      expect.objectContaining({
        canDispatch: false,
        canDeliver: true,
        canMarkFailed: true,
        canReturn: true
      })
    );
  });

  it('blocks cancellation for terminal operational statuses', () => {
    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.DELIVERED
      }).canCancel
    ).toBe(false);

    expect(
      getOrderActionCapabilities({
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        reminderCount: 0,
        operationalStatus: OrderOperationalStatus.RETURNED
      }).canCancel
    ).toBe(false);
  });
});

describe('order cancellation guards', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a dedicated code when cancelling a delivered order', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
      operationalStatus: OrderOperationalStatus.DELIVERED
    } as never);

    await expect(
      OrderConfirmationService.cancelByAdmin('507f1f77bcf86cd799439011', 'Erreur')
    ).rejects.toMatchObject({ code: 'OrderCancellationNotAllowedAfterDelivery', status: 409 });
  });

  it('keeps the legacy code when the order is already cancelled', async () => {
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED
    } as never);

    await expect(
      OrderConfirmationService.cancelByAdmin('507f1f77bcf86cd799439011', 'Erreur')
    ).rejects.toMatchObject({ code: 'OrderCancellationNotAllowed', status: 409 });
  });
});

describe('admin confirmation source', () => {
  const orderId = new Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockConfirmation = () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    return { update, createEvent };
  };

  it.each([
    [undefined, ConfirmationSource.ADMIN],
    [ConfirmationSource.ADMIN, ConfirmationSource.ADMIN],
    [ConfirmationSource.PHONE_CALL, ConfirmationSource.PHONE_CALL]
  ] as const)('records source %p as %p on the order and the event', async (source, expected) => {
    const { update, createEvent } = mockConfirmation();

    await OrderConfirmationService.confirmByAdmin(orderId.toString(), undefined, source);

    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ $set: expect.objectContaining({ confirmationSource: expected }) })
    );
    expect(createEvent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ metadata: { source: expected } }));
  });
});

describe('mark order unreachable', () => {
  const orderId = new Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('flags the order for the helpdesk queue and records a note event with its author', async () => {
    const actorId = new Types.ObjectId();
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderConfirmationService.markUnreachable(orderId.toString(), '  Messagerie, rappeler à 18h  ', actorId.toString());

    expect(update.mock.calls[0]?.[0]).toEqual({
      _id: orderId.toString(),
      customerConfirmationStatus: { $in: CONFIRMABLE_BY_ADMIN }
    });
    expect(update.mock.calls[0]?.[1]).toEqual({
      $set: {
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.UNREACHABLE,
        attentionReason: 'Messagerie, rappeler à 18h',
        attentionRequiredAt: expect.any(Date),
        lastNoteText: 'Messagerie, rappeler à 18h',
        lastNoteAt: expect.any(Date)
      }
    });
    expect(createEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: OrderEventType.NOTE,
        note: 'Messagerie, rappeler à 18h',
        actorId,
        metadata: { attentionReasonCode: AttentionReasonCode.UNREACHABLE }
      })
    );
  });

  it.each([undefined, '', '   '])('falls back to a default note when the note is %p', async note => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

    await OrderConfirmationService.markUnreachable(orderId.toString(), note);

    expect(update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ $set: expect.objectContaining({ attentionReason: 'Client injoignable' }) })
    );
    expect(createEvent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ note: 'Client injoignable' }));
  });

  it('rejects a note longer than the note limit before touching the order', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate');

    await expect(
      OrderConfirmationService.markUnreachable(orderId.toString(), 'a'.repeat(MAX_NOTE_LENGTH + 1))
    ).rejects.toMatchObject({ code: 'NoteTextTooLong', status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    [{ _id: orderId }, 'OrderUnreachableNotAllowed', 409],
    [null, 'OrderNotFound', 404]
  ])('rejects an order that is not awaiting confirmation (exists: %p)', async (exists, code, status) => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Order, 'exists').mockResolvedValue(exists as never);
    const createEvent = jest.spyOn(OrderEvent, 'create');

    await expect(OrderConfirmationService.markUnreachable(orderId.toString())).rejects.toMatchObject({ code, status });
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe('pre-filled WhatsApp confirmation (C5.6b)', () => {
  const orderId = new Types.ObjectId();
  const orderPhone = '+221776986780';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('recognition', () => {
    it.each([
      'Je confirme ma commande #1234',
      'je CONFIRME ma commande #1234',
      'CONFIRMÉ #1234',
      'Confirmé, commande #1234 merci',
      'confirmation #1234'
    ])('recognises %p', text => {
      expect(parsePrefilledConfirmationText(text)).toEqual(['#1234']);
    });

    it.each([
      ['Où en est ma commande #1234 ?'],
      ['Bonjour, ma commande #1234'],
      ['Je confirme ma commande'],
      ['Je confirme ma commande 1234'],
      [''],
      [undefined]
    ])('does not recognise %p', text => {
      expect(parsePrefilledConfirmationText(text)).toEqual([]);
    });

    it.each([
      'Je ne confirme pas ma commande #1234',
      'je confirme pas #1234',
      "Je n'confirme pas ma commande #1234",
      'Annulez, je confirme pas #1234',
      "je confirme l'annulation de #1234",
      'JE NE CONFIRME PAS #1234',
      'Je confirme, mais ANNULÉ #1234'
    ])('does not recognise the negation or cancellation %p', text => {
      expect(parsePrefilledConfirmationText(text)).toEqual([]);
    });

    it.each([
      'Je confirme ma commande #1234',
      'JE CONFIRME MA COMMANDE #1234',
      'Je confirme ma commande #1234, passage le soir svp',
      'Je confirme #1234, je repasse demain'
    ])('still recognises %p (no whole word "pas", no "annul")', text => {
      expect(parsePrefilledConfirmationText(text)).toEqual(['#1234']);
    });

    it('keeps every reference in order of appearance, without duplicates', () => {
      expect(parsePrefilledConfirmationText('Je confirme #99 et #1234, oui #99')).toEqual(['#99', '#1234']);
    });
  });

  describe('sender vs order phone comparison', () => {
    it.each(['221776986780', '+221776986780', '776986780', '+221 77 698 67 80', '77-698-67-80'])(
      'matches the sender %p',
      sender => {
        expect(isSenderOrderPhone(sender, orderPhone)).toEqual({ matches: true, senderE164: orderPhone });
      }
    );

    it.each([
      ['221771112233', orderPhone, '+221771112233'],
      ['33612345678', orderPhone, undefined],
      [undefined, orderPhone, undefined],
      ['221776986780', undefined, '+221776986780']
    ])('does not match the sender %p against %p', (sender, phone, senderE164) => {
      expect(isSenderOrderPhone(sender, phone)).toEqual({ matches: false, senderE164 });
    });
  });

  const pendingOrder = (overrides: Record<string, unknown> = {}) => ({
    _id: orderId,
    shopifyOrderName: '#1234',
    customerPhoneE164: orderPhone,
    customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
    ...overrides
  });

  const mockFindOne = (orders: Record<string, unknown>) =>
    jest
      .spyOn(Order, 'findOne')
      .mockImplementation(((filter: { shopifyOrderName?: string }) =>
        Promise.resolve(orders[filter.shopifyOrderName || ''] ?? null)) as never);

  it.each(['221776986780', '776986780', '+221 77 698 67 80'])(
    'confirms through the button path with source whatsapp_button when the sender %p is the order phone',
    async from => {
      mockFindOne({ '#1234': pendingOrder() });
      const update = jest
        .spyOn(Order, 'findOneAndUpdate')
        .mockResolvedValue({ _id: orderId, customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED } as never);
      const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
      const createMessage = jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);

      const result = await OrderConfirmationService.confirmByPrefilledMessage({
        from,
        text: ' Je confirme ma commande #1234 ',
        waMessageId: 'wamid.1'
      });

      expect(result.outcome).toBe('confirmed');
      expect(update.mock.calls[0]?.[0]).toEqual({
        _id: orderId.toString(),
        customerConfirmationStatus: { $in: CONFIRMABLE_BY_BUTTON },
        shopifyCancelledAt: null,
        operationalStatus: { $nin: [OrderOperationalStatus.DELIVERED, OrderOperationalStatus.RETURNED] }
      });
      expect(update.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          $set: expect.objectContaining({
            customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
            confirmationSource: ConfirmationSource.WHATSAPP_BUTTON,
            lastCustomerMessageText: 'Je confirme ma commande #1234',
            confirmationPayload: { buttonText: 'Je confirme ma commande #1234', waMessageId: 'wamid.1' }
          })
        })
      );
      expect(createEvent.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          type: OrderEventType.CONFIRMED,
          metadata: { source: ConfirmationSource.WHATSAPP_BUTTON }
        })
      );
      expect(createMessage).toHaveBeenCalledTimes(1);
    }
  );

  it('flags phone_mismatch without confirming when the sender differs from the order phone', async () => {
    mockFindOne({ '#1234': pendingOrder() });
    const confirmByButton = jest.spyOn(OrderConfirmationService, 'confirmByWhatsAppButton');
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    const createMessage = jest.spyOn(Message, 'create');

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221771112233',
      text: 'Je confirme ma commande #1234',
      waMessageId: 'wamid.2'
    });

    expect(result).toEqual(expect.objectContaining({ outcome: 'phone_mismatch', senderE164: '+221771112233' }));
    expect(confirmByButton).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(update.mock.calls[0]?.[0]).toEqual({
      _id: orderId,
      customerConfirmationStatus: { $in: CONFIRMABLE_BY_BUTTON },
      attentionReasonCode: { $ne: AttentionReasonCode.PHONE_MISMATCH },
      shopifyCancelledAt: null,
      operationalStatus: { $nin: [OrderOperationalStatus.DELIVERED, OrderOperationalStatus.RETURNED] }
    });
    expect(update.mock.calls[0]?.[1]).toEqual({
      $set: {
        needsHelpdeskAttention: true,
        attentionReasonCode: AttentionReasonCode.PHONE_MISMATCH,
        attentionReason: PHONE_MISMATCH_ATTENTION_REASON,
        attentionRequiredAt: expect.any(Date),
        lastCustomerMessageAt: expect.any(Date),
        lastCustomerMessageText: 'Je confirme ma commande #1234'
      }
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        orderId,
        type: OrderEventType.PHONE_MISMATCH,
        metadata: { senderE164: '+221771112233', waMessageId: 'wamid.2' }
      })
    );
  });

  it('uses the first reference that matches an existing order', async () => {
    const findOne = mockFindOne({ '#1234': pendingOrder() });
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221776986780',
      text: 'Je confirme #99 puis #1234'
    });

    expect(findOne.mock.calls.map(call => call[0])).toEqual([
      { shopifyOrderName: '#99' },
      { shopifyOrderName: '#1234' }
    ]);
    expect(result.outcome).toBe('confirmed');
  });

  it.each([
    ['an unknown reference', 'Je confirme ma commande #9999'],
    ['a text without "confirm"', 'Où en est ma commande #1234 ?'],
    ['a text without reference', 'Je confirme ma commande']
  ])('leaves %s to the regular handling', async (_label, text) => {
    mockFindOne({ '#1234': pendingOrder() });
    const update = jest.spyOn(Order, 'findOneAndUpdate');
    const createEvent = jest.spyOn(OrderEvent, 'create');

    const result = await OrderConfirmationService.confirmByPrefilledMessage({ from: '221776986780', text });

    expect(result).toEqual({ outcome: 'not_applicable' });
    expect(update).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['confirmed', { customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED }],
    ['cancelled', { customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }],
    ['expired', { customerConfirmationStatus: CustomerConfirmationStatus.EXPIRED }],
    ['cancelled on Shopify', { shopifyCancelledAt: new Date() }],
    ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
    ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }]
  ])('does not transition an order already %s, whatever the sender', async (_label, overrides) => {
    for (const from of ['221776986780', '221771112233']) {
      mockFindOne({ '#1234': pendingOrder(overrides) });
      const update = jest.spyOn(Order, 'findOneAndUpdate');
      const createEvent = jest.spyOn(OrderEvent, 'create');

      const result = await OrderConfirmationService.confirmByPrefilledMessage({
        from,
        text: 'Je confirme ma commande #1234'
      });

      expect(result).toEqual({ outcome: 'not_applicable' });
      expect(update).not.toHaveBeenCalled();
      expect(createEvent).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    }
  });

  it('does not record a mismatch event when a concurrent transition won the write', async () => {
    mockFindOne({ '#1234': pendingOrder() });
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    jest
      .spyOn(Order, 'findById')
      .mockResolvedValue(pendingOrder({ customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED }) as never);
    const createEvent = jest.spyOn(OrderEvent, 'create');

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221771112233',
      text: 'Je confirme ma commande #1234'
    });

    expect(result).toEqual({ outcome: 'not_applicable' });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('never re-opens an order cancelled between the read and the confirmation write', async () => {
    mockFindOne({ '#1234': pendingOrder() });
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    const save = jest.fn();
    const findById = jest
      .spyOn(Order, 'findById')
      .mockResolvedValue(pendingOrder({ customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED, save }) as never);
    const confirmByButton = jest.spyOn(OrderConfirmationService, 'confirmByWhatsAppButton');
    const createEvent = jest.spyOn(OrderEvent, 'create');
    const createMessage = jest.spyOn(Message, 'create');

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221776986780',
      text: 'Je confirme ma commande #1234'
    });

    expect(result).toEqual({ outcome: 'not_applicable' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith(orderId);
    expect(confirmByButton).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('records a single phone_mismatch event for two concurrent deliveries of the same message', async () => {
    // In-memory order honouring the conditional write, as MongoDB would.
    const state: Record<string, unknown> = pendingOrder();
    mockFindOne({ '#1234': state });
    jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((
      filter: { attentionReasonCode: { $ne: string } },
      update: { $set: Record<string, unknown> }
    ) =>
      Promise.resolve().then(() => {
        if (state.attentionReasonCode === filter.attentionReasonCode.$ne) {
          return null;
        }
        Object.assign(state, update.$set);
        return { ...state };
      })) as never);
    jest.spyOn(Order, 'findById').mockImplementation((() => Promise.resolve({ ...state })) as never);
    const freshOrders = jest.spyOn(Order, 'findOne');
    const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    const input = { from: '221771112233', text: 'Je confirme ma commande #1234', waMessageId: 'wamid.dup' };

    const results = await Promise.all([
      OrderConfirmationService.confirmByPrefilledMessage(input),
      OrderConfirmationService.confirmByPrefilledMessage(input)
    ]);

    expect(freshOrders).toHaveBeenCalledTimes(2);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ type: OrderEventType.PHONE_MISMATCH }));
    expect(results.map(result => result.outcome)).toEqual(['phone_mismatch', 'phone_mismatch']);
    expect(state.attentionReasonCode).toBe(AttentionReasonCode.PHONE_MISMATCH);
  });

  it('still reports the mismatch when the phone_mismatch event cannot be recorded', async () => {
    mockFindOne({ '#1234': pendingOrder() });
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    const createEvent = jest.spyOn(OrderEvent, 'create').mockRejectedValue(new Error('mongo down') as never);

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221771112233',
      text: 'Je confirme ma commande #1234'
    });

    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ outcome: 'phone_mismatch' }));
  });

  describe('write-time guard (state changed between the read and the write)', () => {
    // Evaluates the operators the service writes with, using MongoDB semantics: `null`
    // and `$nin` / `$ne` also match a missing field.
    const matchesFilter = (doc: Record<string, unknown>, filter: Record<string, unknown>) =>
      Object.entries(filter).every(([key, condition]) => {
        const value = doc[key];

        if (condition === null) {
          return value === null || value === undefined;
        }

        if (condition && typeof condition === 'object' && !(condition instanceof Types.ObjectId)) {
          const ops = condition as { $in?: unknown[]; $nin?: unknown[]; $ne?: unknown };

          if (ops.$in) {
            return ops.$in.includes(value);
          }

          if (ops.$nin) {
            return !ops.$nin.includes(value ?? null);
          }

          return value !== ops.$ne;
        }

        return String(value) === String(condition);
      });

    // `Order.findOne` returns the stale read; the writes and re-reads see the current state.
    const mockStaleRead = (state: Record<string, unknown>) => {
      mockFindOne({ '#1234': pendingOrder() });
      const update = jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((
        filter: Record<string, unknown>,
        change: { $set: Record<string, unknown> }
      ) =>
        Promise.resolve().then(() => {
          if (!matchesFilter(state, filter)) {
            return null;
          }
          Object.assign(state, change.$set);
          return { ...state };
        })) as never);
      jest.spyOn(Order, 'findById').mockImplementation((() => Promise.resolve({ ...state })) as never);

      return update;
    };

    it.each([
      ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED, deliveredAt: new Date() }],
      ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }],
      ['cancelled on Shopify', { shopifyCancelledAt: new Date() }]
    ])('does not confirm nor flag an order %s in the meantime', async (_label, change) => {
      for (const from of ['221776986780', '221771112233']) {
        const state: Record<string, unknown> = { ...pendingOrder(), ...change };
        const update = mockStaleRead(state);
        const createEvent = jest.spyOn(OrderEvent, 'create');
        const createMessage = jest.spyOn(Message, 'create');

        const result = await OrderConfirmationService.confirmByPrefilledMessage({
          from,
          text: 'Je confirme ma commande #1234'
        });

        expect(result).toEqual({ outcome: 'not_applicable' });
        expect(update).toHaveBeenCalledTimes(1);
        expect(state).toEqual({ ...pendingOrder(), ...change });
        expect(createEvent).not.toHaveBeenCalled();
        expect(createMessage).not.toHaveBeenCalled();
        jest.restoreAllMocks();
      }
    });

    it.each([
      ['without operationalStatus nor shopifyCancelledAt', {}],
      ['with null operationalStatus and shopifyCancelledAt', { operationalStatus: null, shopifyCancelledAt: null }]
    ])('still confirms an order %s', async (_label, fields) => {
      const state: Record<string, unknown> = { ...pendingOrder(), ...fields };
      mockStaleRead(state);
      jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
      jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);

      const result = await OrderConfirmationService.confirmByPrefilledMessage({
        from: '221776986780',
        text: 'Je confirme ma commande #1234'
      });

      expect(result.outcome).toBe('confirmed');
      expect(state.customerConfirmationStatus).toBe(CustomerConfirmationStatus.CONFIRMED);
      expect(state.operationalStatus).toBe(OrderOperationalStatus.TO_DELIVER);
    });

    it('still flags phone_mismatch on an order without operationalStatus', async () => {
      const state: Record<string, unknown> = pendingOrder();
      mockStaleRead(state);
      jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);

      const result = await OrderConfirmationService.confirmByPrefilledMessage({
        from: '221771112233',
        text: 'Je confirme ma commande #1234'
      });

      expect(result.outcome).toBe('phone_mismatch');
      expect(state.attentionReasonCode).toBe(AttentionReasonCode.PHONE_MISMATCH);
    });
  });

  it('keeps the Confirm button write filter free of the pre-filled guard', async () => {
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue({ _id: orderId } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);

    await OrderConfirmationService.confirmByWhatsAppButton(orderId.toString(), {
      buttonPayload: `CONFIRM_ORDER:${orderId.toString()}`,
      buttonText: 'Confirmer'
    });

    expect(update.mock.calls[0]?.[0]).toEqual({
      _id: orderId.toString(),
      customerConfirmationStatus: { $in: CONFIRMABLE_BY_BUTTON }
    });
  });

  it('keeps the order confirmed and logs the error when the confirmed template cannot be enqueued', async () => {
    mockFindOne({ '#1234': pendingOrder() });
    const confirmedOrder = { _id: orderId, customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED };
    const update = jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(confirmedOrder as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    const findById = jest.spyOn(Order, 'findById');
    const logError = jest.spyOn(log, 'error').mockImplementation((() => undefined) as never);
    jest.mocked(enqueueOrderConfirmed).mockRejectedValueOnce(new Error('redis down'));

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221776986780',
      text: 'Je confirme ma commande #1234'
    });

    expect(result).toEqual({ outcome: 'confirmed', order: confirmedOrder });
    expect(update).toHaveBeenCalledTimes(1);
    expect(findById).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ orderId, err: expect.any(Error) }),
      expect.any(String)
    );
  });
});

describe('Meta Purchase trigger on confirmation (C5.5)', () => {
  const orderId = new Types.ObjectId();
  const orderPhone = '+221776986780';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockConfirmedWrite = () => {
    const update = jest
      .spyOn(Order, 'findOneAndUpdate')
      .mockResolvedValue({ _id: orderId, customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED } as never);
    jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    return update;
  };

  const mockPrefilledOrder = () =>
    jest.spyOn(Order, 'findOne').mockResolvedValue({
      _id: orderId,
      shopifyOrderName: '#1234',
      customerPhoneE164: orderPhone,
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING
    } as never);

  it('triggers once after a Confirm button confirmation', async () => {
    mockConfirmedWrite();

    await OrderConfirmationService.confirmByWhatsAppButton(orderId.toString(), { buttonText: 'Confirmer' });

    expect(triggerCapiPurchase).toHaveBeenCalledTimes(1);
    expect(triggerCapiPurchase).toHaveBeenCalledWith(orderId, 'confirmation');
  });

  it('triggers once after a pre-filled message confirmation', async () => {
    mockPrefilledOrder();
    mockConfirmedWrite();

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221776986780',
      text: 'Je confirme ma commande #1234'
    });

    expect(result.outcome).toBe('confirmed');
    expect(triggerCapiPurchase).toHaveBeenCalledTimes(1);
    expect(triggerCapiPurchase).toHaveBeenCalledWith(orderId, 'confirmation');
  });

  it.each([ConfirmationSource.ADMIN, ConfirmationSource.PHONE_CALL] as const)(
    'triggers once after an agent confirmation (source %s)',
    async source => {
      mockConfirmedWrite();

      await OrderConfirmationService.confirmByAdmin(orderId.toString(), undefined, source);

      expect(triggerCapiPurchase).toHaveBeenCalledTimes(1);
      expect(triggerCapiPurchase).toHaveBeenCalledWith(orderId, 'confirmation');
    }
  );

  it('does not trigger when the button write did not apply (already confirmed)', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: orderId,
      customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED
    } as never);

    const result = await OrderConfirmationService.confirmByWhatsAppButton(orderId.toString(), { buttonText: 'Confirmer' });

    expect(result.alreadyConfirmed).toBe(true);
    expect(triggerCapiPurchase).not.toHaveBeenCalled();
  });

  it('does not trigger when the pre-filled write lost a concurrent transition', async () => {
    mockPrefilledOrder();
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: orderId,
      customerConfirmationStatus: CustomerConfirmationStatus.CANCELLED
    } as never);

    const result = await OrderConfirmationService.confirmByPrefilledMessage({
      from: '221776986780',
      text: 'Je confirme ma commande #1234'
    });

    expect(result).toEqual({ outcome: 'not_applicable' });
    expect(triggerCapiPurchase).not.toHaveBeenCalled();
  });

  it('does not trigger when the agent confirmation is refused', async () => {
    jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Order, 'exists').mockResolvedValue({ _id: orderId } as never);

    await expect(OrderConfirmationService.confirmByAdmin(orderId.toString())).rejects.toMatchObject({
      code: 'OrderConfirmationNotAllowed',
      status: 409
    });
    expect(triggerCapiPurchase).not.toHaveBeenCalled();
  });
});

describe('automatic reminders (C5.13)', () => {
  const orderId = new Types.ObjectId();

  // Evaluates the claim filter with MongoDB semantics: `null` and `$nin` also match a
  // missing field.
  const matchesFilter = (doc: Record<string, unknown>, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, condition]) => {
      const value = doc[key];

      if (condition === null) {
        return value === null || value === undefined;
      }

      if (condition && typeof condition === 'object' && !(condition instanceof Types.ObjectId)) {
        const ops = condition as { $in?: unknown[]; $nin?: unknown[] };

        if (ops.$in) {
          return ops.$in.includes(value);
        }

        return !(ops.$nin || []).includes(value ?? null);
      }

      return String(value) === String(condition);
    });

  // `Order.find` returns a stale candidate; the claim sees the current state.
  const runSweepOn = async (state: Record<string, unknown>) => {
    const find = jest.spyOn(Order, 'find').mockReturnValue({
      select: () => ({ limit: () => Promise.resolve([{ _id: orderId }]) })
    } as never);
    jest.spyOn(Order, 'updateMany').mockResolvedValue({ modifiedCount: 0 } as never);
    const claim = jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((
      filter: Record<string, unknown>,
      change: { $inc: { reminderCount: number } }
    ) =>
      Promise.resolve().then(() => {
        if (!matchesFilter(state, filter)) {
          return null;
        }
        state.reminderCount = (state.reminderCount as number) + change.$inc.reminderCount;
        return { ...state };
      })) as never);
    jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    jest.mocked(enqueueConfirmationReminder).mockResolvedValue({ id: 'reminder-1' } as never);

    const result = await OrderConfirmationService.runConfirmationMaintenance();

    return { result, find, claim };
  };

  const pendingOrder = (overrides: Record<string, unknown> = {}) => ({
    _id: orderId,
    customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
    customerPhoneE164: '+221776986780',
    reminderCount: 0,
    ...overrides
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('excludes orders cancelled on Shopify, delivered or returned from the candidates', async () => {
    const { find } = await runSweepOn(pendingOrder());

    for (const [filter] of find.mock.calls) {
      expect(filter).toEqual(
        expect.objectContaining({
          shopifyCancelledAt: null,
          operationalStatus: { $nin: TERMINAL_OPERATIONAL_STATUSES }
        })
      );
    }
  });

  it.each([
    ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
    ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
    ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }]
  ])('never claims nor sends a reminder to an order %s in the meantime', async (_label, change) => {
    const state: Record<string, unknown> = pendingOrder(change);

    const { result } = await runSweepOn(state);

    expect(result).toEqual({ expired: 0, firstReminders: 0, secondReminders: 0 });
    expect(state.reminderCount).toBe(0);
    expect(enqueueConfirmationReminder).not.toHaveBeenCalled();
  });

  it.each([
    ['without operationalStatus nor shopifyCancelledAt', {}],
    ['to deliver', { operationalStatus: OrderOperationalStatus.TO_DELIVER, shopifyCancelledAt: null }]
  ])('still reminds a pending order %s', async (_label, fields) => {
    const state: Record<string, unknown> = pendingOrder(fields);

    const { result } = await runSweepOn(state);

    expect(result.firstReminders).toBe(1);
    expect(state.reminderCount).toBe(1);
    expect(enqueueConfirmationReminder).toHaveBeenCalledTimes(1);
  });

  describe('agent reminder', () => {
    const remind = () => OrderConfirmationService.remindByAdmin(orderId.toString(), new Types.ObjectId().toString());

    // `Order.findById` returns `read`; the claim sees `state` (the current order).
    const mockOrder = (read: Record<string, unknown>, state: Record<string, unknown> = read) => {
      jest.spyOn(Order, 'findById').mockResolvedValue({ ...read } as never);
      const claim = jest.spyOn(Order, 'findOneAndUpdate').mockImplementation(((
        filter: Record<string, unknown>,
        change: { $inc: { reminderCount: number } }
      ) =>
        Promise.resolve().then(() => {
          if (!matchesFilter(state, filter)) {
            return null;
          }
          state.reminderCount = (state.reminderCount as number) + change.$inc.reminderCount;
          return { ...state };
        })) as never);
      const createEvent = jest.spyOn(OrderEvent, 'create').mockResolvedValue({} as never);
      jest.spyOn(Message, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);
      jest.mocked(enqueueConfirmationReminder).mockResolvedValue({ id: 'reminder-1' } as never);

      return { claim, createEvent };
    };

    const changes: [string, Record<string, unknown>][] = [
      ['cancelled on Shopify', { shopifyCancelledAt: new Date('2026-10-30T10:00:00.000Z') }],
      ['delivered', { operationalStatus: OrderOperationalStatus.DELIVERED }],
      ['returned', { operationalStatus: OrderOperationalStatus.RETURNED }]
    ];

    it.each(changes)('refuses with 409 to remind an order %s, without claiming nor recording anything', async (_label, change) => {
      const state: Record<string, unknown> = pendingOrder(change);
      const { claim, createEvent } = mockOrder(state);

      await expect(remind()).rejects.toMatchObject({ code: 'OrderReminderNotAllowed', status: 409 });

      expect(claim).not.toHaveBeenCalled();
      expect(createEvent).not.toHaveBeenCalled();
      expect(enqueueConfirmationReminder).not.toHaveBeenCalled();
      expect(state.reminderCount).toBe(0);
    });

    it.each(changes)('never claims a reminder on an order %s between the read and the claim', async (_label, change) => {
      const state: Record<string, unknown> = pendingOrder(change);
      const { createEvent } = mockOrder(pendingOrder(), state);

      await expect(remind()).rejects.toMatchObject({ status: 409 });

      expect(state.reminderCount).toBe(0);
      expect(createEvent).not.toHaveBeenCalled();
      expect(enqueueConfirmationReminder).not.toHaveBeenCalled();
    });

    it('still reminds a pending order', async () => {
      const state: Record<string, unknown> = pendingOrder();
      const { createEvent } = mockOrder(state);

      await remind();

      expect(state.reminderCount).toBe(1);
      expect(createEvent).toHaveBeenCalledTimes(1);
      expect(enqueueConfirmationReminder).toHaveBeenCalledTimes(1);
    });
  });
});
