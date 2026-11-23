import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACT_COLUMNS } from '../../src/config.js';
import { REDACTED, redactText, shapeCell, shapeRows, type RedactionOptions } from '../../src/redaction.js';

const options: RedactionOptions = {
  columnPattern: new RegExp(DEFAULT_REDACT_COLUMNS, 'i'),
  redactValues: true,
  maxCellChars: 40,
};

describe('redactText', () => {
  it('masks e-mail addresses', () => {
    expect(redactText('contact jane.doe+x@example.co.uk now')).toBe('contact [redacted:email] now');
  });

  it('masks US social security numbers', () => {
    expect(redactText('ssn 123-45-6789.')).toBe('ssn [redacted:ssn].');
  });

  it('masks Luhn-valid card numbers but not arbitrary digit runs', () => {
    expect(redactText('card 4111 1111 1111 1111 ok')).toBe('card [redacted:card] ok');
    expect(redactText('card 4111-1111-1111-1111')).toBe('card [redacted:card]');
    expect(redactText('order 1234567890123')).toBe('order 1234567890123');
  });
});

describe('column redaction pattern', () => {
  it.each(['email', 'user_email', 'phone', 'mobile_number', 'password_hash', 'api_key', 'apikey', 'ssn', 'date_of_birth', 'card_number'])(
    'redacts %s',
    (column) => {
      expect(options.columnPattern.test(column)).toBe(true);
    },
  );

  it.each(['id', 'status', 'emailed_at_count_x', 'phoneme', 'tokenizer', 'created_at', 'country'])('keeps %s', (column) => {
    expect(options.columnPattern.test(column)).toBe(false);
  });
});

describe('shapeCell', () => {
  it('normalises driver values', () => {
    expect(shapeCell(new Date('2025-01-02T03:04:05Z'), options)).toBe('2025-01-02T03:04:05.000Z');
    expect(shapeCell(Buffer.from([1, 2, 3]), options)).toBe('<bytea 3 bytes>');
    expect(shapeCell(10n, options)).toBe('10');
    expect(shapeCell(null, options)).toBeNull();
    expect(shapeCell(true, options)).toBe(true);
  });

  it('truncates long text with a marker', () => {
    const shaped = shapeCell('x'.repeat(100), options) as string;
    expect(shaped.startsWith('x'.repeat(40))).toBe(true);
    expect(shaped).toContain('[+60 chars]');
  });

  it('redacts inside JSON values', () => {
    expect(shapeCell({ contact: { email: 'a@b.io' } }, options)).toEqual({ contact: { email: '[redacted:email]' } });
  });

  it('leaves values alone when value redaction is off', () => {
    expect(shapeCell('a@b.io', { ...options, redactValues: false })).toBe('a@b.io');
  });
});

describe('shapeRows', () => {
  it('redacts by column name and reports which columns were redacted', () => {
    const shaped = shapeRows(
      ['id', 'email', 'notes', 'phone'],
      [
        [1, 'a@b.io', 'reach me at c@d.io', null],
        [2, 'e@f.io', 'fine', '+1-555-0100'],
      ],
      options,
    );
    expect(shaped.redactedColumns).toEqual(['email', 'phone']);
    expect(shaped.rows).toEqual([
      [1, REDACTED, 'reach me at [redacted:email]', null],
      [2, REDACTED, 'fine', REDACTED],
    ]);
  });
});
