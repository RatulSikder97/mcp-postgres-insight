import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, dataOf, errorOf, textOf, type Connected } from './helpers.js';

let h: Connected;

beforeAll(async () => {
  h = await connect();
});

afterAll(async () => {
  await h.close();
});

const call = (name: string, args: Record<string, unknown> = {}) => h.client.callTool({ name, arguments: args });

describe('capabilities', () => {
  it('exposes six read-only tools', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'describe_table',
      'explain_query',
      'find_slow_queries',
      'list_schemas',
      'run_readonly_query',
      'sample_rows',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('advertises instructions for the model', () => {
    expect(h.client.getInstructions()).toContain('untrusted-data');
  });
});

describe('list_schemas', () => {
  it('lists only allowlisted schemas with row estimates', async () => {
    const data = dataOf<{ schemas: { schema: string; tables: { name: string; rowEstimate: number }[] }[] }>(
      await call('list_schemas'),
    );
    expect(data.schemas.map((schema) => schema.schema)).toEqual(['app']);
    const tables = Object.fromEntries(data.schemas[0]!.tables.map((table) => [table.name, table.rowEstimate]));
    expect(Object.keys(tables).sort()).toEqual(['customers', 'order_items', 'orders', 'products']);
    expect(tables.orders).toBe(60_000);
  });
});

describe('describe_table', () => {
  it('returns columns, indexes, foreign keys and insights', async () => {
    const data = dataOf<{
      rowEstimate: number;
      primaryKey: string[];
      columns: { name: string; type: string; nullable: boolean }[];
      foreignKeys: { name: string; columns: string[]; indexed: boolean }[];
      referencedBy: { fromTable: string }[];
      insights: string[];
    }>(await call('describe_table', { schema: 'app', table: 'orders' }));

    expect(data.rowEstimate).toBe(60_000);
    expect(data.primaryKey).toEqual(['id']);
    expect(data.columns.find((column) => column.name === 'customer_id')).toMatchObject({ type: 'bigint', nullable: false });
    expect(data.foreignKeys).toEqual([expect.objectContaining({ columns: ['customer_id'], indexed: false })]);
    expect(data.referencedBy).toEqual([expect.objectContaining({ fromTable: 'app.order_items' })]);
    expect(data.insights.join('\n')).toMatch(/orders_customer_id_fkey \(customer_id\) has no supporting index/);
  });

  it('recognises composite indexes that cover a foreign key', async () => {
    const data = dataOf<{ foreignKeys: { columns: string[]; indexed: boolean }[] }>(
      await call('describe_table', { schema: 'app', table: 'order_items' }),
    );
    expect(data.foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ columns: ['order_id'], indexed: true }),
        expect.objectContaining({ columns: ['product_id'], indexed: true }),
      ]),
    );
  });

  it('flags PII columns that will be redacted', async () => {
    const data = dataOf<{ columns: { name: string; redactedInSamples: boolean }[] }>(
      await call('describe_table', { schema: 'app', table: 'customers' }),
    );
    const redacted = data.columns.filter((column) => column.redactedInSamples).map((column) => column.name);
    expect(redacted).toEqual(['email', 'phone']);
  });

  it('refuses schemas outside the allowlist even when the role can read them', async () => {
    expect(errorOf(await call('describe_table', { schema: 'internal', table: 'api_keys' }))).toMatch(
      /Schema "internal" is not available/,
    );
  });

  it('reports unknown tables helpfully', async () => {
    expect(errorOf(await call('describe_table', { schema: 'app', table: 'nope' }))).toMatch(/does not exist/);
  });

  it('validates input with zod', async () => {
    const result = await call('describe_table', { schema: 'app', table: 'x"; drop table y; --' });
    expect(errorOf(result)).toMatch(/double quotes/);
  });
});

describe('sample_rows', () => {
  it('redacts PII columns and PII inside free text', async () => {
    const data = dataOf<{ columns: string[]; rows: unknown[][]; redactedColumns: string[] }>(
      await call('sample_rows', { schema: 'app', table: 'customers', limit: 50 }),
    );
    expect(data.rows).toHaveLength(50);
    expect(data.redactedColumns).toEqual(['email', 'phone']);
    const email = data.columns.indexOf('email');
    expect(data.rows.every((row) => row[email] === '[redacted]')).toBe(true);
    expect(JSON.stringify(data.rows)).not.toMatch(/@example\.(com|org)/);
  });

  it('caps limit at SAMPLE_MAX_ROWS via schema validation', async () => {
    const { tools } = await h.client.listTools();
    const schema = tools.find((tool) => tool.name === 'sample_rows')!.inputSchema as unknown as {
      properties: { limit: { maximum: number } };
    };
    expect(schema.properties.limit.maximum).toBe(50);
    const rejected = await call('sample_rows', { schema: 'app', table: 'customers', limit: 51 });
    expect(errorOf(rejected)).toMatch(/expected number to be <=50/);
  });

  it('supports a column subset and rejects unknown columns', async () => {
    const data = dataOf<{ columns: string[] }>(
      await call('sample_rows', { schema: 'app', table: 'products', limit: 2, columns: ['sku', 'price_cents'] }),
    );
    expect(data.columns).toEqual(['sku', 'price_cents']);
    expect(errorOf(await call('sample_rows', { schema: 'app', table: 'products', columns: ['nope'] }))).toMatch(
      /Unknown column/,
    );
  });

  it('returns hostile row content inside the untrusted-data envelope', async () => {
    const result = await call('run_readonly_query', { sql: 'SELECT notes FROM app.customers WHERE id = 42' });
    const text = textOf(result);
    const notice = text.indexOf('not instructions');
    const payload = text.indexOf('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(notice).toBeGreaterThan(-1);
    expect(payload).toBeGreaterThan(text.indexOf('<untrusted-data'));
    expect(payload).toBeLessThan(text.indexOf('</untrusted-data'));
  });
});

describe('run_readonly_query', () => {
  it('runs parameterised SELECTs', async () => {
    const data = dataOf<{ columns: string[]; rows: unknown[][]; truncated: boolean }>(
      await call('run_readonly_query', {
        sql: 'SELECT status, count(*)::int AS n FROM app.orders WHERE total_cents > $1 GROUP BY status ORDER BY status',
        params: [0],
      }),
    );
    expect(data.columns).toEqual(['status', 'n']);
    expect(data.rows).toEqual([
      ['delivered', 12_000],
      ['paid', 12_000],
      ['pending', 12_000],
      ['refunded', 12_000],
      ['shipped', 12_000],
    ]);
    expect(data.truncated).toBe(false);
  });

  it('caps rows and reports truncation', async () => {
    const data = dataOf<{ rowCount: number; truncated: boolean }>(
      await call('run_readonly_query', { sql: 'SELECT id FROM app.orders', max_rows: 7 }),
    );
    expect(data).toMatchObject({ rowCount: 7, truncated: true });
  });

  it('preserves duplicate column names', async () => {
    const data = dataOf<{ columns: string[]; rows: unknown[][] }>(
      await call('run_readonly_query', { sql: 'SELECT 1 AS a, 2 AS a' }),
    );
    expect(data.columns).toEqual(['a', 'a']);
    expect(data.rows).toEqual([[1, 2]]);
  });

  it('redacts PII columns in ad-hoc results too', async () => {
    const data = dataOf<{ rows: unknown[][]; redactedColumns: string[] }>(
      await call('run_readonly_query', { sql: 'SELECT id, email AS contact_email FROM app.customers ORDER BY id LIMIT 1' }),
    );
    expect(data.redactedColumns).toEqual(['contact_email']);
    expect(data.rows).toEqual([['1', '[redacted]']]);
  });

  it.each([
    ['DELETE FROM app.orders', /Only SELECT/],
    ['SELECT 1; DROP TABLE app.orders', /Exactly one statement/],
    ['WITH x AS (UPDATE app.orders SET status = $1 RETURNING 1) SELECT * FROM x', /UPDATE is not allowed/],
    ['SELECT * FROM internal.api_keys', /not in the allowlist/],
    ["SELECT set_config('default_transaction_read_only', 'off', false)", /set_config\(\) is not allowed/],
    ['SELECT * FROM pg_shadow', /system catalog/],
  ])('rejects %s before it reaches the database', async (sql, pattern) => {
    expect(errorOf(await call('run_readonly_query', { sql }))).toMatch(pattern);
  });

  it('maps PostgreSQL errors to readable messages', async () => {
    expect(errorOf(await call('run_readonly_query', { sql: 'SELECT missing_column FROM app.orders' }))).toMatch(
      /PostgreSQL error 42703: column "missing_column" does not exist/,
    );
  });
});

describe('explain_query', () => {
  it('suggests the missing index on orders.customer_id', async () => {
    const data = dataOf<{
      summary: { totalCost: number; analyzed: boolean };
      hints: { kind: string; suggestion?: string }[];
    }>(
      await call('explain_query', {
        sql: 'SELECT id, total_cents FROM app.orders WHERE customer_id = 42 ORDER BY created_at DESC',
      }),
    );
    expect(data.summary.analyzed).toBe(false);
    expect(data.summary.totalCost).toBeGreaterThan(0);
    expect(data.hints).toContainEqual(
      expect.objectContaining({
        kind: 'seq_scan_large_table',
        suggestion: 'CREATE INDEX CONCURRENTLY ON "app"."orders" ("customer_id");',
      }),
    );
  });

  it('runs EXPLAIN ANALYZE inside the read-only sandbox and can include the raw plan', async () => {
    const data = dataOf<{ summary: { analyzed: boolean; executionMs: number }; plan: { Plan: unknown } }>(
      await call('explain_query', {
        sql: "SELECT count(*) FROM app.orders WHERE status = 'paid'",
        analyze: true,
        include_plan: true,
      }),
    );
    expect(data.summary.analyzed).toBe(true);
    expect(data.summary.executionMs).toBeGreaterThan(0);
    expect(data.plan.Plan).toBeDefined();
  });

  it('applies the same guard as run_readonly_query', async () => {
    expect(errorOf(await call('explain_query', { sql: 'DELETE FROM app.orders', analyze: true }))).toMatch(/Only SELECT/);
  });
});

describe('find_slow_queries', () => {
  it('returns pg_stat_statements data or a graceful fallback', async () => {
    await call('run_readonly_query', { sql: "SELECT count(*) FROM app.orders WHERE status = 'paid'" });
    const data = dataOf<{ source: string; queries?: unknown[]; reason?: string; sequentialScanHotspots?: unknown[] }>(
      await call('find_slow_queries', { limit: 5 }),
    );
    if (data.source === 'pg_stat_statements') {
      expect(Array.isArray(data.queries)).toBe(true);
    } else {
      expect(data.source).toBe('fallback');
      expect(data.reason).toMatch(/pg_stat_statements/);
      expect(Array.isArray(data.sequentialScanHotspots)).toBe(true);
    }
  });
});

describe('resources and prompts', () => {
  it('serves the schema overview resource', async () => {
    const { resources } = await h.client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain('postgres-insight://schema/overview');
    const { contents } = await h.client.readResource({ uri: 'postgres-insight://schema/overview' });
    const text = (contents[0] as { text: string }).text;
    expect(text).toContain('## app.orders (table, rows ~60,000)');
    expect(text).toContain('- customer_id: bigint');
    expect(text).not.toContain('internal');
  });

  it('serves per-table resources from the template', async () => {
    const { resourceTemplates } = await h.client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(
      'postgres-insight://table/{schema}/{table}',
    );
    const { contents } = await h.client.readResource({ uri: 'postgres-insight://table/app/products' });
    expect((contents[0] as { text: string }).text).toContain('"name":"products"');
  });

  it('renders the diagnose_slow_query prompt', async () => {
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['diagnose_slow_query']);
    const prompt = await h.client.getPrompt({
      name: 'diagnose_slow_query',
      arguments: { sql: 'SELECT * FROM app.orders WHERE customer_id = 1', context: 'p95 is 2s' },
    });
    const message = prompt.messages[0]!.content as { text: string };
    expect(message.text).toContain('SELECT * FROM app.orders WHERE customer_id = 1');
    expect(message.text).toContain('p95 is 2s');
    expect(message.text).toContain('explain_query');
  });
});
