import { describe, expect, it } from '@jest/globals';
import { buildMetaOrderConfirmationPayload, createOrderConfirmationButtonPayload } from './metaWhatsApp.provider';

describe('buildMetaOrderConfirmationPayload', () => {
  it('adds a dynamic quick reply payload for order confirmation', () => {
    const buttonPayload = createOrderConfirmationButtonPayload('order-123');
    const payload = buildMetaOrderConfirmationPayload({
      orderId: 'order-123',
      to: '+221771234567',
      templateName: 'order_confirm_auto_schedule',
      templateLanguage: 'fr_FR',
      buttonPayload,
      variables: [
        { name: 'greeting', value: 'Bonjour' },
        { name: 'order_no', value: '#1001' }
      ]
    });

    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: '221771234567',
      type: 'template',
      template: {
        name: 'order_confirm_auto_schedule',
        language: {
          code: 'fr_FR'
        }
      }
    });
    expect(payload.template.components[0]).toEqual({
      type: 'body',
      parameters: [
        { type: 'text', parameter_name: 'greeting', text: 'Bonjour' },
        { type: 'text', parameter_name: 'order_no', text: '#1001' }
      ]
    });
    expect(payload.template.components[1]).toEqual({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [
        {
          type: 'payload',
          payload: 'CONFIRM_ORDER:order-123'
        }
      ]
    });
  });
});
