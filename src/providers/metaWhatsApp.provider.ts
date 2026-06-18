import axios from 'axios';
import config from '../utilities/config/env.config';
import { MessagingProvider, OrderConfirmationInput, ProviderError, ProviderResult } from './messaging.provider';

interface MetaWhatsAppMessageResponse {
  messages?: Array<{
    id?: string;
  }>;
}

type TemplateParameter = { type: 'text'; text: string } | { type: 'payload'; payload: string };

interface MetaTemplateComponent {
  type: 'body' | 'button';
  sub_type?: 'quick_reply';
  index?: string;
  parameters: TemplateParameter[];
}

export const createOrderConfirmationButtonPayload = (orderId: string) => `CONFIRM_ORDER:${orderId}`;

export const buildMetaOrderConfirmationPayload = (input: OrderConfirmationInput) => {
  const bodyParameters: TemplateParameter[] = [
    input.variables.greeting,
    input.variables.customerName,
    input.variables.orderName,
    input.variables.itemName,
    input.variables.amount,
    input.variables.quantity,
    input.variables.address,
    input.variables.shippingNote,
    input.variables.paymentMethod
  ].map(text => ({
    type: 'text',
    text
  }));

  const components: MetaTemplateComponent[] = [
    {
      type: 'body',
      parameters: bodyParameters
    },
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [
        {
          type: 'payload',
          payload: input.buttonPayload
        }
      ]
    }
  ];

  return {
    messaging_product: 'whatsapp',
    to: input.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: input.templateName,
      language: {
        code: input.templateLanguage
      },
      components
    }
  };
};

export class MetaWhatsAppProvider implements MessagingProvider {
  public async sendOrderConfirmation(input: OrderConfirmationInput): Promise<ProviderResult> {
    if (!config.metaWhatsApp.accessToken || !config.metaWhatsApp.phoneNumberId) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Meta WhatsApp credentials are missing');
    }

    const url = `https://graph.facebook.com/${config.metaWhatsApp.graphApiVersion}/${config.metaWhatsApp.phoneNumberId}/messages`;
    const payload = buildMetaOrderConfirmationPayload(input);

    try {
      const response = await axios.post<MetaWhatsAppMessageResponse>(url, payload, {
        headers: {
          Authorization: `Bearer ${config.metaWhatsApp.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      return {
        providerMessageId: response.data.messages?.[0]?.id,
        response: response.data
      };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const code = status ? `META_HTTP_${status}` : 'META_NETWORK_ERROR';
        throw new ProviderError(
          code,
          `Meta WhatsApp request failed: ${status || 'NO_STATUS'} ${JSON.stringify(err.response?.data || err.message)}`
        );
      }

      throw err;
    }
  }
}
