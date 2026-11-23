import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

function issues(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected config to be rejected');
}

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(base);
    expect(config.PG_ALLOWED_SCHEMAS).toEqual(['public']);
    expect(config.MCP_TRANSPORT).toBe('stdio');
    expect(config.MCP_HTTP_HOST).toBe('127.0.0.1');
    expect(config.STATEMENT_TIMEOUT_MS).toBe(5_000);
    expect(config.QUERY_MAX_ROWS).toBe(200);
    expect(config.REDACT_VALUES).toBe(true);
    expect(config.REDACT_COLUMNS.test('user_email')).toBe(true);
  });

  it('parses lists, numbers and booleans from strings', () => {
    const config = loadConfig({
      ...base,
      PG_ALLOWED_SCHEMAS: ' app , reporting ,',
      QUERY_MAX_ROWS: '25',
      REDACT_VALUES: 'false',
      REDACT_COLUMNS: '^secret_',
    });
    expect(config.PG_ALLOWED_SCHEMAS).toEqual(['app', 'reporting']);
    expect(config.QUERY_MAX_ROWS).toBe(25);
    expect(config.REDACT_VALUES).toBe(false);
    expect(config.REDACT_COLUMNS.test('SECRET_value')).toBe(true);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...base, PG_ALLOWED_SCHEMAS: '', MCP_HTTP_AUTH_TOKEN: '' }).PG_ALLOWED_SCHEMAS).toEqual(['public']);
  });

  it('rejects missing or malformed connection strings', () => {
    expect(issues({})).toEqual([expect.stringMatching(/^DATABASE_URL:/)]);
    expect(issues({ DATABASE_URL: 'mysql://x' })[0]).toMatch(/postgres:\/\//);
  });

  it('refuses to allowlist system schemas or invalid identifiers', () => {
    expect(issues({ ...base, PG_ALLOWED_SCHEMAS: 'app,pg_catalog' })[0]).toMatch(/system schemas/);
    expect(issues({ ...base, PG_ALLOWED_SCHEMAS: 'app;drop' })[0]).toMatch(/plain identifiers/);
  });

  it('bounds numeric limits', () => {
    expect(issues({ ...base, STATEMENT_TIMEOUT_MS: '10' })[0]).toMatch(/^STATEMENT_TIMEOUT_MS/);
    expect(issues({ ...base, QUERY_MAX_ROWS: 'lots' })[0]).toMatch(/^QUERY_MAX_ROWS/);
  });

  it('rejects invalid redaction regexes', () => {
    expect(issues({ ...base, REDACT_COLUMNS: '(' })[0]).toMatch(/invalid regular expression/);
  });

  it('requires an auth token when HTTP listens beyond loopback', () => {
    expect(issues({ ...base, MCP_TRANSPORT: 'http', MCP_HTTP_HOST: '0.0.0.0' })[0]).toMatch(
      /MCP_HTTP_AUTH_TOKEN: is required/,
    );
    const config = loadConfig({
      ...base,
      MCP_TRANSPORT: 'http',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_HTTP_AUTH_TOKEN: 'x'.repeat(32),
    });
    expect(config.MCP_HTTP_AUTH_TOKEN).toHaveLength(32);
    expect(issues({ ...base, MCP_HTTP_AUTH_TOKEN: 'short' })[0]).toMatch(/at least 32/);
  });
});
