import { parse } from 'libpg-query';

/**
 * Static validation of agent-supplied SQL using the real PostgreSQL parser
 * (libpg_query compiled to WASM). This is the first of several layers: the
 * statement still runs inside a READ ONLY transaction with a timeout, so the
 * guard's job is to reject anything that is not a plain read early, with an
 * explanation the model can act on, and to enforce the schema allowlist,
 * which database privileges alone may not.
 */

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlGuardError';
  }
}

export interface GuardOptions {
  allowedSchemas: readonly string[];
  maxLength: number;
}

export interface GuardedStatement {
  /** The single statement, without trailing semicolon or surrounding whitespace. */
  sql: string;
  /** Relations referenced by the statement, as written (schema may be null). */
  relations: { schema: string | null; name: string }[];
}

/** Node types that write, lock, or otherwise change state. */
const FORBIDDEN_NODES: Record<string, string> = {
  InsertStmt: 'INSERT',
  UpdateStmt: 'UPDATE',
  DeleteStmt: 'DELETE',
  MergeStmt: 'MERGE',
  IntoClause: 'SELECT ... INTO',
  LockingClause: 'row locking (FOR UPDATE / FOR SHARE)',
};

/** Functions that escape the sandbox, have side effects, or run dynamic SQL. */
const FORBIDDEN_FUNCTIONS = new Set([
  'set_config',
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_stat_file',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_promote',
  'pg_notify',
  'pg_import_system_collations',
  'nextval',
  'setval',
  'txid_current',
  'pg_current_xact_id',
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'table_to_xml',
  'table_to_xmlschema',
  'table_to_xml_and_xmlschema',
  'schema_to_xml',
  'schema_to_xmlschema',
  'schema_to_xml_and_xmlschema',
  'database_to_xml',
  'database_to_xmlschema',
  'database_to_xml_and_xmlschema',
]);

const FORBIDDEN_FUNCTION_PREFIXES = [
  'lo_',
  'dblink',
  'pg_ls_',
  'pg_advisory',
  'pg_try_advisory',
  'pg_file_',
  'pg_logical_',
  'pg_replication_',
  'pg_create_',
  'pg_drop_',
  'pg_copy_',
];

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast']);

type AstNode = Record<string, unknown>;

function isObject(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => {
    if (isObject(node) && isObject(node.String) && typeof node.String.sval === 'string') {
      return [node.String.sval];
    }
    return [];
  });
}

/**
 * Depth-first walk yielding [nodeType, body] for every AST node. Most nodes are
 * wrapped as { TypeName: body }, but a few fields embed bodies directly
 * (e.g. SelectStmt.intoClause, IntoClause.rel), so those are detected too.
 */
function* walk(value: unknown, seen = new WeakSet<object>()): Generator<[string, AstNode]> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item, seen);
    return;
  }
  if (!isObject(value)) return;
  if (!seen.has(value) && 'relname' in value && 'relpersistence' in value) {
    seen.add(value);
    yield ['RangeVar', value];
  }
  for (const [key, child] of Object.entries(value)) {
    if (!isObject(child)) {
      yield* walk(child, seen);
      continue;
    }
    if (key === 'intoClause') {
      yield ['IntoClause', child];
    } else if (/^[A-Z]/.test(key) && !seen.has(child)) {
      seen.add(child);
      yield [key, child];
    }
    yield* walk(child, seen);
  }
}

function isForbiddenFunction(name: string): boolean {
  return (
    FORBIDDEN_FUNCTIONS.has(name) || FORBIDDEN_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

async function parseOrThrow(sql: string): Promise<AstNode> {
  try {
    return (await parse(sql)) as unknown as AstNode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SqlGuardError(`SQL could not be parsed: ${message}`);
  }
}

/**
 * Validates that `sql` is exactly one read-only SELECT that touches only
 * allowlisted schemas. Throws SqlGuardError with a model-actionable message.
 */
export async function guardSelect(sql: string, options: GuardOptions): Promise<GuardedStatement> {
  if (sql.length > options.maxLength) {
    throw new SqlGuardError(`SQL is ${sql.length} characters; the limit is ${options.maxLength}.`);
  }
  if (sql.includes('\u0000')) {
    throw new SqlGuardError('SQL must not contain NUL bytes.');
  }

  const tree = await parseOrThrow(sql);
  const stmts = Array.isArray(tree.stmts) ? (tree.stmts as AstNode[]) : [];
  if (stmts.length === 0) throw new SqlGuardError('No SQL statement found.');
  if (stmts.length > 1) {
    throw new SqlGuardError(`Exactly one statement is allowed; found ${stmts.length}.`);
  }

  const [raw] = stmts as [AstNode];
  const stmt = isObject(raw.stmt) ? raw.stmt : {};
  const [kind] = Object.keys(stmt);
  if (kind !== 'SelectStmt') {
    const readable = kind ? kind.replace(/Stmt$/, '').toUpperCase() : 'UNKNOWN';
    throw new SqlGuardError(`Only SELECT statements are allowed; got ${readable}.`);
  }

  const allowed = new Set(options.allowedSchemas);
  const relations: GuardedStatement['relations'] = [];

  for (const [type, node] of walk(stmt)) {
    const forbidden = FORBIDDEN_NODES[type];
    if (forbidden) throw new SqlGuardError(`${forbidden} is not allowed in a read-only query.`);

    if (type === 'FuncCall') {
      const parts = stringList(node.funcname).map((part) => part.toLowerCase());
      const name = parts.at(-1) ?? '';
      if (isForbiddenFunction(name)) {
        throw new SqlGuardError(`Function ${name}() is not allowed.`);
      }
      const schema = parts.length > 1 ? parts[0] : undefined;
      if (schema !== undefined && schema !== 'pg_catalog' && !allowed.has(schema)) {
        throw new SqlGuardError(`Function schema "${schema}" is not in the allowlist.`);
      }
    }

    if (type === 'RangeVar') {
      const schema = typeof node.schemaname === 'string' ? node.schemaname : null;
      const name = typeof node.relname === 'string' ? node.relname : '';
      if (schema !== null && !allowed.has(schema)) {
        const reason = SYSTEM_SCHEMAS.has(schema) ? 'system catalogs are not exposed' : 'it is not in the allowlist';
        throw new SqlGuardError(
          `Schema "${schema}" cannot be queried: ${reason}. Allowed schemas: ${[...allowed].join(', ')}.`,
        );
      }
      if (schema === null && name.startsWith('pg_')) {
        throw new SqlGuardError(
          `Relation "${name}" looks like a system catalog; use the dedicated tools for metadata instead.`,
        );
      }
      relations.push({ schema, name });
    }
  }

  const location = typeof raw.stmt_location === 'number' ? raw.stmt_location : 0;
  const length = typeof raw.stmt_len === 'number' && raw.stmt_len > 0 ? raw.stmt_len : undefined;
  const statement = sql.slice(location, length === undefined ? undefined : location + length).trim();

  return { sql: statement.replace(/;\s*$/, ''), relations };
}

/**
 * Wraps a guarded SELECT so the server, not the agent, controls the row cap.
 * The newline before the closing parenthesis neutralises a trailing `--` comment.
 * The wrapped text is re-validated to make sure the wrapping did not change
 * the statement's shape.
 */
export async function wrapWithLimit(statement: GuardedStatement, limit: number, options: GuardOptions): Promise<string> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const wrapped = `SELECT * FROM (\n${statement.sql}\n) AS mcp_insight_q LIMIT ${limit}`;
  await guardSelect(wrapped, { ...options, maxLength: options.maxLength + 64 });
  return wrapped;
}
