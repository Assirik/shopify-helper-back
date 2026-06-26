import { Types } from 'mongoose';
import { Message, MessageChannel, MessageProvider, MessageStatus, TemplatePurpose } from '../../models/Message';
import {
  AttentionReasonCode,
  ConfirmationSource,
  CustomerConfirmationStatus,
  IOrder,
  Order,
  ReminderSource
} from '../../models/Order';
import {
  enqueueConfirmationReminder,
  enqueueOrderCancelled,
  enqueueOrderConfirmed
} from '../../queues/notification.queue';
import config from '../config/env.config';
import log from '../logger/logger';

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

export const CONFIRMABLE_BY_ADMIN = [
  CustomerConfirmationStatus.PENDING,
  CustomerConfirmationStatus.NEEDS_ATTENTION,
  CustomerConfirmationStatus.SMS_ONLY,
  CustomerConfirmationStatus.EXPIRED
];

const CONFIRMABLE_BY_BUTTON = [
  CustomerConfirmationStatus.PENDING,
  CustomerConfirmationStatus.NEEDS_ATTENTION,
  CustomerConfirmationStatus.SMS_ONLY
];

export interface OrderActionCapabilities {
  canConfirm: boolean;
  canRemind: boolean;
  canCancel: boolean;
}

export const getOrderActionCapabilities = (
  order: Pick<IOrder, 'customerConfirmationStatus' | 'reminderCount' | 'lastReminderAt' | 'customerPhoneE164'>,
  now = Date.now()
): OrderActionCapabilities => {
  const reminderCooldownMs = config.confirmation.reminderCooldownMinutes * 60 * 1000;
  const reminderCooldownElapsed = !order.lastReminderAt || now - order.lastReminderAt.getTime() >= reminderCooldownMs;

  return {
    canConfirm: CONFIRMABLE_BY_ADMIN.includes(order.customerConfirmationStatus),
    canRemind:
      order.customerConfirmationStatus === CustomerConfirmationStatus.PENDING &&
      Boolean(order.customerPhoneE164) &&
      (order.reminderCount || 0) < config.confirmation.maxReminders &&
      reminderCooldownElapsed,
    canCancel: order.customerConfirmationStatus !== CustomerConfirmationStatus.CANCELLED
  };
};

export class OrderConfirmationService {
  public static async confirmByWhatsAppButton(orderId: string, payload: WhatsAppButtonConfirmation) {
    ensureObjectId(orderId);

    const lastCustomerMessageText = payload.buttonText || payload.buttonPayload || 'CONFIRM_ORDER';
    const now = new Date();

    // Atomic confirm: only one writer can flip a confirmable status to CONFIRMED, so the
    // confirmed template is enqueued at most once even with concurrent admin/button actions.
    const confirmed = await Order.findOneAndUpdate(
      { _id: orderId, customerConfirmationStatus: { $in: CONFIRMABLE_BY_BUTTON } },
      {
        $set: {
          customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
          confirmationSource: ConfirmationSource.WHATSAPP_BUTTON,
          confirmedAt: now,
          lastCustomerMessageAt: now,
          lastCustomerMessageText,
          confirmationPayload: payload,
          needsHelpdeskAttention: false
        },
        $unset: { attentionReason: '', attentionReasonCode: '', attentionRequiredAt: '' }
      },
      { new: true }
    );

    if (confirmed) {
      const { message, job } = await enqueueConfirmedTemplate(confirmed._id);
      return { order: confirmed, message, job, alreadyConfirmed: false, needsAttention: false };
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

  public static async confirmByAdmin(orderId: string) {
    ensureObjectId(orderId);

    const order = await Order.findOneAndUpdate(
      { _id: orderId, customerConfirmationStatus: { $in: CONFIRMABLE_BY_ADMIN } },
      {
        $set: {
          customerConfirmationStatus: CustomerConfirmationStatus.CONFIRMED,
          confirmationSource: ConfirmationSource.ADMIN,
          confirmedAt: new Date(),
          needsHelpdeskAttention: false
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

    const { message, job } = await enqueueConfirmedTemplate(order._id);

    return { order, message, job };
  }

  public static async cancelByAdmin(orderId: string, reason?: string) {
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

  public static async remindByAdmin(orderId: string) {
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
