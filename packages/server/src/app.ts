import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import type { ShadowHomeService } from './service.ts';
import { buildServer } from './tools.ts';

export interface AppOptions {
  /** Hostnames allowed in the Host header. Default: localhost only (DNS rebinding protection). */
  allowedHosts?: string[];
  onError?: (error: Error) => void;
}

/**
 * The HTTP app: MCP over Streamable HTTP at /mcp, for 2026-07-28 clients and, statelessly,
 * 2025-era ones (2025-11-25, and 2025-03-26 as Alexa+ sends), plus /healthz.
 */
export function createApp(service: ShadowHomeService, options: AppOptions = {}): Hono {
  const handler = createMcpHandler(() => buildServer(service), {
    legacy: 'stateless',
    ...(options.onError ? { onerror: options.onError } : {}),
  });
  const app = createMcpHonoApp(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {});
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.all('/mcp', (c) => {
    // createMcpHonoApp's body parser stores the JSON body here; its Hono type doesn't declare it.
    const parsedBody = (c as unknown as { get(key: string): unknown }).get('parsedBody');
    return handler.fetch(c.req.raw, { parsedBody });
  });
  return app;
}
