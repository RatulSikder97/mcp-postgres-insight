import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import type { DbClient } from '../db.js';
import { dataResult } from '../envelope.js';
import { quoteIdent } from '../identifiers.js';
import { redactText } from '../redaction.js';

import { runTool } from './run-tool.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const ORDER_COLUMNS = {
  total_time: 'total_exec_time',
  mean_time: 'mean_exec_time',
  calls: 'calls',
} as const;

type OrderBy = keyof typeof ORDER_COLUMNS;

const QUERY_TEXT_LIMIT = 2_000;

function cleanQueryText(text: string | null, redactValues: boolean): string | null {
  if (text === null) return null;
  const trimmed = text.length > QUERY_TEXT_LIMIT ? `${text.slice(0, QUERY_TEXT_LIMIT)}…` : text;
  return redactValues ? redactText(trimmed) : trimmed;
}

async function fromPgStatStatements(
  client: DbClient,
  limit: number,
  orderBy: OrderBy,
  redactValues: boolean,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  const ext = await client.query<{ schema: string }>(
    `SELECT n.nspname AS schema
       FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'`,
  );
  const schema = ext.rows[0]?.schema;
  if (schema === undefined) return { ok: false, reason: 'the pg_stat_statements extension is not installed' };

  await client.query('SAVEPOINT pgss_probe');
  try {
    const { rows } = await client.query<{
      queryid: string | null;
      calls: string;
      total_ms: string;
      mean_ms: string;
      max_ms: string;
      rows: string;
      cache_hit_ratio: string | null;
      query: string | null;
    }>(
      `SELECT queryid::text AS queryid,
              calls,
              round(total_exec_time::numeric, 2) AS total_ms,
              round(mean_exec_time::numeric, 2) AS mean_ms,
              round(max_exec_time::numeric, 2) AS max_ms,
              rows,
              round(shared_blks_hit::numeric / NULLIF(shared_blks_hit + shared_blks_read, 0), 4) AS cache_hit_ratio,
              query
         FROM ${quoteIdent(schema)}.pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
          AND query NOT ILIKE 'EXPLAIN%'
          AND query NOT LIKE '%pg_catalog.%'
        ORDER BY ${ORDER_COLUMNS[orderBy]} DESC
        LIMIT $1`,
      [limit],
    );
    await client.query('RELEASE SAVEPOINT pgss_probe');
    return {
      ok: true,
      data: {
        source: 'pg_stat_statements',
        orderedBy: orderBy,
        queries: rows.map((row) => ({
          queryId: row.queryid,
          calls: Number(row.calls),
          totalMs: Number(row.total_ms),
          meanMs: Number(row.mean_ms),
          maxMs: Number(row.max_ms),
          rows: Number(row.rows),
          cacheHitRatio: row.cache_hit_ratio === null ? null : Number(row.cache_hit_ratio),
          query: cleanQueryText(row.query, redactValues),
        })),
        note: 'Query text is normalised by pg_stat_statements; pass a query to explain_query to get index suggestions.',
      },
    };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT pgss_probe');
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `pg_stat_statements is installed but not readable (${message})` };
  }
}

async function fallback(
  client: DbClient,
  limit: number,
  allowed: readonly string[],
  reason: string,
  redactValues: boolean,
): Promise<unknown> {
  const active = await client.query<{
    pid: number;
    state: string | null;
    duration_ms: string | null;
    wait_event: string | null;
    query: string | null;
  }>(
    `SELECT pid,
            state,
            round(extract(epoch FROM (clock_timestamp() - query_start)) * 1000) AS duration_ms,
            concat_ws(':', wait_event_type, wait_event) AS wait_event,
            query
       FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state IS DISTINCT FROM 'idle'
        AND backend_type = 'client backend'
      ORDER BY query_start NULLS LAST
      LIMIT $1`,
    [limit],
  );

  const hotspots = await client.query<{
    table: string;
    seq_scan: string;
    seq_tup_read: string;
    idx_scan: string | null;
    live_rows: string;
  }>(
    `SELECT schemaname || '.' || relname AS table,
            seq_scan, seq_tup_read, idx_scan, n_live_tup AS live_rows
       FROM pg_catalog.pg_stat_all_tables
      WHERE schemaname = ANY($1::text[]) AND seq_scan > 0
      ORDER BY seq_tup_read DESC
      LIMIT $2`,
    [allowed, limit],
  );

  return {
    source: 'fallback',
    reason,
    activeQueries: active.rows.map((row) => ({
      pid: row.pid,
      state: row.state,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      waitEvent: row.wait_event === '' ? null : row.wait_event,
      query: cleanQueryText(row.query, redactValues),
    })),
    sequentialScanHotspots: hotspots.rows.map((row) => ({
      table: row.table,
      seqScans: Number(row.seq_scan),
      seqRowsRead: Number(row.seq_tup_read),
      indexScans: row.idx_scan === null ? null : Number(row.idx_scan),
      liveRows: Number(row.live_rows),
    })),
    howToEnable:
      "Add pg_stat_statements to shared_preload_libraries, restart PostgreSQL, run CREATE EXTENSION pg_stat_statements; and GRANT pg_read_all_stats to this server's role.",
  };
}

export function registerPerformanceTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'find_slow_queries',
    {
      title: 'Find slow queries',
      description:
        'Lists the most expensive statements from pg_stat_statements (by total time, mean time or call count). ' +
        'If pg_stat_statements is unavailable it falls back to currently running queries from pg_stat_activity ' +
        'plus the tables with the heaviest sequential-scan traffic, and explains how to enable the extension.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).describe('Number of entries to return'),
        order_by: z
          .enum(['total_time', 'mean_time', 'calls'])
          .default('total_time')
          .describe('Ranking for pg_stat_statements results'),
      },
      annotations: READ_ONLY,
    },
    ({ limit, order_by }) =>
      runTool(ctx, 'find_slow_queries', async () => {
        const data = await ctx.db.readOnly(async (client) => {
          const primary = await fromPgStatStatements(client, limit, order_by, ctx.config.REDACT_VALUES);
          if (primary.ok) return primary.data;
          return fallback(client, limit, ctx.config.PG_ALLOWED_SCHEMAS, primary.reason, ctx.config.REDACT_VALUES);
        });
        return dataResult('find_slow_queries', data);
      }),
  );
}
