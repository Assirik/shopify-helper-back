import { AttentionReasonCode, CustomerConfirmationStatus, NotificationStatus, Order } from '../../models/Order';

export interface AttentionBackfillResult {
  lateConfirm: number;
  freeText: number;
  smsOnly: number;
  invalidNumber: number;
  total: number;
}

const missingReason = { attentionReasonCode: { $exists: false } };

export const backfillAttentionQueue = async (): Promise<AttentionBackfillResult> => {
  const lateConfirm = await Order.updateMany(
    {
      ...missingReason,
      needsHelpdeskAttention: true,
      attentionReason: 'Confirmation received after expiration or cancellation'
    },
    [
      {
        $set: {
          attentionReasonCode: AttentionReasonCode.LATE_CONFIRM,
          attentionRequiredAt: { $ifNull: ['$lastCustomerMessageAt', { $ifNull: ['$updatedAt', '$createdAt'] }] }
        }
      }
    ]
  );

  const freeText = await Order.updateMany(
    {
      ...missingReason,
      needsHelpdeskAttention: true,
      lastCustomerMessageAt: { $exists: true }
    },
    [
      {
        $set: {
          attentionReasonCode: AttentionReasonCode.FREE_TEXT,
          attentionRequiredAt: { $ifNull: ['$lastCustomerMessageAt', { $ifNull: ['$updatedAt', '$createdAt'] }] }
        }
      }
    ]
  );

  const smsOnly = await Order.updateMany(
    {
      ...missingReason,
      customerConfirmationStatus: CustomerConfirmationStatus.SMS_ONLY
    },
    [
      {
        $set: {
          needsHelpdeskAttention: true,
          attentionReasonCode: AttentionReasonCode.SMS_ONLY,
          attentionReason: { $ifNull: ['$attentionReason', 'Confirmation request delivered by SMS'] },
          attentionRequiredAt: { $ifNull: ['$updatedAt', '$createdAt'] }
        }
      }
    ]
  );

  const invalidNumber = await Order.updateMany(
    {
      ...missingReason,
      notificationStatus: NotificationStatus.FAILED,
      // On ne réactive jamais une commande déjà résolue: confirmer/annuler/expirer
      // retire le code d'attention, ce qui la rendrait sinon de nouveau éligible ici.
      customerConfirmationStatus: {
        $nin: [
          CustomerConfirmationStatus.CONFIRMED,
          CustomerConfirmationStatus.CANCELLED,
          CustomerConfirmationStatus.EXPIRED
        ]
      },
      $or: [{ customerPhoneE164: { $exists: false } }, { customerPhoneE164: '' }]
    },
    [
      {
        $set: {
          needsHelpdeskAttention: true,
          attentionReasonCode: AttentionReasonCode.INVALID_NUMBER,
          attentionReason: { $ifNull: ['$attentionReason', 'Invalid customer phone number'] },
          attentionRequiredAt: { $ifNull: ['$createdAt', '$updatedAt'] }
        }
      }
    ]
  );

  const result = {
    lateConfirm: lateConfirm.modifiedCount,
    freeText: freeText.modifiedCount,
    smsOnly: smsOnly.modifiedCount,
    invalidNumber: invalidNumber.modifiedCount,
    total: 0
  };

  result.total = result.lateConfirm + result.freeText + result.smsOnly + result.invalidNumber;
  return result;
};
