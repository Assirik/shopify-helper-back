import { CustomerConfirmationStatus, IOrder, OrderOperationalStatus } from '../../models/Order';
import config from '../config/env.config';

export const CONFIRMABLE_BY_ADMIN = [
  CustomerConfirmationStatus.PENDING,
  CustomerConfirmationStatus.NEEDS_ATTENTION,
  CustomerConfirmationStatus.SMS_ONLY,
  CustomerConfirmationStatus.EXPIRED
];

export interface OrderActionCapabilities {
  canConfirm: boolean;
  canRemind: boolean;
  canCancel: boolean;
  canDispatch: boolean;
  canDeliver: boolean;
  canMarkFailed: boolean;
  canReturn: boolean;
}

export const getOrderActionCapabilities = (
  order: Pick<
    IOrder,
    'customerConfirmationStatus' | 'reminderCount' | 'lastReminderAt' | 'customerPhoneE164' | 'operationalStatus'
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
      reminderCooldownElapsed,
    canCancel:
      order.customerConfirmationStatus !== CustomerConfirmationStatus.CANCELLED && !isTerminalOperationalStatus,
    canDispatch,
    canDeliver: canActOnActiveDelivery,
    canMarkFailed: canActOnActiveDelivery,
    canReturn:
      order.operationalStatus === OrderOperationalStatus.IN_DELIVERY ||
      order.operationalStatus === OrderOperationalStatus.DELIVERY_FAILED
  };
};
