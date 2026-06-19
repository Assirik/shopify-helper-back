export interface TemplateVariable {
  name: string;
  value: string;
}

export interface OrderConfirmationInput {
  orderId: string;
  to: string;
  templateName: string;
  templateLanguage: string;
  buttonPayload?: string;
  // Named template variables, in template order. Each maps to a Meta `{{name}}` placeholder.
  variables: TemplateVariable[];
}

export interface ProviderResult {
  providerMessageId?: string;
  response: unknown;
}

export interface SmsInput {
  orderId: string;
  to: string;
  text: string;
}

export interface MessagingProvider {
  sendOrderConfirmation(input: OrderConfirmationInput): Promise<ProviderResult>;
}

export interface SmsProvider {
  sendSms(input: SmsInput): Promise<ProviderResult>;
}

export class ProviderError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}
