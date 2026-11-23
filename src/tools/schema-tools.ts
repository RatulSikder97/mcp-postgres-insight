import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeTable, listSchemas, resolveTable } from '../catalog.js';
import type { ServerContext } from '../context.js';
import { dataResult } from '../envelope.js';
import { ToolError } from '../errors.js';
import { IdentifierSchema, qualifiedName, quoteIdent } from '../identifiers.js';
import { isRedactedColumn, shapeRows } from '../redaction.js';
import { runTool } from './run-tool.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerSchemaTools(server: McpServer, ctx: ServerContext): void {
  const allowed = ctx.config.PG_ALLOWED_SCHEMAS;

  server.registerTool(
    'list_schemas',
    {
      title: 'List schemas and tables',
      description:
        'Lists the schemas this server exposes, with every table/view, its kind, estimated row count and on-disk size. ' +
        'Start here to orient yourself in an unfamiliar database.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      runTool(ctx, 'list_schemas', async () => {
        const schemas = await ctx.db.readOnly((client) => listSchemas(client, allowed));
        return dataResult('list_schemas', { schemas });
      }),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description:
        'Returns columns (type, nullability, default, comment), primary key, indexes (definition, size, usage), ' +
        'foreign keys in both directions, row estimate, vacuum/analyze stats and automatic insights such as ' +
        'unindexed foreign keys, unused or invalid indexes.',
      inputSchema: {
        schema: IdentifierSchema.describe(`Schema name. One of: ${allowed.join(', ')}`),
        table: IdentifierSchema.describe('Table, view or materialized view name'),
      },
      annotations: READ_ONLY,
    },
    ({ schema, table }) =>
      runTool(ctx, 'describe_table', async () => {
        const description = await ctx.db.readOnly(async (client) => {
          const ref = await resolveTable(client, allowed, schema, table);
          return describeTable(client, ref, allowed, (column) => isRedactedColumn(column, ctx.redaction));
        });
        return dataResult(`describe_table ${schema}.${table}`, description);
      }),
  );

  server.registerTool(
    'sample_rows',
    {
      title: 'Sample rows from a table',
      description:
        `Returns up to ${ctx.config.SAMPLE_MAX_ROWS} rows from a table so you can see real value shapes. ` +
        'Columns whose names match PII patterns (email, phone, ssn, password, token, ...) are replaced with ' +
        '"[redacted]", and e-mails, card numbers and SSNs inside other text are masked.',
      inputSchema: {
        schema: IdentifierSchema.describe(`Schema name. One of: ${allowed.join(', ')}`),
        table: IdentifierSchema.describe('Table or view name'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(ctx.config.SAMPLE_MAX_ROWS)
          .default(Math.min(10, ctx.config.SAMPLE_MAX_ROWS))
          .describe('Number of rows to return'),
        columns: z
          .array(IdentifierSchema)
          .min(1)
          .max(100)
          .optional()
          .describe('Subset of columns to return; defaults to all columns'),
      },
      annotations: READ_ONLY,
    },
    ({ schema, table, limit, columns }) =>
      runTool(ctx, 'sample_rows', async () => {
        const result = await ctx.db.readOnly(async (client) => {
          const ref = await resolveTable(client, allowed, schema, table);
          let selectList = '*';
          if (columns) {
            const { rows } = await client.query<{ name: string }>(
              `SELECT attname AS name FROM pg_catalog.pg_attribute
                WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`,
              [ref.oid],
            );
            const known = new Set(rows.map((row) => row.name));
            const unknown = columns.filter((column) => !known.has(column));
            if (unknown.length > 0) {
              throw new ToolError(`Unknown column(s) on ${schema}.${table}: ${unknown.join(', ')}.`);
            }
            selectList = columns.map(quoteIdent).join(', ');
          }
          return client.query({
            text: `SELECT ${selectList} FROM ${qualifiedName(ref.schema, ref.name)} LIMIT $1`,
            values: [limit],
            rowMode: 'array',
          });
        });

        const shaped = shapeRows(
          result.fields.map((field) => field.name),
          result.rows as unknown[][],
          ctx.redaction,
        );
        return dataResult(`sample_rows ${schema}.${table}`, {
          table: `${schema}.${table}`,
          rowCount: shaped.rows.length,
          redactedColumns: shaped.redactedColumns,
          columns: shaped.columns,
          rows: shaped.rows,
        });
      }),
  );
}
