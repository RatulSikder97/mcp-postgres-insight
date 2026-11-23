import { timingSafeEqual, createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Request, Response } from 'express';
import type { ServerContext } from './context.js';
import { createServer } from './server.js';

export interface HttpServerHandle {
  url: string;
  close: () => Promise<void>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerAuth(token: string) {
  const expected = digest(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (presented.length > 0 && timingSafeEqual(digest(presented), expected)) {
      next();
      return;
    }
    res.status(401).set('WWW-Authenticate', 'Bearer').json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  };
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * Streamable HTTP transport in stateless mode: each POST gets a fresh
 * McpServer + transport pair sharing the process-wide connection pool, so the
 * service scales horizontally without sticky sessions.
 */
export async function startHttpServer(ctx: ServerContext): Promise<HttpServerHandle> {
  const { config, logger } = ctx;
  const app = createMcpExpressApp({
    host: config.MCP_HTTP_HOST,
    ...(config.MCP_HTTP_ALLOWED_HOSTS ? { allowedHosts: config.MCP_HTTP_ALLOWED_HOSTS } : {}),
  });

  app.get('/healthz', (_req, res) => {
    ctx.db
      .ping()
      .then(() => res.json({ status: 'ok' }))
      .catch(() => res.status(503).json({ status: 'database unavailable' }));
  });

  const guards = config.MCP_HTTP_AUTH_TOKEN ? [bearerAuth(config.MCP_HTTP_AUTH_TOKEN)] : [];

  app.post('/mcp', ...guards, async (req: Request, res: Response) => {
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error }, 'failed to handle MCP HTTP request');
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    jsonRpcError(res.set('Allow', 'POST'), 405, 'Method not allowed: this server runs in stateless mode.');
  };
  app.get('/mcp', ...guards, methodNotAllowed);
  app.delete('/mcp', ...guards, methodNotAllowed);

  const httpServer = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(config.MCP_HTTP_PORT, config.MCP_HTTP_HOST, (error?: Error) => {
      if (error) reject(error);
      else resolve(listener);
    });
  });

  const { port } = httpServer.address() as AddressInfo;
  const host = config.MCP_HTTP_HOST.includes(':') ? `[${config.MCP_HTTP_HOST}]` : config.MCP_HTTP_HOST;
  const url = `http://${host}:${port}/mcp`;
  logger.info({ url, auth: Boolean(config.MCP_HTTP_AUTH_TOKEN) }, 'streamable HTTP transport listening');

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
