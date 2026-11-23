import type { DbClient } from './db.js';
import { ToolError } from './errors.js';
import type { IndexInfo, RelationStats } from './plan-analyzer.js';
import { relationKey } from './plan-analyzer.js';

/** Catalog queries. All are parameterised and scoped to allowlisted schemas. */

const RELKIND: Record<string, string> = {
  r: 'table',
  p: 'partitioned table',
  v: 'view',
  m: 'materialized view',
  f: 'foreign table',
};

export interface TableRef {
  oid: number;
  schema: string;
  name: string;
  kind: string;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function assertSchemaAllowed(schema: string, allowed: readonly string[]): void {
  if (!allowed.includes(schema)) {
    throw new ToolError(`Schema "${schema}" is not available. Allowed schemas: ${allowed.join(', ')}.`);
  }
}

/** Resolves a table in an allowlisted schema or throws a model-friendly error. */
export async function resolveTable(
  client: DbClient,
  allowed: readonly string[],
  schema: string,
  table: string,
): Promise<TableRef> {
  assertSchemaAllowed(schema, allowed);
  const { rows } = await client.query<{ oid: string; kind: string }>(
    `SELECT c.oid::int8 AS oid, c.relkind AS kind
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [schema, table],
  );
  const row = rows[0];
  if (!row) throw new ToolError(`Table "${schema}"."${table}" does not exist. Use list_schemas to see available tables.`);
  return { oid: Number(row.oid), schema, name: table, kind: RELKIND[row.kind] ?? row.kind };
}

export interface SchemaListing {
  schema: string;
  tables: {
    name: string;
    kind: string;
    rowEstimate: number | null;
    totalBytes: number | null;
    comment: string | null;
  }[];
}

export async function listSchemas(client: DbClient, allowed: readonly string[]): Promise<SchemaListing[]> {
  const { rows } = await client.query<{
    schema: string;
    name: string | null;
    kind: string | null;
    row_estimate: string | null;
    total_bytes: string | null;
    comment: string | null;
  }>(
    `SELECT n.nspname AS schema,
            c.relname AS name,
            c.relkind AS kind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END AS row_estimate,
            pg_catalog.pg_total_relation_size(c.oid) AS total_bytes,
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment
       FROM pg_catalog.pg_namespace n
       LEFT JOIN pg_catalog.pg_class c
              ON c.relnamespace = n.oid
             AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND NOT c.relispartition
      WHERE n.nspname = ANY($1::text[])
      ORDER BY n.nspname, c.relname`,
    [allowed],
  );

  const bySchema = new Map<string, SchemaListing>();
  for (const row of rows) {
    const listing = bySchema.get(row.schema) ?? { schema: row.schema, tables: [] };
    bySchema.set(row.schema, listing);
    if (row.name === null || row.kind === null) continue;
    listing.tables.push({
      name: row.name,
      kind: RELKIND[row.kind] ?? row.kind,
      rowEstimate: toNumber(row.row_estimate),
      totalBytes: toNumber(row.total_bytes),
      comment: row.comment,
    });
  }
  return [...bySchema.values()];
}

interface IndexRow {
  relid: string;
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
  is_valid: boolean;
  columns: (string | null)[];
  size_bytes: string;
  scans: string | null;
}

async function indexesFor(client: DbClient, relids: number[]): Promise<IndexRow[]> {
  const { rows } = await client.query<IndexRow>(
    `SELECT x.indrelid::int8::text AS relid,
            i.relname AS name,
            pg_catalog.pg_get_indexdef(x.indexrelid) AS definition,
            x.indisunique AS is_unique,
            x.indisprimary AS is_primary,
            x.indisvalid AS is_valid,
            ARRAY(
              SELECT a.attname::text
                FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                LEFT JOIN pg_catalog.pg_attribute a
                       ON a.attrelid = x.indrelid AND a.attnum = k.attnum AND k.attnum > 0
               WHERE k.ord <= x.indnkeyatts
               ORDER BY k.ord
            ) AS columns,
            pg_catalog.pg_relation_size(x.indexrelid) AS size_bytes,
            s.idx_scan AS scans
       FROM pg_catalog.pg_index x
       JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
       LEFT JOIN pg_catalog.pg_stat_all_indexes s ON s.indexrelid = x.indexrelid
      WHERE x.indrelid = ANY($1::oid[])
      ORDER BY i.relname`,
    [relids],
  );
  return rows;
}

export interface TableDescription {
  schema: string;
  name: string;
  kind: string;
  comment: string | null;
  rowEstimate: number | null;
  totalSize: string;
  stats: Record<string, unknown> | null;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    identity: boolean;
    comment: string | null;
    redactedInSamples: boolean;
  }[];
  primaryKey: string[];
  indexes: {
    name: string;
    definition: string;
    unique: boolean;
    primary: boolean;
    valid: boolean;
    columns: (string | null)[];
    sizeBytes: number | null;
    scans: number | null;
  }[];
  foreignKeys: { name: string; columns: string[]; definition: string; indexed: boolean }[];
  referencedBy: { name: string; fromTable: string; definition: string }[];
  insights: string[];
}

export async function describeTable(
  client: DbClient,
  ref: TableRef,
  allowed: readonly string[],
  isRedacted: (column: string) => boolean,
): Promise<TableDescription> {
  const [meta, columns, indexes, foreignKeys, referencedBy] = [
    await client.query<{
      comment: string | null;
      row_estimate: string | null;
      total_size: string;
      live_rows: string | null;
      dead_rows: string | null;
      seq_scan: string | null;
      seq_tup_read: string | null;
      idx_scan: string | null;
      last_analyze: Date | null;
      last_autoanalyze: Date | null;
      last_vacuum: Date | null;
      last_autovacuum: Date | null;
    }>(
      `SELECT pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END AS row_estimate,
              pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) AS total_size,
              s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows,
              s.seq_scan, s.seq_tup_read, s.idx_scan,
              s.last_analyze, s.last_autoanalyze, s.last_vacuum, s.last_autovacuum
         FROM pg_catalog.pg_class c
         LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid = c.oid
        WHERE c.oid = $1`,
      [ref.oid],
    ),
    await client.query<{
      name: string;
      type: string;
      not_null: boolean;
      default: string | null;
      identity: boolean;
      comment: string | null;
      attnum: number;
    }>(
      `SELECT a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default,
              a.attidentity <> '' AS identity,
              pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
              a.attnum
         FROM pg_catalog.pg_attribute a
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [ref.oid],
    ),
    await indexesFor(client, [ref.oid]),
    await client.query<{ name: string; definition: string; columns: string[] }>(
      `SELECT con.conname AS name,
              pg_catalog.pg_get_constraintdef(con.oid) AS definition,
              ARRAY(
                SELECT a.attname::text
                  FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                 ORDER BY k.ord
              ) AS columns
         FROM pg_catalog.pg_constraint con
        WHERE con.conrelid = $1 AND con.contype = 'f'
        ORDER BY con.conname`,
      [ref.oid],
    ),
    await client.query<{ name: string; from_table: string; definition: string }>(
      `SELECT con.conname AS name,
              n.nspname || '.' || c.relname AS from_table,
              pg_catalog.pg_get_constraintdef(con.oid) AS definition
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE con.confrelid = $1 AND con.contype = 'f' AND n.nspname = ANY($2::text[])
        ORDER BY 2, 1`,
      [ref.oid, allowed],
    ),
  ];

  const m = meta.rows[0];
  const primary = indexes.find((index) => index.is_primary);
  const insights: string[] = [];

  const fks = foreignKeys.rows.map((fk) => {
    const indexed = indexes.some((index) =>
      fk.columns.every((column) => index.columns.slice(0, fk.columns.length).includes(column)),
    );
    if (!indexed) {
      insights.push(
        `Foreign key ${fk.name} (${fk.columns.join(', ')}) has no supporting index: joins on it and deletes on the referenced table will scan ${ref.schema}.${ref.name}.`,
      );
    }
    return { name: fk.name, columns: fk.columns, definition: fk.definition, indexed };
  });

  for (const index of indexes) {
    if (!index.is_valid) insights.push(`Index ${index.name} is INVALID (failed concurrent build); drop and recreate it.`);
    if (!index.is_primary && !index.is_unique && index.scans !== null && Number(index.scans) === 0) {
      insights.push(`Index ${index.name} has never been used since statistics were last reset.`);
    }
  }

  const liveRows = toNumber(m?.live_rows);
  const deadRows = toNumber(m?.dead_rows);
  if (liveRows !== null && deadRows !== null && liveRows > 1_000 && deadRows / liveRows > 0.2) {
    insights.push(`High dead-tuple ratio (${deadRows} dead vs ${liveRows} live); check autovacuum settings.`);
  }
  if (m?.row_estimate === null && ref.kind === 'table') {
    insights.push('Table has never been analyzed; planner estimates will be poor until ANALYZE runs.');
  }

  return {
    schema: ref.schema,
    name: ref.name,
    kind: ref.kind,
    comment: m?.comment ?? null,
    rowEstimate: toNumber(m?.row_estimate),
    totalSize: m?.total_size ?? 'unknown',
    stats: m
      ? {
          liveRows,
          deadRows,
          seqScans: toNumber(m.seq_scan),
          seqRowsRead: toNumber(m.seq_tup_read),
          indexScans: toNumber(m.idx_scan),
          lastAnalyze: (m.last_analyze ?? m.last_autoanalyze)?.toISOString() ?? null,
          lastVacuum: (m.last_vacuum ?? m.last_autovacuum)?.toISOString() ?? null,
        }
      : null,
    columns: columns.rows.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: !column.not_null,
      default: column.default,
      identity: column.identity,
      comment: column.comment,
      redactedInSamples: isRedacted(column.name),
    })),
    primaryKey: primary ? primary.columns.filter((column): column is string => column !== null) : [],
    indexes: indexes.map((index) => ({
      name: index.name,
      definition: index.definition,
      unique: index.is_unique,
      primary: index.is_primary,
      valid: index.is_valid,
      columns: index.columns,
      sizeBytes: toNumber(index.size_bytes),
      scans: toNumber(index.scans),
    })),
    foreignKeys: fks,
    referencedBy: referencedBy.rows.map((row) => ({
      name: row.name,
      fromTable: row.from_table,
      definition: row.definition,
    })),
    insights,
  };
}

/** Row estimates and index key columns for relations that appear in a plan. */
export async function relationStats(
  client: DbClient,
  relations: { schema: string; name: string }[],
): Promise<Map<string, RelationStats>> {
  const result = new Map<string, RelationStats>();
  if (relations.length === 0) return result;

  const { rows } = await client.query<{ oid: string; schema: string; name: string; row_estimate: string | null }>(
    `SELECT c.oid::int8::text AS oid, n.nspname AS schema, c.relname AS name,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END AS row_estimate
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest($1::text[], $2::text[]) AS r(schema, name) ON r.schema = n.nspname AND r.name = c.relname`,
    [relations.map((r) => r.schema), relations.map((r) => r.name)],
  );

  const indexes = await indexesFor(
    client,
    rows.map((row) => Number(row.oid)),
  );
  for (const row of rows) {
    const own: IndexInfo[] = indexes
      .filter((index) => index.relid === row.oid && index.is_valid)
      .map((index) => ({ name: index.name, columns: index.columns }));
    result.set(relationKey(row.schema, row.name), { rowEstimate: toNumber(row.row_estimate), indexes: own });
  }
  return result;
}

export interface OverviewTable {
  schema: string;
  name: string;
  kind: string;
  rowEstimate: number | null;
  columns: { name: string; type: string }[];
}

/** Compact listing of every table and its columns, for the schema overview resource. */
export async function schemaOverview(
  client: DbClient,
  allowed: readonly string[],
  maxTables: number,
): Promise<{ tables: OverviewTable[]; truncated: boolean }> {
  const { rows } = await client.query<{
    schema: string;
    name: string;
    kind: string;
    row_estimate: string | null;
    columns: { name: string; type: string }[];
  }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END AS row_estimate,
            COALESCE((
              SELECT json_agg(json_build_object('name', a.attname,
                                                'type', pg_catalog.format_type(a.atttypid, a.atttypmod))
                              ORDER BY a.attnum)
                FROM pg_catalog.pg_attribute a
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            ), '[]'::json) AS columns
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND NOT c.relispartition
      ORDER BY n.nspname, c.relname
      LIMIT $2`,
    [allowed, maxTables + 1],
  );
  return {
    truncated: rows.length > maxTables,
    tables: rows.slice(0, maxTables).map((row) => ({
      schema: row.schema,
      name: row.name,
      kind: RELKIND[row.kind] ?? row.kind,
      rowEstimate: toNumber(row.row_estimate),
      columns: row.columns,
    })),
  };
}
