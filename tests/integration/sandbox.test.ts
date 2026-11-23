import { afterAll, describe, expect, it } from 'vitest';
import { connect, errorOf } from './helpers.js';
import { createTestContext } from './helpers.js';

/**
 * These tests bypass the SQL guard on purpose: they prove that the database
 * layer alone still refuses writes and enforces timeouts.
 */
describe('database sandbox', () => {
  const ctx = createTestContext({ STATEMENT_TIMEOUT_MS: '300' });

  afterAll(async () => {
    await ctx.db.close();
  });

  it('runs every unit of work in a read-only transaction', async () => {
    await expect(
      ctx.db.readOnly((client) => client.query("INSERT INTO app.products (sku, name, price_cents) VALUES ('x', 'x', 1)")),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('keeps sessions read-only even after an explicit COMMIT', async () => {
    await expect(
      ctx.db.readOnly(async (client) => {
        await client.query('COMMIT');
        return client.query("INSERT INTO app.products (sku, name, price_cents) VALUES ('y', 'y', 1)");
      }),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('pins search_path to the allowlisted schemas', async () => {
    const { rows } = await ctx.db.readOnly((client) => client.query<{ search_path: string }>('SHOW search_path'));
    expect(rows[0]?.search_path).toBe('"app"');
  });

  it('applies statement_timeout', async () => {
    await expect(
      ctx.db.readOnly((client) => client.query('SELECT count(*) FROM generate_series(1, 500000000)')),
    ).rejects.toMatchObject({ code: '57014' });
  });

  it('returns connections to the pool in a clean state', async () => {
    await ctx.db.readOnly((client) => client.query("SELECT set_config('statement_timeout', '0', true)"));
    const { rows } = await ctx.db.readOnly((client) =>
      client.query<{ timeout: string }>("SELECT current_setting('statement_timeout') AS timeout"),
    );
    expect(rows[0]?.timeout).toBe('300ms');
  });
});

describe('timeouts surface as tool errors', () => {
  it('reports statement_timeout in plain language', async () => {
    const h = await connect({ STATEMENT_TIMEOUT_MS: '200' });
    try {
      const result = await h.client.callTool({
        name: 'run_readonly_query',
        arguments: { sql: 'SELECT count(*) FROM generate_series(1, 500000000)' },
      });
      expect(errorOf(result)).toMatch(/exceeded the 200 ms statement_timeout/);
    } finally {
      await h.close();
    }
  });
});
