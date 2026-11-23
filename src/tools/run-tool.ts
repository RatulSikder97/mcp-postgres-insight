import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerContext } from '../context.js';
import { errorResult } from '../envelope.js';
import { describeError, ToolError } from '../errors.js';
import { SqlGuardError } from '../sql-guard.js';

/**
 * Runs a tool body with uniform logging and error mapping. Expected failures
 * (validation, guard rejections, PostgreSQL errors) become isError results the
 * model can recover from; unexpected ones are logged with full detail and
 * reported generically.
 */
export async function runTool(
  ctx: ServerContext,
  tool: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const result = await body();
    ctx.logger.info({ tool, durationMs: Math.round(performance.now() - started) }, 'tool call succeeded');
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    if (error instanceof SqlGuardError || error instanceof ToolError) {
      ctx.logger.info({ tool, durationMs, reason: error.message }, 'tool call rejected');
      return errorResult(error.message);
    }
    const message = describeError(error, ctx.config.STATEMENT_TIMEOUT_MS);
    ctx.logger.warn({ tool, durationMs, err: error }, 'tool call failed');
    return errorResult(message);
  }
}
