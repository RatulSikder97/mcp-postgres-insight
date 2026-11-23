import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const DEFAULT_REDACT_COLUMNS =
  '(^|_)(e_?mail|phone|mobile|ssn|sin|password|passwd|pwd|secret|token|api_?key|access_?key|private_?key|' +
  'credit_?card|card_?number|cc_?number|cvv|iban|account_?number|dob|date_of_birth|birth_?date|tax_?id|' +
  'national_?id|passport)($|_)';

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const identifier = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

const regex = z.string().transform((source, ctx) => {
  try {
    return new RegExp(source, 'i');
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: `invalid regular expression: ${(error as Error).message}` });
    return z.NEVER;
  }
});

export const ConfigSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// connection string'),
    PG_ALLOWED_SCHEMAS: csv
      .default(['public'])
      .pipe(
        z
          .array(z.string().regex(identifier, 'schema names must be plain identifiers'))
          .min(1, 'at least one schema must be allowed'),
      )
      .refine(
        (schemas) => !schemas.some((schema) => schema === 'pg_catalog' || schema === 'information_schema'),
        'system schemas cannot be allowlisted',
      ),
    MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
    MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
    MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3333),
    MCP_HTTP_AUTH_TOKEN: z.string().min(32, 'must be at least 32 characters').optional(),
    MCP_HTTP_ALLOWED_HOSTS: csv.optional(),
    STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5_000),
    QUERY_MAX_ROWS: z.coerce.number().int().min(1).max(10_000).default(200),
    SAMPLE_MAX_ROWS: z.coerce.number().int().min(1).max(1_000).default(50),
    MAX_CELL_CHARS: z.coerce.number().int().min(16).max(100_000).default(512),
    MAX_SQL_LENGTH: z.coerce.number().int().min(100).max(200_000).default(20_000),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(50).default(4),
    SEQ_SCAN_ROW_THRESHOLD: z.coerce.number().int().min(0).default(10_000),
    ALLOW_EXPLAIN_ANALYZE: bool.default(true),
    REDACT_COLUMNS: regex.default(new RegExp(DEFAULT_REDACT_COLUMNS, 'i')),
    REDACT_VALUES: bool.default(true),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((config, ctx) => {
    if (
      config.MCP_TRANSPORT === 'http' &&
      !LOOPBACK_HOSTS.has(config.MCP_HTTP_HOST) &&
      config.MCP_HTTP_AUTH_TOKEN === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_HTTP_AUTH_TOKEN'],
        message: 'is required when MCP_HTTP_HOST is not a loopback address',
      });
    }
  });

export type Config = z.output<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses configuration from an environment-like record. Empty strings count as unset. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
