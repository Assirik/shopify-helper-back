// Validation for free-text values injected into WhatsApp template body variables.
// Meta rejects parameters containing newlines, tabs or long runs of whitespace,
// so we enforce the same rules before persisting a configured value.
export const MAX_TEMPLATE_PARAM_LENGTH = 200;

export type TemplateTextResult = { value: string } | { error: string };

export const validateTemplateText = (raw: unknown): TemplateTextResult => {
  if (typeof raw !== 'string') {
    return { error: 'La valeur doit être une chaîne de caractères' };
  }

  const value = raw.trim();

  if (!value) {
    return { error: 'La valeur ne peut pas être vide' };
  }

  if (value.length > MAX_TEMPLATE_PARAM_LENGTH) {
    return { error: `La valeur ne peut pas dépasser ${MAX_TEMPLATE_PARAM_LENGTH} caractères` };
  }

  if (/[\n\r\t]/.test(value)) {
    return { error: 'La valeur ne peut pas contenir de saut de ligne ni de tabulation' };
  }

  // Meta forbids more than 4 consecutive spaces inside a template parameter.
  if (/ {5,}/.test(value)) {
    return { error: 'La valeur ne peut pas contenir plus de 4 espaces consécutifs' };
  }

  return { value };
};
