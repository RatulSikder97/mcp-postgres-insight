import pg from 'pg';
import { quoteIdent } from './identifiers.js';
import type { Logger } from './logger.js';

export type DbClient = pg.PoolClient;

export interface DatabaseOptions {
  connectionString: string;
  allowedSchemas: string[];
  statementTimeoutMs: number;
  poolMax: number;
  logger: Logger;
}

/**
 * Thin wrapper over a pg Pool that only ever hands out connections inside a
 * READ ONLY transaction which is always rolled back.
 *
 * Defence in depth, from the outside in:
 *   1. every session starts with default_transaction_read_only=on;
 *   2. every unit of work runs in BEGIN READ ONLY ... ROLLBACK;
 *   3. statement_timeout, lock_timeout and idle_in_transaction_session_timeout
 *      are set per transaction (SET LOCAL semantics via set_config(..., true));
 *   4. search_path is pinned to the allowlisted schemas.
 */
export class Database {
  readonly pool: pg.Pool;
  private readonly searchPath: string;

  constructor(private readonly options: DatabaseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolMax,
      application_name: 'mcp-postgres-insight',
      options: '-c default_transaction_read_only=on',
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on('error', (error) => {
      options.logger.error({ err: error }, 'idle postgres client error');
    });
    this.searchPath = options.allowedSchemas.map(quoteIdent).join(', ');
  }

  get allowedSchemas(): readonly string[] {
    return this.options.allowedSchemas;
  }

  get statementTimeoutMs(): number {
    return this.options.statementTimeoutMs;
  }

  async readOnly<T>(work: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let healthy = true;
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const timeout = String(this.options.statementTimeoutMs);
      await client.query(
        `SELECT set_config('statement_timeout', $1, true),
                set_config('lock_timeout', $1, true),
                set_config('idle_in_transaction_session_timeout', $2, true),
                set_config('search_path', $3, true)`,
        [timeout, String(this.options.statementTimeoutMs * 2), this.searchPath],
      );
      return await work(client);
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch (error) {
        healthy = false;
        this.options.logger.warn({ err: error }, 'rollback failed; discarding connection');
      }
      client.release(!healthy);
    }
  }

  async ping(): Promise<void> {
    await this.readOnly((client) => client.query('SELECT 1'));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
