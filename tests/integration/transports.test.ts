import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createTestContext, dataOf, testEnv } from './helpers.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('stdio transport (spawned server process)', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = '';

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: root,
      env: { ...testEnv({ LOG_LEVEL: 'info' }), PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: 'stdio-e2e', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it('completes the handshake and serves tools', async () => {
    expect(client.getServerVersion()?.name).toBe('mcp-postgres-insight');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
  });

  it('answers tool calls end to end', async () => {
    const data = dataOf<{ rows: unknown[][] }>(
      await client.callTool({ name: 'run_readonly_query', arguments: { sql: 'SELECT count(*)::int FROM app.products' } }),
    );
    expect(data.rows).toEqual([[200]]);
  });

  it('logs structured JSON to stderr only', () => {
    const lines = stderr.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(stderr).toContain('"msg":"tool call succeeded"');
    expect(stderr).not.toContain('insight_reader:insight_reader');
  });
});

describe('streamable HTTP transport', () => {
  const token = 'test-token-0123456789-abcdefghijklmnop';
  const ctx = createTestContext({ MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '0', MCP_HTTP_AUTH_TOKEN: token });
  let http: HttpServerHandle;

  beforeAll(async () => {
    http = await startHttpServer(ctx);
  });

  afterAll(async () => {
    await http.close();
    await ctx.db.close();
  });

  const connectClient = async (bearer?: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(
      new URL(http.url),
      bearer ? { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } } : {},
    );
    const client = new Client({ name: 'http-e2e', version: '1.0.0' });
    await client.connect(transport);
    return client;
  };

  it('serves tools to an authenticated client', async () => {
    const client = await connectClient(token);
    try {
      const data = dataOf<{ schemas: { schema: string }[] }>(await client.callTool({ name: 'list_schemas', arguments: {} }));
      expect(data.schemas.map((schema) => schema.schema)).toEqual(['app']);
    } finally {
      await client.close();
    }
  });

  it('rejects missing or wrong bearer tokens', async () => {
    await expect(connectClient()).rejects.toThrow();
    await expect(connectClient('wrong-token')).rejects.toThrow();
    const response = await fetch(http.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(401);
  });

  it('exposes an unauthenticated health check', async () => {
    const response = await fetch(http.url.replace('/mcp', '/healthz'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('rejects GET on the MCP endpoint in stateless mode', async () => {
    const response = await fetch(http.url, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(405);
  });

  it('rejects requests with a foreign Host header (DNS rebinding protection)', async () => {
    const { request } = await import('node:http');
    const url = new URL(http.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
