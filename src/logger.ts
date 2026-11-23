import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logger bound to stderr (fd 2). stdout belongs to the MCP
 * stdio transport, so nothing in this process may ever write to it.
 */
export function createLogger(level: string): Logger {
  return pino(
    {
      name: 'mcp-postgres-insight',
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ['config.DATABASE_URL', 'connectionString', '*.password'], censor: '[redacted]' },
    },
    pino.destination({ fd: 2, sync: true }),
  );
}
