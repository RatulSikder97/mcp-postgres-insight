import type { Config } from './config.js';
import type { Database } from './db.js';
import type { Logger } from './logger.js';
import type { RedactionOptions } from './redaction.js';
import type { GuardOptions } from './sql-guard.js';

/** Dependencies shared by every tool, resource and prompt handler. */
export interface ServerContext {
  config: Config;
  db: Database;
  logger: Logger;
  redaction: RedactionOptions;
  guard: GuardOptions;
}

export function buildContext(config: Config, db: Database, logger: Logger): ServerContext {
  return {
    config,
    db,
    logger,
    redaction: {
      columnPattern: config.REDACT_COLUMNS,
      redactValues: config.REDACT_VALUES,
      maxCellChars: config.MAX_CELL_CHARS,
    },
    guard: {
      allowedSchemas: config.PG_ALLOWED_SCHEMAS,
      maxLength: config.MAX_SQL_LENGTH,
    },
  };
}
