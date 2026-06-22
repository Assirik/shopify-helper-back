const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const MAX_EMAIL_LENGTH = 254;

export const USER_NAME_PATTERN = /^[a-zA-Z0-9._-]{3,50}$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidPassword = (value: unknown): value is string => {
  return (
    typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
    Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES
  );
};

export const isValidUserName = (value: unknown): value is string => {
  return typeof value === 'string' && USER_NAME_PATTERN.test(value.trim());
};

export const isValidEmail = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;

  const email = value.trim();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
};
