import { describe, expect, it } from '@jest/globals';
import { buildOrderConfirmationSmsText, buildTermiiSmsPayload } from './termiiSms.provider';

describe('buildOrderConfirmationSmsText', () => {
  it('builds the MVP French fallback SMS text', () => {
    const text = buildOrderConfirmationSmsText({
      customerName: 'Awa Diop',
      orderName: '#1001',
      totalPrice: '25000',
      currency: 'XOF'
    });

    expect(text).toBe('Bonjour Awa Diop, votre commande #1001 de 25000 XOF a bien été reçue. Merci.');
  });
});

describe('buildTermiiSmsPayload', () => {
  it('formats the recipient for Termii without the leading plus sign', () => {
    const payload = buildTermiiSmsPayload({
      orderId: 'order-123',
      to: '+221771234567',
      text: 'Bonjour'
    });

    expect(payload).toMatchObject({
      to: '221771234567',
      sms: 'Bonjour',
      type: 'plain',
      channel: 'generic'
    });
  });
});
