import { describe, expect, test } from 'vitest';
import { forward } from './proxy.ts';

const request = () =>
  new Request('http://localhost:3001/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'no' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });

describe("the browser's way to the MCP server", () => {
  test("passes the request on and the server's answer back, protocol headers only", async () => {
    let sent: RequestInit | undefined;
    const res = await forward(request(), 'http://mcp.test/mcp', 1000, async (_url, init) => {
      sent = init;
      return new Response('{"ok":true}', {
        headers: { 'content-type': 'application/json', 'set-cookie': 'no' },
      });
    });
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(new Headers(sent?.headers).get('cookie')).toBeNull();
  });

  test('a server that never answers gets a 504 once the time is up', async () => {
    const silent = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      );
    const res = await forward(request(), 'http://mcp.test/mcp', 20, silent);
    expect(res.status).toBe(504);
  });
});
