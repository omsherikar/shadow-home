import { createMcpHonoApp, localhostOriginValidation } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Home } from '@shadow-home/twin';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DemoClock } from './clock.ts';
import { initialState } from './live-home.ts';
import type { ShadowHomeService } from './service.ts';
import { isoAt } from './time.ts';
import { buildServer } from './tools.ts';

export interface AppOptions {
  /** Hostnames allowed in the Host header. Default: localhost only (DNS rebinding protection). */
  allowedHosts?: string[];
  /**
   * Accept any Host, behind a platform that routes by Host itself: Cloud Run only sends a request
   * here if it named one of the service's own domains. Origins are checked as by default.
   */
  anyHost?: boolean;
  onError?: (error: Error) => void;
  /**
   * The local demo's controls at /demo: move home time forward to the next scene, and start the
   * home over. Never part of the MCP surface, so no model can move time.
   */
  demo?: { clock: DemoClock; home: Home };
}

const jump = z.object({ now: z.iso.datetime({ offset: true }) });

/**
 * The HTTP app: MCP over Streamable HTTP at /mcp, for 2026-07-28 clients and, statelessly,
 * 2025-era ones (2025-11-25, and 2025-03-26 as Alexa+ sends), plus /healthz.
 */
export function createApp(service: ShadowHomeService, options: AppOptions = {}): Hono {
  const handler = createMcpHandler(() => buildServer(service), {
    legacy: 'stateless',
    ...(options.onError ? { onerror: options.onError } : {}),
  });
  const app = createMcpHonoApp(
    options.allowedHosts
      ? { allowedHosts: options.allowedHosts }
      : options.anyHost
        ? { host: '0.0.0.0' }
        : {},
  );
  // Bound to every address, the app checks no Origin; keep the default's: none, or localhost.
  if (options.anyHost && !options.allowedHosts) app.use('*', localhostOriginValidation());
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.all('/mcp', (c) => {
    // createMcpHonoApp's body parser stores the JSON body here; its Hono type doesn't declare it.
    const parsedBody = (c as unknown as { get(key: string): unknown }).get('parsedBody');
    return handler.fetch(c.req.raw, { parsedBody });
  });

  const demo = options.demo;
  if (demo) {
    const now = () => ({ homeNow: isoAt(demo.clock.homeNowMs(), demo.home.home.utcOffset) });
    app.get('/demo', (c) => c.json(now()));
    app.post('/demo/clock', async (c) => {
      const parsedBody = (c as unknown as { get(key: string): unknown }).get('parsedBody');
      const body = jump.safeParse(parsedBody ?? (await c.req.json().catch(() => null)));
      if (!body.success) return c.json({ error: 'Send { "now": ISO time with offset }' }, 400);
      demo.clock.jumpTo(Date.parse(body.data.now));
      return c.json(now());
    });
    app.post('/demo/reset', async (c) => {
      demo.clock.restart(Date.parse(demo.home.clock.now));
      await service.reset(initialState(demo.home));
      return c.json(now());
    });
  }
  return app;
}
