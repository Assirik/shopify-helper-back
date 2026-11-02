import { CapiPurchaseStatus, CapiSkipReason, CustomerConfirmationStatus, IOrder, OrderOperationalStatus } from '../../models/Order';
import config from '../config/env.config';

export const CONFIRMABLE_BY_ADMIN = [
  CustomerConfirmationStatus.PENDING,
  CustomerConfirmationStatus.NEEDS_ATTENTION,
  CustomerConfirmationStatus.SMS_ONLY,
  CustomerConfirmationStatus.EXPIRED
];

// Closed orders: never asked for confirmation nor reminded again. Defined here (a leaf module)
// so the confirmation service and the notification worker share it without an import cycle.
export const TERMINAL_OPERATIONAL_STATUSES = [OrderOperationalStatus.DELIVERED, OrderOperationalStatus.RETURNED];

// Meta rejects events older than 7 days; keep a 1 h margin for queue and network delays.
// Defined here (leaf module) so the CAPI worker and the resend capability share it.
export const CAPI_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

/**
 * Order-side rules of the CAPI worker (`getSkipReason`), shared with the admin resend: a
 * Purchase is only sent for a real, confirmed or delivered order. While the send was delayed
 * (Meta 5xx, Redis) an agent may have cancelled the order, and a later customer message may
 * even have reopened it (needs_attention): neither is a sale, so the send is skipped. A
 * delivered order is a real sale whatever its confirmation status (cancelByAdmin leaves
 * operationalStatus untouched, delivery without confirmation is the fallback): it is sent.
 */
export const getOrderCapiSkipReason = (
  order: Pick<IOrder, 'shopifyCancelledAt' | 'customerConfirmationStatus' | 'deliveredAt'> & Partial<Pick<IOrder, 'isTest'>>
): CapiSkipReason.TEST | CapiSkipReason.CANCELLED | undefined => {
  if (order.isTest) {
    return CapiSkipReason.TEST;
  }

  if (order.shopifyCancelledAt) {
    return CapiSkipReason.CANCELLED;
  }

  if (order.customerConfirmationStatus !== CustomerConfirmationStatus.CONFIRMED && !order.deliveredAt) {
    return CapiSkipReason.CANCELLED;
  }

  return undefined;
};

// Meta deduplicates on event_id only within a limited window (about 48 h): once an attempt
// may have reached Meta (`capiPossiblyReceivedAt`), the Purchase is sent again (resend or
// automatic take-back) only within 47 h of that first attempt.
export const CAPI_RESEND_DEDUP_WINDOW_MS = 47 * 60 * 60 * 1000;

// Oldest first-attempt date still inside the deduplication window.
export const capiDedupWindowStart = (now = Date.now()) => new Date(now - CAPI_RESEND_DEDUP_WINDOW_MS);

export type CapiResendRejection =
  | 'CapiPurchaseAlreadySent'
  | 'CapiPurchaseNotResendable'
  | 'CapiPurchaseMayHaveBeenReceived'
  | 'CapiPurchaseTooOld'
  | 'CapiDisabled';

/**
 * Why an admin cannot resend the order's Purchase, or `undefined` when they can. Shared by
 * the resend route and the `canResendCapi` capability. Never for a test order nor an order
 * cancelled on Shopify (the worker always skips them). Eligible: FAILED (the worker decides
 * again), SKIPPED as `disabled`, or SKIPPED as `cancelled` once the order has become a sale
 * (confirmed or delivered, same rule as the worker); with an event date still accepted by
 * Meta and CAPI enabled. Once an attempt may have reached Meta (`capiPossiblyReceivedAt`),
 * nothing is resent 47 h or more after that first attempt: Meta may count it twice. Without
 * that mark, a FAILED Purchase is resent after a certain refusal, or within 47 h of the failure.
 */
export const getCapiResendRejection = (
  order: Pick<
    IOrder,
    | 'capiPurchaseStatus'
    | 'capiSkipReason'
    | 'capiPurchaseSentAt'
    | 'confirmedAt'
    | 'deliveredAt'
    | 'shopifyCancelledAt'
    | 'customerConfirmationStatus'
    | 'capiPurchaseFailedAt'
    | 'capiPurchaseFailureDefinitive'
    | 'capiPossiblyReceivedAt'
  > &
    Partial<Pick<IOrder, 'isTest'>>,
  now = Date.now()
): CapiResendRejection | undefined => {
  if (order.capiPurchaseStatus === CapiPurchaseStatus.SENT || order.capiPurchaseSentAt) {
    return 'CapiPurchaseAlreadySent';
  }

  const isSkipped = order.capiPurchaseStatus === CapiPurchaseStatus.SKIPPED;
  const resendable =
    !order.isTest &&
    !order.shopifyCancelledAt &&
    (order.capiPurchaseStatus === CapiPurchaseStatus.FAILED ||
      (isSkipped && order.capiSkipReason === CapiSkipReason.DISABLED) ||
      // The reason no longer holds: the order is now a sale for the worker.
      (isSkipped && order.capiSkipReason === CapiSkipReason.CANCELLED && !getOrderCapiSkipReason(order)));

  if (!resendable) {
    return 'CapiPurchaseNotResendable';
  }

  if (order.capiPossiblyReceivedAt) {
    if (new Date(order.capiPossiblyReceivedAt).getTime() <= capiDedupWindowStart(now).getTime()) {
      return 'CapiPurchaseMayHaveBeenReceived';
    }
  } else if (order.capiPurchaseStatus === CapiPurchaseStatus.FAILED && !order.capiPurchaseFailureDefinitive) {
    const failedAt = order.capiPurchaseFailedAt ? new Date(order.capiPurchaseFailedAt).getTime() : undefined;

    if (failedAt === undefined || now - failedAt >= CAPI_RESEND_DEDUP_WINDOW_MS) {
      return 'CapiPurchaseMayHaveBeenReceived';
    }
  }

  // Same event date and limit as the worker's `too_old` rule.
  const eventDate = order.confirmedAt ?? order.deliveredAt;

  if (eventDate && now - new Date(eventDate).getTime() > CAPI_MAX_EVENT_AGE_MS) {
    return 'CapiPurchaseTooOld';
  }

  if (!config.metaCapi.enabled) {
    return 'CapiDisabled';
  }

  return undefined;
};

export interface OrderActionCapabilities {
  canConfirm: boolean;
  canRemind: boolean;
  canCancel: boolean;
  canDispatch: boolean;
  canDeliver: boolean;
  canMarkFailed: boolean;
  canReturn: boolean;
  canMarkUnreachable: boolean;
  canResendCapi: boolean;
}

export const getOrderActionCapabilities = (
  order: Pick<
    IOrder,
    | 'customerConfirmationStatus'
    | 'reminderCount'
    | 'lastReminderAt'
    | 'customerPhoneE164'
    | 'operationalStatus'
    | 'shopifyCancelledAt'
    | 'capiPurchaseStatus'
    | 'capiSkipReason'
    | 'capiPurchaseSentAt'
    | 'confirmedAt'
    | 'deliveredAt'
    | 'capiPurchaseFailedAt'
    | 'capiPurchaseFailureDefinitive'
    | 'capiPossiblyReceivedAt'
  > &
    Partial<Pick<IOrder, 'isTest'>>,
  now = Date.now()
): OrderActionCapabilities => {
  const reminderCooldownMs = config.confirmation.reminderCooldownMinutes * 60 * 1000;
  const reminderCooldownElapsed = !order.lastReminderAt || now - order.lastReminderAt.getTime() >= reminderCooldownMs;
  const isTerminalOperationalStatus =
    order.operationalStatus === OrderOperationalStatus.DELIVERED ||
    order.operationalStatus === OrderOperationalStatus.RETURNED;
  const canDispatch =
    order.operationalStatus === OrderOperationalStatus.TO_DELIVER ||
    order.operationalStatus === OrderOperationalStatus.DELIVERY_FAILED;
  const canActOnActiveDelivery = order.operationalStatus === OrderOperationalStatus.IN_DELIVERY;

  return {
    canConfirm: CONFIRMABLE_BY_ADMIN.includes(order.customerConfirmationStatus),
    canRemind:
      order.customerConfirmationStatus === CustomerConfirmationStatus.PENDING &&
      Boolean(order.customerPhoneE164) &&
      (order.reminderCount || 0) < config.confirmation.maxReminders &&
      reminderCooldownElapsed &&
      // Same exclusions as `remindByAdmin`: the API answers 409 for these orders.
      !order.shopifyCancelledAt &&
      !(order.operationalStatus && TERMINAL_OPERATIONAL_STATUSES.includes(order.operationalStatus)),
    canCancel:
      order.customerConfirmationStatus !== CustomerConfirmationStatus.CANCELLED && !isTerminalOperationalStatus,
    canDispatch,
    canDeliver: canActOnActiveDelivery,
    canMarkFailed: canActOnActiveDelivery,
    canReturn:
      order.operationalStatus === OrderOperationalStatus.IN_DELIVERY ||
      order.operationalStatus === OrderOperationalStatus.DELIVERY_FAILED,
    // « Injoignable » appartient à la phase de confirmation : mêmes statuts que la confirmation admin.
    canMarkUnreachable: CONFIRMABLE_BY_ADMIN.includes(order.customerConfirmationStatus),
    // Same rules as POST /orders/:id/capi-purchase/resend; the admin role is checked by the
    // route (requireAdmin) and by the front, not here.
    canResendCapi: !getCapiResendRejection(order, now)
  };
};
