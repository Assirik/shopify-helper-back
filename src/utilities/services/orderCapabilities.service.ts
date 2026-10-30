import { CustomerConfirmationStatus, IOrder, OrderOperationalStatus } from '../../models/Order';
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

export interface OrderActionCapabilities {
  canConfirm: boolean;
  canRemind: boolean;
  canCancel: boolean;
  canDispatch: boolean;
  canDeliver: boolean;
  canMarkFailed: boolean;
  canReturn: boolean;
  canMarkUnreachable: boolean;
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
  >,
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
    canMarkUnreachable: CONFIRMABLE_BY_ADMIN.includes(order.customerConfirmationStatus)
  };
};
