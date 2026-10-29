import { AppError } from './errors.ts';

// Bounded observed display metadata, never an identity or authorization input.
// Allow short collectible handles; preserve case and never repair invalid values.
export function senderUsername(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(value) ? value : null;
}

// Rejects non-objects, unknown keys and missing required keys.
export function objectArgs(
  value: unknown,
  permitted: readonly string[],
  required: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !permitted.includes(key)) ||
    required.some((key) => (value as Record<string, unknown>)[key] === undefined)
  )
    throw new AppError('Invalid arguments.');
  return value as Record<string, unknown>;
}

// Positive safe-integer Telegram user or private chat ID, as a string.
export function numericId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
  );
}

// Negative safe-integer Telegram group ID, as a string.
export function groupId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^-[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
  );
}
