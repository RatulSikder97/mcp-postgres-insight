import { z } from 'zod';

/** Unquoted-or-quoted PostgreSQL identifier as an agent would type it. */
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .refine((name) => !name.includes('"') && !name.includes('\u0000'), 'identifiers must not contain double quotes or NUL bytes');

/** Quotes an identifier for safe interpolation into SQL text. */
export function quoteIdent(name: string): string {
  if (name.includes('\u0000')) throw new Error('identifier contains NUL byte');
  return `"${name.replaceAll('"', '""')}"`;
}

export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}
