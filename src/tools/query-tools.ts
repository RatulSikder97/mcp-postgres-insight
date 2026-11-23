import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { relationStats } from '../catalog.js';
import type { ServerContext } from '../context.js';
import { dataResult } from '../envelope.js';
import { ToolError } from '../errors.js';
import { analyzePlan, collectRelations, type ExplainOutput } from '../plan-analyzer.js';
import { shapeRows } from '../redaction.js';
import { guardSelect, wrapWithLimit } from '../sql-guard.js';
import { runTool } from './run-tool.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const ParamSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export function registerQueryTools(server: McpServer, ctx: ServerContext): void {
  const { config } = ctx;

  server.registerTool(
    'run_readonly_query',
    {
      title: 'Run a read-only SQL query',
      description:
        'Runs ONE SELECT statement and returns columns and rows. The SQL is parsed with the real PostgreSQL ' +
        'parser and rejected unless it is a plain read touching only allowlisted schemas; it then runs in a ' +
        `READ ONLY transaction with a ${config.STATEMENT_TIMEOUT_MS} ms statement_timeout and a row cap of ` +
        `${config.QUERY_MAX_ROWS}. Use $1, $2, ... placeholders with "params" instead of inlining literals.`,
      inputSchema: {
        sql: z.string().min(1).max(config.MAX_SQL_LENGTH).describe('A single SELECT (CTEs allowed)'),
        params: z.array(ParamSchema).max(100).default([]).describe('Values for $1, $2, ... placeholders'),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(config.QUERY_MAX_ROWS)
          .default(Math.min(50, config.QUERY_MAX_ROWS))
          .describe('Maximum rows to return'),
      },
      annotations: READ_ONLY,
    },
    ({ sql, params, max_rows }) =>
      runTool(ctx, 'run_readonly_query', async () => {
        const statement = await guardSelect(sql, ctx.guard);
        const wrapped = await wrapWithLimit(statement, max_rows + 1, ctx.guard);
        const started = performance.now();
        const result = await ctx.db.readOnly((client) =>
          client.query({ text: wrapped, values: params, rowMode: 'array' }),
        );
        const durationMs = Math.round(performance.now() - started);
        const rows = result.rows as unknown[][];
        const truncated = rows.length > max_rows;
        const shaped = shapeRows(
          result.fields.map((field) => field.name),
          truncated ? rows.slice(0, max_rows) : rows,
          ctx.redaction,
        );
        return dataResult('run_readonly_query', {
          rowCount: shaped.rows.length,
          truncated,
          durationMs,
          redactedColumns: shaped.redactedColumns,
          columns: shaped.columns,
          rows: shaped.rows,
        });
      }),
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain a query and suggest fixes',
      description:
        'Runs EXPLAIN (FORMAT JSON, VERBOSE) on a SELECT and summarises the plan: total cost, hottest nodes, and ' +
        'actionable hints such as sequential scans on large tables with candidate CREATE INDEX statements, sorts ' +
        'or hashes spilling to disk, and row misestimates. analyze=true also executes the query (still read-only ' +
        'and time-limited) to compare estimates with reality.',
      inputSchema: {
        sql: z.string().min(1).max(config.MAX_SQL_LENGTH).describe('A single SELECT with literal values inlined'),
        analyze: z
          .boolean()
          .default(false)
          .describe('Execute the query to collect actual timings and row counts (EXPLAIN ANALYZE, BUFFERS)'),
        include_plan: z.boolean().default(false).describe('Also return the raw JSON plan'),
      },
      annotations: READ_ONLY,
    },
    ({ sql, analyze, include_plan }) =>
      runTool(ctx, 'explain_query', async () => {
        if (analyze && !config.ALLOW_EXPLAIN_ANALYZE) {
          throw new ToolError('EXPLAIN ANALYZE is disabled on this server (ALLOW_EXPLAIN_ANALYZE=false).');
        }
        const statement = await guardSelect(sql, ctx.guard);
        const options = analyze ? 'FORMAT JSON, VERBOSE, ANALYZE, BUFFERS' : 'FORMAT JSON, VERBOSE';

        const { explain, stats } = await ctx.db.readOnly(async (client) => {
          const { rows } = await client.query<{ 'QUERY PLAN': ExplainOutput[] }>(
            `EXPLAIN (${options}) ${statement.sql}`,
          );
          const output = rows[0]?.['QUERY PLAN'][0];
          if (!output) throw new ToolError('PostgreSQL returned an empty plan.');
          const relations = collectRelations(output.Plan).filter((relation) =>
            config.PG_ALLOWED_SCHEMAS.includes(relation.schema),
          );
          return { explain: output, stats: await relationStats(client, relations) };
        });

        const analysis = analyzePlan(explain, stats, { seqScanRowThreshold: config.SEQ_SCAN_ROW_THRESHOLD });
        return dataResult('explain_query', {
          ...analysis,
          relations: Object.fromEntries(
            [...stats.entries()].map(([name, value]) => [
              name,
              { rowEstimate: value.rowEstimate, indexes: value.indexes },
            ]),
          ),
          ...(include_plan ? { plan: explain } : {}),
        });
      }),
  );
}
