export interface PhoneNormalizationResult {
  raw: string;
  isValid: boolean;
  e164?: string;
  errorReason?: string;
}

const SENEGAL_COUNTRY_CODE = '221';
const SENEGAL_MOBILE_PREFIXES = new Set(['70', '75', '76', '77', '78']);
const LOCAL_MOBILE_LENGTH = 9;
const INTERNATIONAL_MOBILE_LENGTH = SENEGAL_COUNTRY_CODE.length + LOCAL_MOBILE_LENGTH;

export class PhoneNormalizationService {
  public static normalizeSenegalPhone(input?: string | null): PhoneNormalizationResult {
    const raw = input ?? '';
    const trimmed = raw.trim();

    if (!trimmed) {
      return {
        raw,
        isValid: false,
        errorReason: 'Phone number is required'
      };
    }

    const compact = trimmed.replace(/[\s().-]/g, '');

    if (!/^\+?\d+$/.test(compact)) {
      return {
        raw,
        isValid: false,
        errorReason: 'Phone number contains unsupported characters'
      };
    }

    const digits = compact.startsWith('+') ? compact.slice(1) : compact;
    const localNumber = PhoneNormalizationService.extractLocalNumber(digits);

    if (!localNumber) {
      return {
        raw,
        isValid: false,
        errorReason: 'Phone number must be Senegalese and contain 9 local digits'
      };
    }

    const prefix = localNumber.slice(0, 2);

    if (!SENEGAL_MOBILE_PREFIXES.has(prefix)) {
      return {
        raw,
        isValid: false,
        errorReason: `Unsupported Senegal mobile prefix: ${prefix}`
      };
    }

    return {
      raw,
      isValid: true,
      e164: `+${SENEGAL_COUNTRY_CODE}${localNumber}`
    };
  }

  private static extractLocalNumber(digits: string): string | null {
    if (digits.length === LOCAL_MOBILE_LENGTH) {
      return digits;
    }

    if (digits.length === INTERNATIONAL_MOBILE_LENGTH && digits.startsWith(SENEGAL_COUNTRY_CODE)) {
      return digits.slice(SENEGAL_COUNTRY_CODE.length);
    }

    return null;
  }
}
