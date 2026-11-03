// Logs never carry the full phone number: keep only the last 4 characters.
export const maskPhone = (phone: string | undefined): string | undefined =>
  phone ? `***${phone.slice(-4)}` : phone;
