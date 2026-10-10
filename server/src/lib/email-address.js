// RFC 5321 caps an address at 254 characters. Checking that first also keeps the
// pattern's input small. The pattern has no ambiguity (each part excludes the
// character that ends it, including "." in the domain labels), so it can't backtrack.
export const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const isEmailAddress = (value) => value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value);
