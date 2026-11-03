// Logs never carry a customer's name or e-mail address in clear: these helpers keep just enough
// to tell two log lines apart. For phone numbers see maskPhone.

// "amadou@example.com" -> "a***@example.com". Anything that is not an address becomes "***".
export const maskEmail = (email: string | null | undefined): string | null | undefined => {
  if (!email) return email;
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

// "Amadou Diallo" -> "A***". Empty values pass through.
export const maskName = (name: string | null | undefined): string | null | undefined => {
  if (!name) return name;
  const initial = name.trim().slice(0, 1);
  return initial ? `${initial}***` : '***';
};
