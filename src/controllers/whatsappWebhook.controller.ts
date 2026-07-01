import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { InboundWhatsAppEvent, InboundWhatsAppEventStatus } from '../models/InboundWhatsAppEvent';
import { Message, MessageStatus } from '../models/Message';
import { AttentionReasonCode, CustomerConfirmationStatus, Order, OrderOperationalStatus } from '../models/Order';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';
import { OrderConfirmationService } from '../utilities/services/orderConfirmation.service';
import { PhoneNormalizationService } from '../utilities/services/phoneNormalization.service';

interface MetaWhatsAppButtonPayload {
  payload?: string;
  text?: string;
}

interface MetaWhatsAppInteractivePayload {
  button_reply?: {
    id?: string;
    title?: string;
  };
}

interface MetaWhatsAppMessagePayload {
  id?: string;
  from?: string;
  type?: string;
  text?: {
    body?: string;
  };
  button?: MetaWhatsAppButtonPayload;
  interactive?: MetaWhatsAppInteractivePayload;
}

interface MetaWhatsAppStatusPayload {
  id?: string;
  status?: string;
  recipient_id?: string;
  errors?: Array<{
    code?: string | number;
    title?: string;
    message?: string;
  }>;
}

interface MetaWhatsAppChangePayload {
  value?: {
    messages?: MetaWhatsAppMessagePayload[];
    statuses?: MetaWhatsAppStatusPayload[];
  };
}

const CONFIRM_ORDER_PREFIX = 'CONFIRM_ORDER:';

const getFirstString = (...values: Array<string | undefined | null>) => {
  return values.find(value => typeof value === 'string' && value.trim())?.trim();
};

const getChanges = (payload: unknown): MetaWhatsAppChangePayload[] => {
  const body = payload as {
    entry?: Array<{
      changes?: MetaWhatsAppChangePayload[];
    }>;
  };

  return (body.entry || []).flatMap(entry => entry.changes || []);
};

const extractButtonPayload = (message: MetaWhatsAppMessagePayload) => {
  return getFirstString(message.button?.payload, message.interactive?.button_reply?.id);
};

const extractButtonText = (message: MetaWhatsAppMessagePayload) => {
  return getFirstString(message.button?.text, message.interactive?.button_reply?.title);
};

const parseConfirmOrderPayload = (buttonPayload?: string) => {
  if (!buttonPayload?.startsWith(CONFIRM_ORDER_PREFIX)) {
    return undefined;
  }

  const orderId = buttonPayload.slice(CONFIRM_ORDER_PREFIX.length).trim();

  return Types.ObjectId.isValid(orderId) ? orderId : undefined;
};

const toMessageStatus = (status?: string) => {
  switch (status) {
    case MessageStatus.SENT:
      return MessageStatus.SENT;
    case MessageStatus.DELIVERED:
      return MessageStatus.DELIVERED;
    case MessageStatus.READ:
      return MessageStatus.READ;
    case MessageStatus.FAILED:
      return MessageStatus.FAILED;
    default:
      return undefined;
  }
};

const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
  [MessageStatus.QUEUED]: 0,
  [MessageStatus.SENDING]: 1,
  [MessageStatus.SENT]: 2,
  [MessageStatus.DELIVERED]: 3,
  [MessageStatus.READ]: 4
};

const updateMessageStatus = async (statusPayload: MetaWhatsAppStatusPayload, rawPayload: unknown) => {
  const nextStatus = toMessageStatus(statusPayload.status);

  if (!nextStatus || !statusPayload.id) {
    return { message: undefined, changed: false };
  }

  const message = await Message.findOne({ providerMessageId: statusPayload.id });

  if (!message) {
    return { message: undefined, changed: false };
  }

  // Forward-only progression: Meta callbacks can arrive out of order, never downgrade
  // sent -> delivered -> read. `failed` is terminal and always applies.
  if (nextStatus !== MessageStatus.FAILED) {
    const currentRank = STATUS_RANK[message.status] ?? -1;
    const nextRank = STATUS_RANK[nextStatus] ?? -1;

    if (nextRank <= currentRank) {
      return { message, changed: false };
    }
  }

  const error = statusPayload.errors?.[0];

  message.status = nextStatus;
  message.providerResponse = rawPayload;

  if (nextStatus === MessageStatus.FAILED) {
    message.errorCode = error?.code?.toString();
    message.errorMessage = error?.title || error?.message || 'Meta WhatsApp delivery failed';
  }

  await message.save();

  return { message, changed: true };
};

const findLatestOrderBySender = async (from?: string) => {
  const phone = PhoneNormalizationService.normalizeSenegalPhone(from);

  if (!phone.isValid || !phone.e164) {
    return undefined;
  }

  return Order.findOne({ customerPhoneE164: phone.e164 }).sort({ createdAt: -1 });
};

const handleConfirmButton = async (
  message: MetaWhatsAppMessagePayload,
  buttonPayload: string,
  buttonText: string | undefined,
  rawPayload: unknown
) => {
  const orderId = parseConfirmOrderPayload(buttonPayload);

  if (!orderId) {
    return InboundWhatsAppEvent.create({
      waMessageId: message.id,
      from: message.from,
      type: message.type,
      buttonPayload,
      buttonText,
      rawPayload,
      processedStatus: InboundWhatsAppEventStatus.IGNORED
    });
  }

  const order = await Order.findById(orderId);

  if (!order) {
    return InboundWhatsAppEvent.create({
      waMessageId: message.id,
      from: message.from,
      type: message.type,
      buttonPayload,
      buttonText,
      rawPayload,
      processedStatus: InboundWhatsAppEventStatus.FAILED
    });
  }

  const result = await OrderConfirmationService.confirmByWhatsAppButton(order._id.toString(), {
    buttonPayload,
    buttonText,
    waMessageId: message.id
  });

  if (result.alreadyConfirmed) {
    return InboundWhatsAppEvent.create({
      waMessageId: message.id,
      from: message.from,
      type: message.type,
      buttonPayload,
      buttonText,
      orderId: order._id,
      rawPayload,
      processedStatus: InboundWhatsAppEventStatus.IGNORED
    });
  }

  if (result.needsAttention) {
    return InboundWhatsAppEvent.create({
      waMessageId: message.id,
      from: message.from,
      type: message.type,
      buttonPayload,
      buttonText,
      orderId: order._id,
      rawPayload,
      processedStatus: InboundWhatsAppEventStatus.NEEDS_ATTENTION
    });
  }

  return InboundWhatsAppEvent.create({
    waMessageId: message.id,
    from: message.from,
    type: message.type,
    buttonPayload,
    buttonText,
    orderId: order._id,
    rawPayload,
    processedStatus: InboundWhatsAppEventStatus.PROCESSED
  });
};

// Confirmation statuses that must NOT be silently downgraded by an inbound reaction.
// A reaction is still surfaced to the helpdesk via `needsHelpdeskAttention`.
const PRESERVED_CONFIRMATION_STATUSES: CustomerConfirmationStatus[] = [
  CustomerConfirmationStatus.CONFIRMED,
  CustomerConfirmationStatus.CANCELLED,
  CustomerConfirmationStatus.EXPIRED
];

// Operational states where the order lifecycle is closed. A post-sale message
// (e.g. "merci") must NOT re-open the confirmation queue for these orders.
const COMPLETED_OPERATIONAL_STATUSES: OrderOperationalStatus[] = [
  OrderOperationalStatus.DELIVERED,
  OrderOperationalStatus.RETURNED
];

// Any inbound customer message that is not a valid CONFIRM_ORDER button (free text,
// image, audio, location, etc.) is treated as a reaction the helpdesk should review.
const handleCustomerReaction = async (message: MetaWhatsAppMessagePayload, rawPayload: unknown) => {
  const isText = message.type === 'text';
  const text = isText ? message.text?.body?.trim() : undefined;
  const summary = isText ? text || '[message vide]' : `[${message.type || 'message'}]`;
  const order = await findLatestOrderBySender(message.from);

  if (!order) {
    return InboundWhatsAppEvent.create({
      waMessageId: message.id,
      from: message.from,
      type: message.type,
      text,
      rawPayload,
      processedStatus: InboundWhatsAppEventStatus.IGNORED
    });
  }

  const reason = isText ? 'Customer replied with free text' : `Customer sent a ${message.type || 'non-text'} message`;
  const preserveStatus = PRESERVED_CONFIRMATION_STATUSES.includes(order.customerConfirmationStatus);
  // A delivered/returned order is closed: record the message for audit but never
  // re-open the helpdesk queue for it (post-sale "thanks" should not resurface it).
  const isCompleted =
    order.operationalStatus !== undefined && COMPLETED_OPERATIONAL_STATUSES.includes(order.operationalStatus);

  const set: Record<string, unknown> = {
    lastCustomerMessageAt: new Date(),
    lastCustomerMessageText: summary
  };

  if (!isCompleted) {
    set.needsHelpdeskAttention = true;
    set.attentionReason = reason;
    set.attentionReasonCode = AttentionReasonCode.FREE_TEXT;
    set.attentionRequiredAt = new Date();

    // Only downgrade to needs_attention when the order is not yet in a final
    // confirmation state; otherwise keep its status and just flag the helpdesk.
    if (!preserveStatus) {
      set.customerConfirmationStatus = CustomerConfirmationStatus.NEEDS_ATTENTION;
    }
  }

  await Order.findByIdAndUpdate(order._id, { $set: set });

  return InboundWhatsAppEvent.create({
    waMessageId: message.id,
    from: message.from,
    type: message.type,
    text,
    orderId: order._id,
    rawPayload,
    processedStatus: isCompleted
      ? InboundWhatsAppEventStatus.PROCESSED
      : InboundWhatsAppEventStatus.NEEDS_ATTENTION
  });
};

const handleInboundMessage = async (message: MetaWhatsAppMessagePayload, rawPayload: unknown) => {
  const buttonPayload = extractButtonPayload(message);
  const buttonText = extractButtonText(message);

  if (buttonPayload) {
    return handleConfirmButton(message, buttonPayload, buttonText, rawPayload);
  }

  return handleCustomerReaction(message, rawPayload);
};

// Meta redelivers webhooks on retries/slow acks. Dedup avoids re-applying side
// effects and duplicate audit rows. Statuses share the outbound `wamid`, so they
// are keyed by (waMessageId + type); inbound messages have a unique `wamid`.
const alreadyProcessed = async (filter: Record<string, unknown>) => {
  return Boolean(await InboundWhatsAppEvent.exists(filter));
};

export class WhatsAppWebhookController {
  public static async verify(req: Request, res: Response) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.metaWhatsApp.webhookVerifyToken && typeof challenge === 'string') {
      return res.status(200).send(challenge);
    }

    return res.status(403).json({ error: 'WhatsAppWebhookVerificationFailed' });
  }

  public static async receive(req: Request, res: Response) {
    const changes = getChanges(req.body);
    let inboundEvents = 0;
    let updatedStatusCount = 0;
    let duplicates = 0;

    for (const change of changes) {
      const value = change.value;

      for (const status of value?.statuses || []) {
        const type = `status:${status.status || 'unknown'}`;

        try {
          if (status.id && (await alreadyProcessed({ waMessageId: status.id, type }))) {
            duplicates += 1;
            continue;
          }

          const { message, changed } = await updateMessageStatus(status, req.body);

          if (changed) {
            updatedStatusCount += 1;
          }

          await InboundWhatsAppEvent.create({
            messageId: message?._id,
            waMessageId: status.id,
            from: status.recipient_id,
            type,
            rawPayload: req.body,
            processedStatus: message ? InboundWhatsAppEventStatus.PROCESSED : InboundWhatsAppEventStatus.IGNORED
          });
        } catch (err) {
          log.error({ err, waMessageId: status.id, status: status.status }, 'Failed to process WhatsApp status event');
        }
      }

      for (const message of value?.messages || []) {
        try {
          if (message.id && (await alreadyProcessed({ waMessageId: message.id }))) {
            duplicates += 1;
            continue;
          }

          await handleInboundMessage(message, req.body);
          inboundEvents += 1;
        } catch (err) {
          log.error({ err, waMessageId: message.id, type: message.type }, 'Failed to process WhatsApp inbound message');
        }
      }
    }

    log.info(
      {
        changes: changes.length,
        inboundEvents,
        updatedStatusCount,
        duplicates
      },
      'Processed WhatsApp webhook'
    );

    return res.status(200).json({
      accepted: true,
      inboundEvents,
      updatedStatusCount,
      duplicates
    });
  }
}
