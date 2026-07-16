import axios from 'axios';
import crypto from 'crypto';
import config from '../config/env.config';
import log from '../logger/logger';

const FORWARD_TIMEOUT_MS = 5000;

// Chatwoot is a display mirror of the WhatsApp thread; the backend stays the sole
// executor of the transactional flow. Forwarding must therefore NEVER fail the
// webhook processing: every error is logged and swallowed.
export class ChatwootForwardService {
  public static isEnabled(): boolean {
    return Boolean(config.chatwoot.url && config.chatwoot.whatsappPhoneNumber);
  }

  /**
   * Relays a raw Meta WhatsApp webhook payload to the Chatwoot ingestion endpoint
   * (POST {url}/webhooks/whatsapp/{phone_number}). The body must be the exact Meta
   * format; Chatwoot resolves the channel from the route param / payload metadata.
   */
  public static async forwardWhatsAppPayload(rawPayload: unknown): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const url = `${config.chatwoot.url}/webhooks/whatsapp/${encodeURIComponent(config.chatwoot.whatsappPhoneNumber)}`;
    const body = JSON.stringify(rawPayload);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Chatwoot validates X-Hub-Signature-256 when an app secret is configured on the
    // channel; the signature must cover the exact bytes sent, hence the single stringify.
    if (config.chatwoot.metaAppSecret) {
      const signature = crypto.createHmac('sha256', config.chatwoot.metaAppSecret).update(body).digest('hex');
      headers['X-Hub-Signature-256'] = `sha256=${signature}`;
    }

    try {
      await axios.post(url, body, { headers, timeout: FORWARD_TIMEOUT_MS });
      return true;
    } catch (err) {
      log.error({ err, url }, 'Failed to forward WhatsApp payload to Chatwoot');
      return false;
    }
  }
}
