import { qualifiedName, quoteIdent } from './identifiers.js';

/**
 * Turns EXPLAIN (FORMAT JSON, VERBOSE) output into a compact summary plus
 * actionable hints. Pure and deterministic: catalog facts are passed in, so
 * the heuristics are unit-testable against recorded plans.
 */

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Schema?: string;
  Alias?: string;
  'Index Name'?: string;
  'Parent Relationship'?: string;
  'Total Cost': number;
  'Plan Rows': number;
  Filter?: string;
  'Join Filter'?: string;
  'Rows Removed by Filter'?: number;
  'Sort Key'?: string[];
  'Sort Space Type'?: string;
  'Hash Batches'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Actual Total Time'?: number;
  Plans?: PlanNode[];
}

export interface ExplainOutput {
  Plan: PlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
}

export interface IndexInfo {
  name: string;
  /** Key columns in order; null for expression keys. */
  columns: (string | null)[];
}

export interface RelationStats {
  rowEstimate: number | null;
  indexes: IndexInfo[];
}

export type Severity = 'critical' | 'warning' | 'info';

export interface PlanHint {
  severity: Severity;
  kind:
    | 'seq_scan_large_table'
    | 'seq_scan_index_unused'
    | 'full_table_scan'
    | 'nested_loop_inner_seq_scan'
    | 'sort_spilled_to_disk'
    | 'large_sort'
    | 'hash_multiple_batches'
    | 'row_misestimate';
  relation?: string;
  message: string;
  suggestion?: string;
}

export interface PlanSummary {
  totalCost: number;
  estimatedRows: number;
  planningMs?: number;
  executionMs?: number;
  analyzed: boolean;
  nodeCounts: Record<string, number>;
  hottestNodes: { node: string; selfCost: number; shareOfTotal: number }[];
}

export interface PlanAnalysis {
  summary: PlanSummary;
  hints: PlanHint[];
}

export interface AnalyzeOptions {
  /** Tables with at least this many estimated rows are considered large. */
  seqScanRowThreshold: number;
}

/**
 * Above this fraction of matching rows a B-tree index rarely beats a
 * sequential scan, so no index is suggested.
 */
const NON_SELECTIVE_FRACTION = 0.1;

export function relationKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

/** Collects every (schema, relation) scanned anywhere in the plan. */
export function collectRelations(plan: PlanNode): { schema: string; name: string }[] {
  const seen = new Map<string, { schema: string; name: string }>();
  const visit = (node: PlanNode): void => {
    if (node['Relation Name'] && node.Schema) {
      seen.set(relationKey(node.Schema, node['Relation Name']), {
        schema: node.Schema,
        name: node['Relation Name'],
      });
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return [...seen.values()];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts `alias.column` references (VERBOSE output qualifies columns). */
export function extractColumns(expression: string, alias: string): string[] {
  const aliasPattern = `(?:"${escapeRegExp(alias.replaceAll('"', '""'))}"|${escapeRegExp(alias)})`;
  const pattern = new RegExp(`(?<![\\w$"])${aliasPattern}\\.(?:"((?:[^"]|"")+)"|([A-Za-z_][\\w$]*))`, 'g');
  const columns: string[] = [];
  for (const match of expression.matchAll(pattern)) {
    const column = match[1]?.replaceAll('""', '"') ?? match[2];
    if (column && !columns.includes(column)) columns.push(column);
  }
  return columns;
}

function label(node: PlanNode): string {
  const relation = node['Relation Name'];
  if (!relation) return node['Node Type'];
  const qualified = node.Schema ? `${node.Schema}.${relation}` : relation;
  const index = node['Index Name'] ? ` using ${node['Index Name']}` : '';
  return `${node['Node Type']} on ${qualified}${index}`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function hasLeadingIndex(stats: RelationStats | undefined, column: string): IndexInfo | undefined {
  return stats?.indexes.find((index) => index.columns[0] === column);
}

function analyzeSeqScan(
  node: PlanNode,
  parent: PlanNode | undefined,
  stats: RelationStats | undefined,
  options: AnalyzeOptions,
  hints: PlanHint[],
): void {
  const relation = node['Relation Name'];
  if (!relation || !node.Schema) return;
  const qualified = relationKey(node.Schema, relation);
  const tableRows = stats?.rowEstimate ?? null;
  const alias = node.Alias ?? relation;
  const loops = node['Actual Loops'] ?? 1;

  if (
    parent?.['Node Type'] === 'Nested Loop' &&
    node['Parent Relationship'] === 'Inner' &&
    (loops > 1 || (parent.Plans?.[0]?.['Plan Rows'] ?? 0) > 1) &&
    (tableRows ?? 0) >= Math.min(1_000, options.seqScanRowThreshold)
  ) {
    const joinColumns = extractColumns(`${parent['Join Filter'] ?? ''} ${node.Filter ?? ''}`, alias);
    hints.push({
      severity: 'critical',
      kind: 'nested_loop_inner_seq_scan',
      relation: qualified,
      message: `The inner side of a Nested Loop sequentially scans ${qualified} (${formatCount(tableRows ?? 0)} rows) once per outer row.`,
      ...(joinColumns.length > 0
        ? {
            suggestion: `CREATE INDEX CONCURRENTLY ON ${qualifiedName(node.Schema, relation)} (${joinColumns
              .slice(0, 3)
              .map(quoteIdent)
              .join(', ')});`,
          }
        : {}),
    });
    return;
  }

  if (tableRows === null || tableRows < options.seqScanRowThreshold) return;

  if (!node.Filter) {
    hints.push({
      severity: 'info',
      kind: 'full_table_scan',
      relation: qualified,
      message: `Reads all ~${formatCount(tableRows)} rows of ${qualified} with no filter. Expected for full aggregates; otherwise add a WHERE clause or LIMIT.`,
    });
    return;
  }

  const columns = extractColumns(node.Filter, alias);
  const selectivity = tableRows > 0 ? (node['Actual Rows'] ?? node['Plan Rows']) / tableRows : 1;
  const indexed = columns.map((column) => hasLeadingIndex(stats, column)).find((index) => index !== undefined);

  if (indexed) {
    hints.push({
      severity: 'warning',
      kind: 'seq_scan_index_unused',
      relation: qualified,
      message: `Sequential scan on ${qualified} even though index ${indexed.name} leads with a filtered column. The filter may be non-selective (~${(selectivity * 100).toFixed(1)}% of rows match), wrap the column in a function or cast, or statistics may be stale.`,
      suggestion: `ANALYZE ${qualifiedName(node.Schema, relation)};`,
    });
    return;
  }

  const nonSelective = selectivity > NON_SELECTIVE_FRACTION;
  hints.push({
    severity: nonSelective ? 'info' : 'warning',
    kind: 'seq_scan_large_table',
    relation: qualified,
    message: nonSelective
      ? `Sequential scan on ${qualified} (~${formatCount(tableRows)} rows); the filter keeps ~${(selectivity * 100).toFixed(1)}% of rows, so an index is unlikely to help.`
      : `Sequential scan on ${qualified} (~${formatCount(tableRows)} rows) filtered by ${node.Filter}; no index leads with ${columns.length > 0 ? columns.join(', ') : 'the filtered expression'}.`,
    ...(!nonSelective && columns.length > 0
      ? {
          suggestion: `CREATE INDEX CONCURRENTLY ON ${qualifiedName(node.Schema, relation)} (${columns
            .slice(0, 3)
            .map(quoteIdent)
            .join(', ')});`,
        }
      : {}),
  });
}

export function analyzePlan(
  explain: ExplainOutput,
  stats: ReadonlyMap<string, RelationStats>,
  options: AnalyzeOptions,
): PlanAnalysis {
  const root = explain.Plan;
  const analyzed = root['Actual Rows'] !== undefined;
  const hints: PlanHint[] = [];
  const nodeCounts: Record<string, number> = {};
  const selfCosts: { node: string; selfCost: number }[] = [];

  const visit = (node: PlanNode, parent: PlanNode | undefined): void => {
    const type = node['Node Type'];
    nodeCounts[type] = (nodeCounts[type] ?? 0) + 1;
    const childCost = (node.Plans ?? []).reduce((sum, child) => sum + child['Total Cost'], 0);
    selfCosts.push({ node: label(node), selfCost: Math.max(0, node['Total Cost'] - childCost) });

    const relation =
      node['Relation Name'] && node.Schema ? relationKey(node.Schema, node['Relation Name']) : undefined;

    if (type.endsWith('Seq Scan')) {
      analyzeSeqScan(node, parent, relation ? stats.get(relation) : undefined, options, hints);
    }

    if (type === 'Sort') {
      const keys = node['Sort Key']?.join(', ') ?? 'the sort key';
      if (node['Sort Space Type'] === 'Disk') {
        hints.push({
          severity: 'warning',
          kind: 'sort_spilled_to_disk',
          message: `Sort on ${keys} spilled to disk.`,
          suggestion: 'Raise work_mem for this workload, or add an index matching the ORDER BY so no sort is needed.',
        });
      } else if (node['Plan Rows'] >= options.seqScanRowThreshold) {
        hints.push({
          severity: 'info',
          kind: 'large_sort',
          message: `Sorts ~${formatCount(node['Plan Rows'])} rows on ${keys}.`,
          suggestion: 'If this query is frequent and has a LIMIT, an index matching the ORDER BY lets PostgreSQL skip the sort.',
        });
      }
    }

    if (type === 'Hash' && (node['Hash Batches'] ?? 1) > 1) {
      hints.push({
        severity: 'warning',
        kind: 'hash_multiple_batches',
        message: `Hash table needed ${node['Hash Batches']} batches (did not fit in work_mem).`,
        suggestion: 'Raise work_mem for this workload or reduce the rows feeding the hash join.',
      });
    }

    if (analyzed && node['Actual Rows'] !== undefined) {
      const estimated = Math.max(node['Plan Rows'], 1);
      const actual = Math.max(node['Actual Rows'], 1);
      const ratio = Math.max(estimated / actual, actual / estimated);
      if (ratio >= 10 && Math.max(estimated, actual) >= 100) {
        hints.push({
          severity: 'warning',
          kind: 'row_misestimate',
          ...(relation ? { relation } : {}),
          message: `${label(node)}: planner estimated ${formatCount(node['Plan Rows'])} rows but got ${formatCount(node['Actual Rows'])} (${ratio.toFixed(0)}x off).`,
          suggestion:
            relation && node.Schema && node['Relation Name']
              ? `ANALYZE ${qualifiedName(node.Schema, node['Relation Name'])}; consider extended statistics for correlated columns.`
              : 'Refresh statistics with ANALYZE on the tables involved; consider extended statistics for correlated columns.',
        });
      }
    }

    for (const child of node.Plans ?? []) visit(child, node);
  };

  visit(root, undefined);

  const severityRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  hints.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const totalCost = root['Total Cost'];
  const hottestNodes = selfCosts
    .sort((a, b) => b.selfCost - a.selfCost)
    .slice(0, 3)
    .map(({ node, selfCost }) => ({
      node,
      selfCost: Math.round(selfCost * 100) / 100,
      shareOfTotal: totalCost > 0 ? Math.round((selfCost / totalCost) * 1000) / 1000 : 0,
    }));

  return {
    summary: {
      totalCost,
      estimatedRows: root['Plan Rows'],
      ...(explain['Planning Time'] !== undefined ? { planningMs: explain['Planning Time'] } : {}),
      ...(explain['Execution Time'] !== undefined ? { executionMs: explain['Execution Time'] } : {}),
      analyzed,
      nodeCounts,
      hottestNodes,
    },
    hints,
  };
}
