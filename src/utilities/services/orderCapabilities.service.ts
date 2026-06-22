import { CustomerConfirmationStatus, IOrder } from '../../models/Order';
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
