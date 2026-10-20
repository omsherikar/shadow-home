import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { connectTools, MCP_TIMEOUT_MS, RULE_TIMEOUT_MS } from './mcp.ts';

describe('how long a turn waits on the MCP server', () => {
  afterEach(() => vi.restoreAllMocks());

  test('add_house_rule waits 45 s, for the server to give up on a compile first; other tools 15 s', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
    const call = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [] });
    const tools = await connectTools({ url: 'http://mcp.test/mcp' });
    for (const name of ['add_house_rule', 'preview_plan', 'commit_plan', 'get_activity_log']) {
      await tools.callTool(name, {});
    }
    expect(call.mock.calls.map(([params, options]) => [params.name, options])).toEqual([
      ['add_house_rule', { timeout: RULE_TIMEOUT_MS }],
      ['preview_plan', { timeout: MCP_TIMEOUT_MS }],
      ['commit_plan', { timeout: MCP_TIMEOUT_MS }],
      ['get_activity_log', { timeout: MCP_TIMEOUT_MS }],
    ]);
    expect([RULE_TIMEOUT_MS, MCP_TIMEOUT_MS]).toEqual([45_000, 15_000]);
  });

  test("setting up waits no longer than what is left of the turn's deadline", async () => {
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    const list = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
    const call = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [] });
    const tools = await connectTools({ url: 'http://mcp.test/mcp', deadline: Date.now() + 2_000 });
    await tools.homeBrief();
    for (const options of [
      connect.mock.calls[0]?.[1],
      list.mock.calls[0]?.[1],
      call.mock.calls[0]?.[1],
    ]) {
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(2_000);
    }
  });

  test('a setup that fails after connecting closes the client, so no socket is left open', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'listTools').mockRejectedValue(new Error('Request timed out'));
    const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
    await expect(connectTools({ url: 'http://mcp.test/mcp' })).rejects.toThrow(/timed out/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('a server that never answers: connecting gives up when its time is up', async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const started = Date.now();
    try {
      await expect(
        connectTools({ url: `http://127.0.0.1:${port}/mcp`, deadline: Date.now() + 100 }),
      ).rejects.toThrow(/timed out/i);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});
