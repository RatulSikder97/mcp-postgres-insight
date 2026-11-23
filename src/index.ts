#!/usr/bin/env node
import { ConfigError } from './config.js';
import { main } from './main.js';

main().catch((error: unknown) => {
  // The logger may not exist yet (bad config), so report directly to stderr.
  const message = error instanceof ConfigError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`mcp-postgres-insight: ${message}\n`);
  process.exit(1);
});
