import axios from 'axios';
import config from '../utilities/config/env.config';
import { ProviderError, ProviderResult, SmsInput, SmsProvider } from './messaging.provider';

interface TermiiSmsResponse {
  message_id?: string;
  message?: string;
  code?: string;
  balance?: number;
  user?: string;
}

export const buildOrderConfirmationSmsText = (input: {
  customerName?: string;
  orderName: string;
  totalPrice: string;
  currency: string;
}) => {
  const customerName = input.customerName || 'Client';

  return `Bonjour ${customerName}, votre commande ${input.orderName} de ${input.totalPrice} ${input.currency} a bien été reçue. Merci.`;
};

export const buildTermiiSmsPayload = (input: SmsInput) => {
  return {
    to: input.to.replace(/^\+/, ''),
    from: config.termii.senderId,
    sms: input.text,
    type: 'plain',
    channel: 'generic',
    api_key: config.termii.apiKey
  };
};

export class TermiiSmsProvider implements SmsProvider {
  public async sendSms(input: SmsInput): Promise<ProviderResult> {
    if (!config.termii.apiKey || !config.termii.senderId) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Termii SMS credentials are missing');
    }

    const url = `${config.termii.baseUrl.replace(/\/$/, '')}/api/sms/send`;
    const payload = buildTermiiSmsPayload(input);

    try {
      const response = await axios.post<TermiiSmsResponse>(url, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;
      const accepted = Boolean(data.message_id) || data.code === 'ok';

      if (!accepted) {
        throw new ProviderError('TERMII_REJECTED', `Termii SMS rejected: ${JSON.stringify(data)}`);
      }

      return {
        providerMessageId: data.message_id,
        response: data
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        throw err;
      }

      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const code = status ? `TERMII_HTTP_${status}` : 'TERMII_NETWORK_ERROR';
        throw new ProviderError(code, `Termii SMS request failed: ${status || 'NO_STATUS'} ${JSON.stringify(err.response?.data || err.message)}`);
      }

      throw err;
    }
  }
}
