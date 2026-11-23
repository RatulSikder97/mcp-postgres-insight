/** An error whose message is safe and useful to return to the model verbatim. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

interface PgLikeError {
  code?: string;
  message: string;
  position?: string;
  hint?: string;
}

function isPgError(error: unknown): error is PgLikeError {
  return (
    error instanceof Error &&
    typeof (error as PgLikeError).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as PgLikeError).code ?? '')
  );
}

/** Converts any thrown value into a concise, model-facing explanation. */
export function describeError(error: unknown, statementTimeoutMs: number): string {
  if (error instanceof ToolError) return error.message;
  if (isPgError(error)) {
    switch (error.code) {
      case '57014':
        return `Query cancelled: it exceeded the ${statementTimeoutMs} ms statement_timeout. Narrow the query or add a LIMIT.`;
      case '25006':
        return 'Rejected by PostgreSQL: the session is read-only and this statement would write.';
      case '42501':
        return `Permission denied by PostgreSQL: ${error.message}`;
      default: {
        const hint = error.hint ? ` Hint: ${error.hint}` : '';
        return `PostgreSQL error ${error.code}: ${error.message}.${hint}`;
      }
    }
  }
  return 'Internal error while handling the request. See server logs for details.';
}
