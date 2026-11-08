export const STATUSES = ['queued', 'sending', 'accepted', 'delivered', 'failed', 'unknown'] as const;
export type MessageStatus = (typeof STATUSES)[number];

export interface EmployeeIdentity { firstName: string; lastName: string; address: string }
export interface Employee extends EmployeeIdentity { phones: string[] }
export interface EmployeeContactInput extends EmployeeIdentity { phone: string }
export interface MessageInput { to: string; body: string; employee?: EmployeeIdentity }
export interface Message extends Omit<MessageInput, 'employee'> {
  id: string;
  status: MessageStatus;
  providerId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  employee: EmployeeIdentity | null;
}
export interface ListQuery { status?: MessageStatus; limit: number; offset: number }

export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

function badInput(message: string): never {
  throw new HttpError(400, 'INVALID_INPUT', message);
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badInput('Expected a JSON object.');
  return value as Record<string, unknown>;
}

function phoneInput(value: unknown): string {
  if (typeof value !== 'string' || !/^\+[1-9]\d{7,14}$/.test(value)) {
    return badInput('Phone must contain + followed by 8-15 digits, starting with a non-zero digit.');
  }
  return value;
}

export function parseEmployeeIdentity(value: unknown): EmployeeIdentity {
  const input = objectInput(value);
  if (Object.keys(input).some(key => !['firstName', 'lastName', 'address'].includes(key))) {
    return badInput('Only firstName, lastName and address are allowed in employee identity.');
  }
  const text = (value: unknown, field: string, max: number) => {
    if (typeof value !== 'string') return badInput(`${field} must be a string.`);
    const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!normalized || [...normalized].length > max) return badInput(`${field} must contain 1-${max} characters.`);
    return normalized;
  };
  return {
    firstName: text(input.firstName, 'firstName', 100),
    lastName: text(input.lastName, 'lastName', 100),
    address: text(input.address, 'address', 300),
  };
}

export function parseEmployeeContact(value: unknown): EmployeeContactInput {
  const input = objectInput(value);
  if (Object.keys(input).some(key => !['firstName', 'lastName', 'address', 'phone'].includes(key))) {
    return badInput('Only firstName, lastName, address and phone are allowed.');
  }
  return {
    ...parseEmployeeIdentity({ firstName: input.firstName, lastName: input.lastName, address: input.address }),
    phone: phoneInput(input.phone),
  };
}

export function parseMessage(value: unknown): MessageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return badInput('Expected a JSON object with to and body.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['to', 'body', 'employee'].includes(key))) {
    return badInput('Only to, body and optional employee are allowed.');
  }
  const to = phoneInput(input.to);
  if (typeof input.body !== 'string' || !input.body.trim() || [...input.body].length > 160) {
    return badInput('body must contain 1-160 Unicode characters and cannot be only whitespace.');
  }
  return input.employee === undefined ? { to, body: input.body }
    : { to, body: input.body, employee: parseEmployeeIdentity(input.employee) };
}

export function parseIdempotencyKey(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    return badInput('Idempotency-Key must contain 1-128 letters, digits, dots, underscores, colons or hyphens.');
  }
  return value;
}

export function parseMessageId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return badInput('Message ID must be a UUID v4.');
  }
  return id.toLowerCase();
}

export function parseListQuery(input: Record<string, unknown>): ListQuery {
  if (Object.keys(input).some(key => !['status', 'limit', 'offset'].includes(key))) {
    return badInput('Only status, limit and offset query parameters are allowed.');
  }
  const integer = (value: unknown, fallback: number, min: number, max: number, name: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return badInput(`${name} must be an integer.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      return badInput(`${name} must be between ${min} and ${max}.`);
    }
    return parsed;
  };
  const result: ListQuery = {
    limit: integer(input.limit, 50, 1, 100, 'limit'),
    offset: integer(input.offset, 0, 0, 1_000_000, 'offset'),
  };
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !STATUSES.includes(input.status as MessageStatus)) {
      return badInput(`status must be one of: ${STATUSES.join(', ')}.`);
    }
    result.status = input.status as MessageStatus;
  }
  return result;
}
