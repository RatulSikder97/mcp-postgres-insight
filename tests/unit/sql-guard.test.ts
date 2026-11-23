import { describe, expect, it } from 'vitest';
import { guardSelect, SqlGuardError, wrapWithLimit } from '../../src/sql-guard.js';

const options = { allowedSchemas: ['app', 'public'], maxLength: 5_000 };

async function rejection(sql: string): Promise<string> {
  try {
    await guardSelect(sql, options);
  } catch (error) {
    expect(error).toBeInstanceOf(SqlGuardError);
    return (error as Error).message;
  }
  throw new Error(`expected guard to reject: ${sql}`);
}

describe('guardSelect', () => {
  it.each([
    'SELECT 1',
    'select id, email from app.customers where id = $1',
    'WITH recent AS (SELECT * FROM app.orders WHERE created_at > now() - interval \'1 day\') SELECT count(*) FROM recent',
    'SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id',
    'VALUES (1, 2), (3, 4)',
    'SELECT 1 UNION ALL SELECT 2',
    'SELECT pg_catalog.lower(\'X\')',
    'SELECT * FROM generate_series(1, 3)',
    'SELECT 1;',
    '  SELECT 1 ;  \n',
  ])('accepts %s', async (sql) => {
    await expect(guardSelect(sql, options)).resolves.toBeDefined();
  });

  it('strips the trailing semicolon and whitespace', async () => {
    const result = await guardSelect('  SELECT 1 ;  ', options);
    expect(result.sql).toBe('SELECT 1');
  });

  it('reports referenced relations', async () => {
    const result = await guardSelect('SELECT * FROM app.orders o JOIN customers c ON c.id = o.customer_id', options);
    expect(result.relations).toEqual([
      { schema: 'app', name: 'orders' },
      { schema: null, name: 'customers' },
    ]);
  });

  it.each([
    ['DELETE FROM app.orders', /Only SELECT statements are allowed; got DELETE/],
    ['UPDATE app.orders SET status = 1', /got UPDATE/],
    ['INSERT INTO app.orders VALUES (1)', /got INSERT/],
    ['DROP TABLE app.orders', /got DROP/],
    ['TRUNCATE app.orders', /got TRUNCATE/],
    ['CREATE TABLE x (id int)', /got CREATE/],
    ['COPY app.orders TO STDOUT', /got COPY/],
    ['SET statement_timeout = 0', /got VARIABLESET/],
    ['BEGIN', /got TRANSACTION/],
    ['EXPLAIN ANALYZE DELETE FROM app.orders', /got EXPLAIN/],
    ['SELECT 1; DELETE FROM app.orders', /Exactly one statement/],
    ['SELECT 1; SELECT 2', /Exactly one statement/],
  ])('rejects %s', async (sql, pattern) => {
    expect(await rejection(sql)).toMatch(pattern);
  });

  it('rejects data-modifying CTEs', async () => {
    expect(await rejection('WITH d AS (DELETE FROM app.orders RETURNING *) SELECT * FROM d')).toMatch(/DELETE is not allowed/);
    expect(await rejection('WITH u AS (UPDATE app.orders SET status = \'x\' RETURNING id) SELECT 1')).toMatch(/UPDATE/);
  });

  it('rejects SELECT INTO and row locks', async () => {
    expect(await rejection('SELECT * INTO new_table FROM app.orders')).toMatch(/SELECT \.\.\. INTO/);
    expect(await rejection('SELECT * FROM app.orders FOR UPDATE')).toMatch(/row locking/);
    expect(await rejection('SELECT * FROM app.orders FOR SHARE SKIP LOCKED')).toMatch(/row locking/);
  });

  it.each([
    "SELECT set_config('statement_timeout', '0', false)",
    'SELECT pg_sleep(10)',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT query_to_xml('DELETE FROM app.orders', true, true, '')",
    'SELECT pg_terminate_backend(123)',
    'SELECT lo_import(\'/etc/passwd\')',
    "SELECT * FROM dblink('host=evil', 'select 1') AS t(x int)",
    'SELECT pg_advisory_lock(1)',
    "SELECT nextval('app.orders_id_seq')",
    'SELECT * FROM app.orders WHERE id = (SELECT pg_sleep(1))::text::int',
  ])('rejects dangerous function call: %s', async (sql) => {
    expect(await rejection(sql)).toMatch(/is not allowed/);
  });

  it('enforces the schema allowlist on relations and functions', async () => {
    expect(await rejection('SELECT * FROM internal.api_keys')).toMatch(/Schema "internal" cannot be queried: it is not in the allowlist/);
    expect(await rejection('SELECT * FROM app.orders WHERE id IN (SELECT 1 FROM internal.api_keys)')).toMatch(/internal/);
    expect(await rejection('SELECT internal.leak()')).toMatch(/Function schema "internal"/);
  });

  it('blocks system catalogs', async () => {
    expect(await rejection('SELECT * FROM pg_catalog.pg_authid')).toMatch(/system catalogs are not exposed/);
    expect(await rejection('SELECT * FROM information_schema.tables')).toMatch(/system catalogs/);
    expect(await rejection('SELECT usename FROM pg_user')).toMatch(/looks like a system catalog/);
  });

  it('reports parse errors with the parser message', async () => {
    expect(await rejection('SELEC 1')).toMatch(/could not be parsed: syntax error at or near "SELEC"/);
  });

  it('enforces maximum length', async () => {
    expect(await rejection(`SELECT ${'1 + '.repeat(2_000)}1`)).toMatch(/limit is 5000/);
  });

  it('rejects empty input', async () => {
    expect(await rejection('   ')).toMatch(/No SQL statement/);
  });
});

describe('wrapWithLimit', () => {
  it('wraps the statement in a capped subquery', async () => {
    const statement = await guardSelect('SELECT * FROM app.orders;', options);
    expect(await wrapWithLimit(statement, 11, options)).toBe(
      'SELECT * FROM (\nSELECT * FROM app.orders\n) AS mcp_insight_q LIMIT 11',
    );
  });

  it('is not broken by a trailing line comment', async () => {
    const statement = await guardSelect('SELECT 1 -- trailing comment', options);
    const wrapped = await wrapWithLimit(statement, 5, options);
    await expect(guardSelect(wrapped, { ...options, maxLength: 10_000 })).resolves.toBeDefined();
    expect(wrapped.endsWith('LIMIT 5')).toBe(true);
  });

  it('rejects invalid limits', async () => {
    const statement = await guardSelect('SELECT 1', options);
    await expect(wrapWithLimit(statement, 0, options)).rejects.toThrow(/positive integer/);
  });
});
