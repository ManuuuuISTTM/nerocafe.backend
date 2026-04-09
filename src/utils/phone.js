export const normalizePhone = (phone, defaultCountryCode = '91') => {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';

  // Normalize common Indian mobile inputs to full international form.
  // Examples:
  // 9505749305 -> 919505749305
  // 09505749305 -> 919505749305
  // +919505749305 -> 919505749305
  let normalized = digits;

  if (normalized.startsWith('0') && normalized.length === 11) {
    normalized = normalized.slice(1);
  }
  if (normalized.startsWith('00') && normalized.length > 2) {
    normalized = normalized.slice(2);
  }
  if (normalized.length === 10) {
    normalized = `${defaultCountryCode}${normalized}`;
  }
  if (normalized.length === 13 && normalized.startsWith(`0${defaultCountryCode}`)) {
    normalized = normalized.slice(1);
  }

  return normalized;
};
