import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyzePlan,
  collectRelations,
  extractColumns,
  type ExplainOutput,
  type PlanNode,
  type RelationStats,
} from '../../src/plan-analyzer.js';

function fixture(name: string): ExplainOutput {
  const parsed = JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as ExplainOutput[];
  return parsed[0]!;
}

const options = { seqScanRowThreshold: 10_000 };

const ordersNoIndex = new Map<string, RelationStats>([
  ['app.orders', { rowEstimate: 60_000, indexes: [{ name: 'orders_pkey', columns: ['id'] }] }],
]);

describe('extractColumns', () => {
  it('extracts alias-qualified columns in order without duplicates', () => {
    expect(extractColumns("((o.status = 'paid'::text) AND (o.customer_id = 42) AND (o.status <> 'x'))", 'o')).toEqual([
      'status',
      'customer_id',
    ]);
  });

  it('ignores other aliases and handles quoted identifiers', () => {
    expect(extractColumns('((c.id = o.customer_id) AND ("O"."Weird Col" > 1))', 'O')).toEqual(['Weird Col']);
    expect(extractColumns('(co.id = 1)', 'o')).toEqual([]);
  });
});

describe('analyzePlan on a real seq-scan plan', () => {
  const plan = fixture('plan-seq-scan.json');

  it('collects scanned relations', () => {
    expect(collectRelations(plan.Plan)).toEqual([{ schema: 'app', name: 'orders' }]);
  });

  it('suggests an index for a selective filter on a large table', () => {
    const { hints, summary } = analyzePlan(plan, ordersNoIndex, options);
    expect(summary.analyzed).toBe(false);
    expect(summary.nodeCounts).toEqual({ Sort: 1, 'Seq Scan': 1 });
    expect(summary.hottestNodes[0]?.node).toBe('Seq Scan on app.orders');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      severity: 'warning',
      kind: 'seq_scan_large_table',
      relation: 'app.orders',
      suggestion: 'CREATE INDEX CONCURRENTLY ON "app"."orders" ("customer_id");',
    });
  });

  it('does not suggest an index that already exists', () => {
    const withIndex = new Map<string, RelationStats>([
      [
        'app.orders',
        { rowEstimate: 60_000, indexes: [{ name: 'orders_customer_id_idx', columns: ['customer_id', 'created_at'] }] },
      ],
    ]);
    const { hints } = analyzePlan(plan, withIndex, options);
    expect(hints[0]).toMatchObject({ kind: 'seq_scan_index_unused', suggestion: 'ANALYZE "app"."orders";' });
    expect(hints[0]?.message).toContain('orders_customer_id_idx');
  });

  it('stays quiet about small tables', () => {
    const small = new Map<string, RelationStats>([['app.orders', { rowEstimate: 500, indexes: [] }]]);
    expect(analyzePlan(plan, small, options).hints).toEqual([]);
  });
});

describe('analyzePlan heuristics', () => {
  const seqScan = (overrides: Partial<PlanNode>): PlanNode => ({
    'Node Type': 'Seq Scan',
    'Relation Name': 'orders',
    Schema: 'app',
    Alias: 'o',
    'Total Cost': 1_000,
    'Plan Rows': 30_000,
    ...overrides,
  });

  it('treats non-selective filters as informational', () => {
    const { hints } = analyzePlan({ Plan: seqScan({ Filter: "(o.status <> 'x'::text)" }) }, ordersNoIndex, options);
    expect(hints[0]).toMatchObject({ severity: 'info', kind: 'seq_scan_large_table' });
    expect(hints[0]?.suggestion).toBeUndefined();
  });

  it('does not suggest an index when ~20% of rows match', () => {
    const plan = { Plan: seqScan({ Filter: "(o.status = 'refunded'::text)", 'Plan Rows': 12_000 }) };
    const { hints } = analyzePlan(plan, ordersNoIndex, options);
    expect(hints[0]).toMatchObject({ severity: 'info', kind: 'seq_scan_large_table' });
    expect(hints[0]?.message).toContain('~20.0% of rows');
    expect(hints[0]?.suggestion).toBeUndefined();
  });

  it('flags unfiltered full scans', () => {
    const { hints } = analyzePlan({ Plan: seqScan({ 'Plan Rows': 60_000 }) }, ordersNoIndex, options);
    expect(hints[0]).toMatchObject({ severity: 'info', kind: 'full_table_scan' });
  });

  it('flags a sequential scan repeated on the inner side of a nested loop', () => {
    const plan: ExplainOutput = {
      Plan: {
        'Node Type': 'Nested Loop',
        'Total Cost': 90_000,
        'Plan Rows': 100,
        'Join Filter': '(o.customer_id = c.id)',
        Plans: [
          { 'Node Type': 'Index Scan', 'Relation Name': 'customers', Schema: 'app', Alias: 'c', 'Total Cost': 10, 'Plan Rows': 50 },
          seqScan({ 'Parent Relationship': 'Inner', 'Total Cost': 1_200, 'Plan Rows': 60_000 }),
        ],
      },
    };
    const { hints } = analyzePlan(plan, ordersNoIndex, options);
    expect(hints[0]).toMatchObject({
      severity: 'critical',
      kind: 'nested_loop_inner_seq_scan',
      suggestion: 'CREATE INDEX CONCURRENTLY ON "app"."orders" ("customer_id");',
    });
  });

  it('reports disk sorts, multi-batch hashes and misestimates from EXPLAIN ANALYZE', () => {
    const plan: ExplainOutput = {
      'Planning Time': 0.2,
      'Execution Time': 812.5,
      Plan: {
        'Node Type': 'Sort',
        'Total Cost': 5_000,
        'Plan Rows': 200,
        'Actual Rows': 50_000,
        'Actual Loops': 1,
        'Sort Key': ['o.created_at'],
        'Sort Space Type': 'Disk',
        Plans: [
          {
            'Node Type': 'Hash',
            'Total Cost': 2_000,
            'Plan Rows': 50_000,
            'Actual Rows': 50_000,
            'Actual Loops': 1,
            'Hash Batches': 4,
          },
        ],
      },
    };
    const { hints, summary } = analyzePlan(plan, new Map(), options);
    expect(summary).toMatchObject({ analyzed: true, executionMs: 812.5, planningMs: 0.2 });
    expect(hints.map((hint) => hint.kind).sort()).toEqual(['hash_multiple_batches', 'row_misestimate', 'sort_spilled_to_disk']);
    expect(hints.find((hint) => hint.kind === 'row_misestimate')?.message).toContain('250x off');
  });

  it('orders hints by severity', () => {
    const plan: ExplainOutput = {
      Plan: {
        'Node Type': 'Append',
        'Total Cost': 3_000,
        'Plan Rows': 1,
        Plans: [
          seqScan({ 'Plan Rows': 60_000 }),
          {
            'Node Type': 'Nested Loop',
            'Total Cost': 2_000,
            'Plan Rows': 1,
            Plans: [
              { 'Node Type': 'Result', 'Total Cost': 0, 'Plan Rows': 5 },
              seqScan({ 'Parent Relationship': 'Inner', Filter: '(o.id = 1)' }),
            ],
          },
        ],
      },
    };
    const kinds = analyzePlan(plan, ordersNoIndex, options).hints.map((hint) => hint.severity);
    expect(kinds).toEqual(['critical', 'info']);
  });
});
