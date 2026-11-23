/**
 * Output shaping for anything that leaves the database: column-level PII
 * redaction by name, value-level redaction of common PII patterns inside text,
 * and size limits so one wide row cannot blow up the model's context window.
 */

export interface RedactionOptions {
  columnPattern: RegExp;
  redactValues: boolean;
  maxCellChars: number;
}

export interface ShapedRows {
  columns: string[];
  rows: unknown[][];
  redactedColumns: string[];
}

export const REDACTED = '[redacted]';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replaces e-mail addresses, US SSNs and Luhn-valid card numbers inside free text. */
export function redactText(text: string): string {
  return text
    .replace(EMAIL, '[redacted:email]')
    .replace(SSN, '[redacted:ssn]')
    .replace(CARD_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits) ? '[redacted:card]' : match;
    });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactDeep(inner)]));
  }
  return value;
}

/** Converts a driver value into a JSON-safe, size-bounded, optionally redacted value. */
export function shapeCell(value: unknown, options: RedactionOptions): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Buffer.isBuffer(value)) return `<bytea ${value.length} bytes>`;
  if (typeof value === 'string') {
    return truncate(options.redactValues ? redactText(value) : value, options.maxCellChars);
  }
  // json/jsonb, arrays, ranges, etc.
  const structured = options.redactValues ? redactDeep(value) : value;
  const serialized = JSON.stringify(structured);
  if (serialized.length > options.maxCellChars) return truncate(serialized, options.maxCellChars);
  return structured;
}

export function isRedactedColumn(column: string, options: RedactionOptions): boolean {
  return options.columnPattern.test(column);
}

/** Applies column redaction and cell shaping to rows returned in array mode. */
export function shapeRows(columns: string[], rows: unknown[][], options: RedactionOptions): ShapedRows {
  const redactMask = columns.map((column) => isRedactedColumn(column, options));
  return {
    columns,
    redactedColumns: columns.filter((_, index) => redactMask[index]),
    rows: rows.map((row) =>
      row.map((cell, index) => {
        if (cell === null || cell === undefined) return null;
        return redactMask[index] ? REDACTED : shapeCell(cell, options);
      }),
    ),
  };
}
