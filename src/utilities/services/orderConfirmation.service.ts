import { Types } from 'mongoose';
import { Message, MessageChannel, MessageProvider, MessageStatus, TemplatePurpose } from '../../models/Message';
import { OrderEvent, OrderEventType } from '../../models/OrderEvent';
import {
  AttentionReasonCode,
  ConfirmationSource,
  CustomerConfirmationStatus,
  IOrder,
  Order,
  OrderOperationalStatus,
  ReminderSource
} from '../../models/Order';
import {
  enqueueConfirmationReminder,
  enqueueOrderCancelled,
  enqueueOrderConfirmed
} from '../../queues/notification.queue';
import config from '../config/env.config';
import log from '../logger/logger';
import { CONFIRMABLE_BY_ADMIN, getOrderActionCapabilities } from './orderCapabilities.service';
import { MAX_NOTE_LENGTH } from './orderFulfillment.service';
import { PhoneNormalizationService } from './phoneNormalization.service';

export class OrderConfirmationError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OrderConfirmationError';
    this.code = code;
    this.status = status;
  }
}

export interface WhatsAppButtonConfirmation {
  buttonPayload?: string;
  buttonText?: string;
  waMessageId?: string;
}

export const MAX_CANCELLATION_REASON_LENGTH = 500;

/** Sources qu'un agent peut déclarer en confirmant (le bouton WhatsApp est réservé au webhook). */
export const ADMIN_CONFIRMATION_SOURCES = [ConfirmationSource.ADMIN, ConfirmationSource.PHONE_CALL] as const;
export type AdminConfirmationSource = (typeof ADMIN_CONFIRMATION_SOURCES)[number];

const DEFAULT_UNREACHABLE_NOTE = 'Client injoignable';

const ensureObjectId = (orderId: string) => {
  if (!Types.ObjectId.isValid(orderId)) {
    throw new OrderConfirmationError('OrderNotFound', 'Order not found', 404);
  }
};

const getOrderOrThrow = async (orderId: string) => {
  ensureObjectId(orderId);

  const order = await Order.findById(orderId);

  if (!order) {
    throw new OrderConfirmationError('OrderNotFound', 'Order not found', 404);
  }

  return order;
};

const createQueuedWhatsAppMessage = async (input: {
  orderId: Types.ObjectId;
  templateName: string;
  templatePurpose: TemplatePurpose;
  buttonPayload?: string;
}) => {
  return Message.create({
    orderId: input.orderId,
    channel: MessageChannel.WHATSAPP,
    provider: MessageProvider.META,
    status: MessageStatus.QUEUED,
    templateName: input.templateName,
    templateLanguage: config.metaWhatsApp.templateLanguage,
    templatePurpose: input.templatePurpose,
    buttonPayload: input.buttonPayload
  });
};

const enqueueConfirmedTemplate = async (orderId: Types.ObjectId) => {
  const message = await createQueuedWhatsAppMessage({
    orderId,
    templateName: config.metaWhatsApp.confirmedTemplateName,
    templatePurpose: TemplatePurpose.ORDER_CONFIRMED
  });

  const job = await enqueueOrderConfirmed({
    orderId: orderId.toString(),
    messageId: message._id.toString(),
    channel: MessageChannel.WHATSAPP
  });

  return { message, job };
};

const enqueueCancelledTemplate = async (orderId: Types.ObjectId) => {
  const message = await createQueuedWhatsAppMessage({
    orderId,
    templateName: config.metaWhatsApp.cancelledTemplateName,
    templatePurpose: TemplatePurpose.ORDER_CANCELLED
  });

  const job = await enqueueOrderCancelled({
    orderId: orderId.toString(),
    messageId: message._id.toString(),
    channel: MessageChannel.WHATSAPP
  });

  return { message, job };
};

// Creates the reminder message and enqueues it. Reminder counters are expected to have
// already been claimed atomically by the caller to avoid duplicate sends.
const dispatchReminderMessage = async (orderId: Types.ObjectId) => {
  const buttonPayload = `CONFIRM_ORDER:${orderId.toString()}`;
  const message = await createQueuedWhatsAppMessage({
    orderId,
    templateName: config.metaWhatsApp.templateName,
    templatePurpose: TemplatePurpose.REMINDER,
    buttonPayload
  });

  const job = await enqueueConfirmationReminder({
    orderId: orderId.toString(),
    messageId: message._id.toString(),
    channel: MessageChannel.WHATSAPP
  });

  return { message, job };
};

export const CONFIRMABLE_BY_BUTTON = [
  CustomerConfirmationStatus.PENDING,
  CustomerConfirmationStatus.NEEDS_ATTENTION,
  CustomerConfirmationStatus.SMS_ONLY
];

// Pre-filled WhatsApp message sent right after the EasySell form:
// "Je confirme ma commande #1234". Recognised when the text contains "confirm"
// (case and accent insensitive) and at least one `#<digits>` order reference.
// A negation (the whole word "pas": "ne … pas", "n'… pas") or a cancellation ("annul…")
// disqualifies it: such a text follows the regular free-text handling.
const PREFILLED_CONFIRMATION_KEYWORD = 'confirm';
const PREFILLED_CONFIRMATION_DISQUALIFIER = /\bpas\b|annul/;
const ORDER_REFERENCE_PATTERN = /#(\d+)/g;

const foldText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/**
 * Returns the candidate Shopify order names (`#1234`) of a pre-filled confirmation
 * message, in order of appearance, or an empty list when the text is not one.
 */
export const parsePrefilledConfirmationText = (text?: string | null): string[] => {
  const folded = text ? foldText(text) : '';

  if (!text || !folded.includes(PREFILLED_CONFIRMATION_KEYWORD) || PREFILLED_CONFIRMATION_DISQUALIFIER.test(folded)) {
    return [];
  }

  const names = Array.from(text.matchAll(ORDER_REFERENCE_PATTERN), match => `#${match[1]}`);

  return Array.from(new Set(names));
};

/**
 * Single comparison point between a WhatsApp sender and the order phone. Both sides go
 * through the Senegal normalizer, so `221776986780`, `+221 77 698 67 80` and
 * `776986780` all match `+221776986780`. An invalid or missing phone never matches.
 */
export const isSenderOrderPhone = (sender?: string | null, orderPhoneE164?: string | null) => {
  const senderPhone = PhoneNormalizationService.normalizeSenegalPhone(sender);
  const orderPhone = PhoneNormalizationService.normalizeSenegalPhone(orderPhoneE164);

  return {
    matches: Boolean(senderPhone.e164 && orderPhone.e164 && senderPhone.e164 === orderPhone.e164),
    senderE164: senderPhone.e164
  };
};

const TERMINAL_OPERATIONAL_STATUSES = [OrderOperationalStatus.DELIVERED, OrderOperationalStatus.RETURNED];

// Already confirmed, cancelled (here or on Shopify), expired or closed orders are left to
// the regular inbound-message handling: the pre-filled message never transitions them.
const acceptsPrefilledConfirmation = (order: IOrder) =>
  CONFIRMABLE_BY_BUTTON.includes(order.customerConfirmationStatus) &&
  !order.shopifyCancelledAt &&
  !(order.operationalStatus && TERMINAL_OPERATIONAL_STATUSES.includes(order.operationalStatus));

// Write-time counterpart of `acceptsPrefilledConfirmation` (the confirmation status is
// already in every write filter): an order delivered, returned or cancelled on Shopify
// between the read and the write is left untouched. In MongoDB both `null` and `$nin`
// also match a missing field, so an order without these fields stays eligible.
const PREFILLED_WRITE_GUARD = {
  shopifyCancelledAt: null,
  operationalStatus: { $nin: TERMINAL_OPERATIONAL_STATUSES }
};

export interface PrefilledConfirmationInput {
  from?: string;
  text?: string;
  waMessageId?: string;
}

export type PrefilledConfirmationResult =
  | { outcome: 'not_applicable' }
  | { outcome: 'confirmed'; order: IOrder }
  | { outcome: 'phone_mismatch'; order: IOrder; senderE164?: string };

export const PHONE_MISMATCH_ATTENTION_REASON =
  'Confirmation WhatsApp envoyée depuis un numéro différent de celui de la commande';

const toActorObjectId = (actorId?: string) =>
  actorId && Types.ObjectId.isValid(actorId) ? new Types.ObjectId(actorId) : undefined;

const createOrderEvent = (input: {
  orderId: Types.ObjectId;
  type: OrderEventType;
  fromStatus?: string;
  toStatus?: string;
  actorId?: string;
  note?: string;
  metadata?: Record<string, unknown>;
}) => {
  return OrderEvent.create({
    orderId: input.orderId,
    type: input.type,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorId: toActorObjectId(input.actorId),
    note: input.note,
    metadata: input.metadata
  });
};

// Atomic confirm shared by the Confirm button and the pre-filled message: only one writer
// can flip a confirmable status to CONFIRMED, so the confirmed template is enqueued at most
// once even with concurrent admin/button actions. Returns null when the write did not apply.
// `extraFilter` adds write-time conditions (pre-filled message only, the button has none).
const writeWhatsAppConfirmation = (
  orderId: string,
  payload: WhatsAppButtonConfirmation,
  now: Date,
  extraFilter: Record<string, unknown> = {}
) => {
  const lastCustomerMessageText = payload.buttonText || payload.buttonPayload || 'CONFIRM_ORDER';

  return Order.findOneAndUpdate(
    { ...extraFilter, _id: orderId, customerConfirmationStatus: { $in: CONFIRMABLE_BY_BUTTON } },
    {
      $set: {
        customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
        confirmationSource: ConfirmationSource.WHATSAPP_BUTTON,
        confirmedAt: now,
        lastCustomerMessageAt: now,
        lastCustomerMessageText,
        confirmationPayload: payload,
        needsHelpdeskAttention: false,
        operationalStatus: OrderOperationalStatus.TO_DELIVER
      },
      $unset: { attentionReason: '', attentionReasonCode: '', attentionRequiredAt: '' }
    },
    { new: true }
  );
};

// Effects of a WhatsApp confirmation once written: CONFIRMED event + confirmed template.
const recordWhatsAppConfirmation = async (confirmed: IOrder) => {
  await createOrderEvent({
    orderId: confirmed._id,
    type: OrderEventType.CONFIRMED,
    toStatus: OrderOperationalStatus.TO_DELIVER,
    metadata: { source: ConfirmationSource.WHATSAPP_BUTTON }
  });

  return enqueueConfirmedTemplate(confirmed._id);
};

const applyWhatsAppConfirmation = async (orderId: string, payload: WhatsAppButtonConfirmation, now: Date) => {
  const confirmed = await writeWhatsAppConfirmation(orderId, payload, now);

  if (!confirmed) {
    return null;
  }

  const { message, job } = await recordWhatsAppConfirmation(confirmed);

  return { order: confirmed, message, job };
};

export class OrderConfirmationService {
  public static async confirmByWhatsAppButton(orderId: string, payload: WhatsAppButtonConfirmation) {
    ensureObjectId(orderId);

    const lastCustomerMessageText = payload.buttonText || payload.buttonPayload || 'CONFIRM_ORDER';
    const now = new Date();
    const confirmed = await applyWhatsAppConfirmation(orderId, payload, now);

    if (confirmed) {
      return { ...confirmed, alreadyConfirmed: false, needsAttention: false };
    }

    const order = await getOrderOrThrow(orderId);

    if (order.customerConfirmationStatus === CustomerConfirmationStatus.CONFIRMED) {
      return { order, message: undefined, job: undefined, alreadyConfirmed: true, needsAttention: false };
    }

    // Late confirmation on an expired/cancelled order: never auto-confirm, route to helpdesk.
    order.customerConfirmationStatus = CustomerConfirmationStatus.NEEDS_ATTENTION;
    order.needsHelpdeskAttention = true;
    order.lastCustomerMessageAt = now;
    order.lastCustomerMessageText = lastCustomerMessageText;
    order.confirmationPayload = payload;
    order.attentionReason = 'Confirmation received after expiration or cancellation';
    order.attentionReasonCode = AttentionReasonCode.LATE_CONFIRM;
    order.attentionRequiredAt = now;
    await order.save();

    return { order, message: undefined, job: undefined, alreadyConfirmed: false, needsAttention: true };
  }

  /**
   * Handles the pre-filled "Je confirme ma commande #1234" message. Same sender as the
   * order phone: confirmed through the exact button path (source `whatsapp_button`).
   * Different sender: no confirmation, the order goes to the helpdesk queue with the
   * `phone_mismatch` reason and a `phone_mismatch` event is recorded for counting.
   * `not_applicable` means the caller keeps its regular handling of the message.
   */
  public static async confirmByPrefilledMessage(
    input: PrefilledConfirmationInput
  ): Promise<PrefilledConfirmationResult> {
    const text = input.text?.trim();
    const orderNames = parsePrefilledConfirmationText(text);
    let order: IOrder | null = null;

    for (const shopifyOrderName of orderNames) {
      order = await Order.findOne({ shopifyOrderName });

      if (order) {
        break;
      }
    }

    if (!order || !acceptsPrefilledConfirmation(order)) {
      return { outcome: 'not_applicable' };
    }

    const { matches, senderE164 } = isSenderOrderPhone(input.from, order.customerPhoneE164);

    if (matches) {
      const confirmed = await writeWhatsAppConfirmation(
        order._id.toString(),
        { buttonText: text, waMessageId: input.waMessageId },
        new Date(),
        PREFILLED_WRITE_GUARD
      );

      if (confirmed) {
        // The order is confirmed and stays so: a failed event or template enqueue (Redis
        // down) must not stop the inbound message from being recorded and mirrored.
        try {
          await recordWhatsAppConfirmation(confirmed);
        } catch (err) {
          log.error(
            { err, orderId: confirmed._id },
            'Pre-filled WhatsApp confirmation applied but its event or confirmed template failed'
          );
        }

        return { outcome: 'confirmed', order: confirmed };
      }

      // A concurrent transition (confirmation, cancellation, expiration, delivery) won the write.
      // Unlike the button, the late-confirmation fallback is NOT applied here: it would
      // re-open a cancelled order to `needs_attention`, letting a later text confirm it.
      const current = await Order.findById(order._id);
      log.info(
        { orderId: order._id, customerConfirmationStatus: current?.customerConfirmationStatus },
        'Pre-filled WhatsApp confirmation lost a concurrent transition'
      );

      return { outcome: 'not_applicable' };
    }

    const now = new Date();
    // Conditional write: a concurrent confirmation or cancellation wins and the message
    // then falls back to the regular handling. An order already flagged phone_mismatch is
    // not written again, so a single phone_mismatch event exists per order. The
    // confirmation status is left as is so the pending-order reminders keep running.
    const flagged = await Order.findOneAndUpdate(
      {
        ...PREFILLED_WRITE_GUARD,
        _id: order._id,
        customerConfirmationStatus: { $in: CONFIRMABLE_BY_BUTTON },
        attentionReasonCode: { $ne: AttentionReasonCode.PHONE_MISMATCH }
      },
      {
        $set: {
          needsHelpdeskAttention: true,
          attentionReasonCode: AttentionReasonCode.PHONE_MISMATCH,
          attentionReason: PHONE_MISMATCH_ATTENTION_REASON,
          attentionRequiredAt: now,
          lastCustomerMessageAt: now,
          lastCustomerMessageText: text
        }
      },
      { new: true }
    );

    if (!flagged) {
      // Already flagged (repeated or concurrent message): keep the phone_mismatch reason
      // instead of letting the regular handling overwrite it, without a second event.
      const current = await Order.findById(order._id);

      if (
        current &&
        acceptsPrefilledConfirmation(current) &&
        current.attentionReasonCode === AttentionReasonCode.PHONE_MISMATCH
      ) {
        return { outcome: 'phone_mismatch', order: current, senderE164 };
      }

      return { outcome: 'not_applicable' };
    }

    // The order is already flagged: a failed audit event must not stop the inbound
    // message from being recorded and mirrored to Chatwoot.
    try {
      await createOrderEvent({
        orderId: flagged._id,
        type: OrderEventType.PHONE_MISMATCH,
        metadata: { senderE164: senderE164 ?? null, waMessageId: input.waMessageId }
      });
    } catch (err) {
      log.error({ err, orderId: flagged._id }, 'Failed to record phone_mismatch order event');
    }

    return { outcome: 'phone_mismatch', order: flagged, senderE164 };
  }

  public static async confirmByAdmin(
    orderId: string,
    actorId?: string,
    source: AdminConfirmationSource = ConfirmationSource.ADMIN
  ) {
    ensureObjectId(orderId);

    const now = new Date();
    const order = await Order.findOneAndUpdate(
      { _id: orderId, customerConfirmationStatus: { $in: CONFIRMABLE_BY_ADMIN } },
      {
        $set: {
          customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
          confirmationSource: source,
          confirmedAt: now,
          needsHelpdeskAttention: false,
          operationalStatus: OrderOperationalStatus.TO_DELIVER
        },
        $unset: { attentionReason: '', attentionReasonCode: '', attentionRequiredAt: '' }
      },
      { new: true }
    );

    if (!order) {
      const exists = await Order.exists({ _id: orderId });

      if (!exists) {
        throw new OrderConfirmationError('OrderNotFound', 'Order not found', 404);
      }

      throw new OrderConfirmationError(
        'OrderConfirmationNotAllowed',
        'Order cannot be confirmed from its current status',
        409
      );
    }

    await createOrderEvent({
      orderId: order._id,
      type: OrderEventType.CONFIRMED,
      toStatus: OrderOperationalStatus.TO_DELIVER,
      actorId,
      metadata: { source }
    });

    const { message, job } = await enqueueConfirmedTemplate(order._id);

    return { order, message, job };
  }

  // Appel sans réponse : la commande (re)vient dans « À traiter » avec le motif UNREACHABLE
  // pour être relancée. La tentative est tracée en note (auteur + date) et en aperçu de liste.
  public static async markUnreachable(orderId: string, note?: string, actorId?: string) {
    ensureObjectId(orderId);

    const trimmedNote = note?.trim();
    if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
      throw new OrderConfirmationError('NoteTextTooLong', `A note cannot exceed ${MAX_NOTE_LENGTH} characters`, 400);
    }
    const noteText = trimmedNote || DEFAULT_UNREACHABLE_NOTE;

    const now = new Date();
    const order = await Order.findOneAndUpdate(
      { _id: orderId, customerConfirmationStatus: { $in: CONFIRMABLE_BY_ADMIN } },
      {
        $set: {
          needsHelpdeskAttention: true,
          attentionReasonCode: AttentionReasonCode.UNREACHABLE,
          attentionReason: noteText,
          attentionRequiredAt: now,
          lastNoteText: noteText,
          lastNoteAt: now
        }
      },
      { new: true }
    );

    if (!order) {
      const exists = await Order.exists({ _id: orderId });

      if (!exists) {
        throw new OrderConfirmationError('OrderNotFound', 'Order not found', 404);
      }

      throw new OrderConfirmationError(
        'OrderUnreachableNotAllowed',
        'Only orders awaiting confirmation can be marked unreachable',
        409
      );
    }

    const event = await createOrderEvent({
      orderId: order._id,
      type: OrderEventType.NOTE,
      actorId,
      note: noteText,
      metadata: { attentionReasonCode: AttentionReasonCode.UNREACHABLE }
    });

    return { order, event };
  }

  public static async cancelByAdmin(orderId: string, reason?: string, actorId?: string) {
    const order = await getOrderOrThrow(orderId);
    const trimmedReason = reason?.trim();

    if (!trimmedReason) {
      throw new OrderConfirmationError('OrderCancelReasonRequired', 'A cancellation reason is required', 400);
    }

    if (trimmedReason.length > MAX_CANCELLATION_REASON_LENGTH) {
      throw new OrderConfirmationError(
        'OrderCancelReasonTooLong',
        `Cancellation reason must not exceed ${MAX_CANCELLATION_REASON_LENGTH} characters`,
        400
      );
    }

    if (!getOrderActionCapabilities(order).canCancel) {
      const isTerminalOperationalStatus =
        order.operationalStatus === OrderOperationalStatus.DELIVERED ||
        order.operationalStatus === OrderOperationalStatus.RETURNED;

      if (isTerminalOperationalStatus) {
        throw new OrderConfirmationError(
          'OrderCancellationNotAllowedAfterDelivery',
          'Order has been delivered or returned and can no longer be cancelled',
          409
        );
      }

      throw new OrderConfirmationError('OrderCancellationNotAllowed', 'Order is already cancelled', 409);
    }

    order.customerConfirmationStatus = CustomerConfirmationStatus.CANCELLED;
    order.confirmationCancelledAt = new Date();
    order.confirmationCancelReason = trimmedReason;
    order.needsHelpdeskAttention = false;
    order.attentionReason = undefined;
    order.attentionReasonCode = undefined;
    order.attentionRequiredAt = undefined;
    await order.save();
    await createOrderEvent({
      orderId: order._id,
      type: OrderEventType.CANCELLED,
      actorId,
      note: trimmedReason
    });

    // Inform the customer explicitly when a cancellation template is configured at Meta.
    let notification: Awaited<ReturnType<typeof enqueueCancelledTemplate>> | undefined;

    if (config.metaWhatsApp.cancelledTemplateName && order.customerPhoneE164) {
      notification = await enqueueCancelledTemplate(order._id);
    } else {
      log.warn(
        {
          orderId: order._id,
          hasTemplate: Boolean(config.metaWhatsApp.cancelledTemplateName),
          hasPhone: Boolean(order.customerPhoneE164)
        },
        'Order cancelled without customer notification (missing cancellation template or phone)'
      );
    }

    return { order, notification };
  }

  public static async remindByAdmin(orderId: string, actorId?: string) {
    const order = await getOrderOrThrow(orderId);

    if (order.customerConfirmationStatus !== CustomerConfirmationStatus.PENDING) {
      throw new OrderConfirmationError('OrderReminderNotAllowed', 'Only pending orders can be reminded', 409);
    }

    if (!order.customerPhoneE164) {
      throw new OrderConfirmationError('OrderPhoneRequired', 'A valid customer phone is required', 409);
    }

    if ((order.reminderCount || 0) >= config.confirmation.maxReminders) {
      throw new OrderConfirmationError('OrderReminderLimitReached', 'Maximum number of reminders reached', 409);
    }

    const cooldownMs = config.confirmation.reminderCooldownMinutes * 60 * 1000;

    if (order.lastReminderAt && Date.now() - order.lastReminderAt.getTime() < cooldownMs) {
      throw new OrderConfirmationError('OrderReminderTooSoon', 'A reminder was sent too recently', 409);
    }

    // Optimistic claim: guard on the current reminderCount so a concurrent reminder
    // (manual or automatic sweep) cannot produce a duplicate send.
    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
        reminderCount: order.reminderCount || 0
      },
      {
        $inc: { reminderCount: 1 },
        $set: { lastReminderAt: new Date(), lastReminderSource: ReminderSource.ADMIN }
      },
      { new: true }
    );

    if (!claimed) {
      throw new OrderConfirmationError('OrderReminderConflict', 'Reminder could not be claimed, try again', 409);
    }

    const { message, job } = await dispatchReminderMessage(claimed._id);
    await createOrderEvent({
      orderId: claimed._id,
      type: OrderEventType.REMINDED,
      actorId,
      metadata: { source: ReminderSource.ADMIN, reminderCount: claimed.reminderCount }
    });

    return { order: claimed, message, job };
  }

  // Periodic sweep driving automatic reminders (24h, 48h) and expiration (after maxReminders).
  public static async runConfirmationMaintenance() {
    const now = Date.now();
    const { firstReminderHours, secondReminderHours, expireHours, maxReminders } = config.confirmation;

    let firstReminders = 0;
    let secondReminders = 0;
    let expired = 0;

    // 1) Expire pending orders that exhausted their reminders without any response.
    const expireResult = await Order.updateMany(
      {
        customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
        reminderCount: { $gte: maxReminders },
        createdAt: { $lte: new Date(now - expireHours * 60 * 60 * 1000) }
      },
      {
        $set: {
          customerConfirmationStatus: CustomerConfirmationStatus.EXPIRED,
          expiredAt: new Date()
        }
      }
    );
    expired = expireResult.modifiedCount ?? 0;

    // 2) Second reminder (~48h, reminderCount === 1).
    secondReminders = await OrderConfirmationService.dispatchDueReminders({
      currentCount: 1,
      olderThan: new Date(now - secondReminderHours * 60 * 60 * 1000)
    });

    // 3) First reminder (~24h, reminderCount === 0).
    firstReminders = await OrderConfirmationService.dispatchDueReminders({
      currentCount: 0,
      olderThan: new Date(now - firstReminderHours * 60 * 60 * 1000)
    });

    if (expired || firstReminders || secondReminders) {
      log.info({ expired, firstReminders, secondReminders }, 'Confirmation maintenance sweep completed');
    }

    return { expired, firstReminders, secondReminders };
  }

  private static async dispatchDueReminders(input: { currentCount: number; olderThan: Date }) {
    const candidates = await Order.find({
      customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
      reminderCount: input.currentCount,
      createdAt: { $lte: input.olderThan },
      customerPhoneE164: { $exists: true, $nin: [null, ''] }
    })
      .select('_id')
      .limit(200);

    let sent = 0;

    for (const candidate of candidates) {
      const claimed = await OrderConfirmationService.claimReminder(candidate._id, input.currentCount);

      if (!claimed) {
        continue;
      }

      try {
        await dispatchReminderMessage(claimed._id);
        sent += 1;
      } catch (err) {
        log.error({ err, orderId: claimed._id }, 'Failed to dispatch automatic reminder');
      }
    }

    return sent;
  }

  private static claimReminder(orderId: IOrder['_id'], currentCount: number) {
    return Order.findOneAndUpdate(
      {
        _id: orderId,
        customerConfirmationStatus: CustomerConfirmationStatus.PENDING,
        reminderCount: currentCount
      },
      {
        $inc: { reminderCount: 1 },
        $set: { lastReminderAt: new Date(), lastReminderSource: ReminderSource.AUTO }
      },
      { new: true }
    );
  }
}
