import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildContext, type ServerContext } from '../../src/context.js';
import { Database } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { createServer } from '../../src/server.js';

/** Connects as the least-privilege role created by sql/01-seed.sql. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://insight_reader:insight_reader@localhost:54329/insight';

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    PG_ALLOWED_SCHEMAS: 'app',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export function createTestContext(overrides: Record<string, string> = {}): ServerContext {
  const config = loadConfig(testEnv(overrides));
  const logger = createLogger(config.LOG_LEVEL);
  const db = new Database({
    connectionString: config.DATABASE_URL,
    allowedSchemas: config.PG_ALLOWED_SCHEMAS,
    statementTimeoutMs: config.STATEMENT_TIMEOUT_MS,
    poolMax: config.PG_POOL_MAX,
    logger,
  });
  return buildContext(config, db, logger);
}

export interface Connected {
  ctx: ServerContext;
  client: Client;
  close: () => Promise<void>;
}

/** Full MCP round trip over an in-memory transport pair. */
export async function connect(overrides: Record<string, string> = {}): Promise<Connected> {
  const ctx = createTestContext(overrides);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    ctx,
    client,
    close: async () => {
      await client.close();
      await server.close();
      await ctx.db.close();
    },
  };
}

export function textOf(result: unknown): string {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

/** Extracts and parses the JSON payload from an <untrusted-data> envelope. */
// T only names the expected payload shape for the caller; this is a test-side cast of parsed JSON.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function dataOf<T = Record<string, unknown>>(result: unknown): T {
  expect((result as CallToolResult).isError, textOf(result)).toBeFalsy();
  const match = /<untrusted-data boundary="([0-9a-f]+)">\n([\s\S]*)\n<\/untrusted-data boundary="\1">$/.exec(
    textOf(result),
  );
  if (!match?.[2]) throw new Error(`no untrusted-data envelope in: ${textOf(result)}`);
  return JSON.parse(match[2]) as T;
}

export function errorOf(result: unknown): string {
  expect((result as CallToolResult).isError).toBe(true);
  return textOf(result);
}
