import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../queues/notification.queue', () => ({
  CONFIRMATION_SWEEP_JOB: 'confirmation-sweep',
  MAINTENANCE_QUEUE_NAME: 'maintenance',
  NOTIFICATION_QUEUE_NAME: 'notifications',
  SEND_CONFIRMATION_REMINDER_JOB: 'send-confirmation-reminder',
  SEND_ORDER_CANCELLED_JOB: 'send-order-cancelled',
  SEND_ORDER_CONFIRMED_JOB: 'send-order-confirmed',
  SEND_ORDER_CONFIRMATION_JOB: 'send-order-confirmation',
  enqueueOrderConfirmation: jest.fn(),
  getRedisConnection: jest.fn()
}));

import { IOrder } from '../models/Order';
import { TemplatePurpose } from '../models/Message';
import { buildTemplateVariables, getOrderDeliveryRegion } from './notification.worker';

const buildOrder = (overrides: Partial<IOrder> = {}) => {
  return {
    shopifyOrderName: '#1001',
    customerName: 'Isadore Mangala Ndoye',
    lineItems: [{ title: 'Produit test', quantity: 1 }],
    totalPrice: '25000.00',
    paymentGatewayNames: ['visa'],
    isCashOnDelivery: false,
    ...overrides
  } as IOrder;
};

describe('notification worker message variables', () => {
  it('resolves the immutable delivery region from the order snapshot first', () => {
    const order = buildOrder({
      deliveryRegionCode: 'SN_ZG',
      deliveryRegion: 'Ziguinchor',
      shippingRegion: 'Dakar'
    });

    expect(getOrderDeliveryRegion(order)).toBe('SN_ZG');
  });

  it('falls back to legacy shippingRegion for orders created before step 16', () => {
    expect(getOrderDeliveryRegion(buildOrder({ shippingRegion: 'Thiès' }))).toBe('Thiès');
  });

  it('never applies the configured COD payment text to a non-COD order', () => {
    const variables = buildTemplateVariables(
      buildOrder(),
      null,
      TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
      { paymentMethod: 'Paiement à la livraison configuré' }
    );

    expect(variables.find(variable => variable.name === 'payment_method')?.value).toBe('visa');
  });

  it('applies the regional payment override to a COD order', () => {
    const variables = buildTemplateVariables(
      buildOrder({ isCashOnDelivery: true, paymentGatewayNames: ['Cash on Delivery (COD)'] }),
      null,
      TemplatePurpose.ORDER_CONFIRMATION_REQUEST,
      { paymentMethod: 'Paiement à la livraison configuré' }
    );

    expect(variables.find(variable => variable.name === 'payment_method')?.value).toBe(
      'Paiement à la livraison configuré'
    );
  });
});
