import type { CallToolResult, Client } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { ToolCall } from '../turn/types.ts';

/** A tool result to put on screen through the view its tool declares. */
export interface Shown {
  resourceUri: string;
  arguments: Record<string, unknown>;
  result: CallToolResult;
}

export interface ScreenEvents {
  /** The view called a tool (a tap on screen). */
  onViewCall(call: ToolCall): void;
  /** The view told the assistant something for its next turn. */
  onModelContext(text: string): void;
}

const HOST = { name: 'shadow-home-echo', version: '0.1.0' };

/**
 * What a view may do inside its frame: run its own inline script and styles, and nothing else.
 * No network, no other origins; it reaches the server only through the bridge.
 */
export const VIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The view's HTML with the policy as its first element, before any script can run. */
export function withPolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return `${meta}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}

interface Frame {
  uri: string;
  bridge: AppBridge;
  ready: Promise<void>;
}

/**
 * The screen's one MCP App frame. A result for the view already on screen goes to that view;
 * a different view replaces it. Each view runs in an iframe sandboxed without same-origin, so
 * it has an opaque origin of its own and can't touch the page, its storage or the network.
 */
export class ScreenHost {
  private frame: Frame | undefined;
  private opening: Promise<Frame> | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly client: Client,
    private readonly events: ScreenEvents,
  ) {}

  async show(shown: Shown): Promise<void> {
    const frame = await this.frameFor(shown.resourceUri);
    await frame.ready;
    await frame.bridge.sendToolInput({ arguments: shown.arguments });
    await frame.bridge.sendToolResult(shown.result);
  }

  async close(): Promise<void> {
    const frame = this.frame;
    this.frame = undefined;
    this.container.replaceChildren();
    if (!frame) return;
    // Give the view a moment to finish up, but never wait on it.
    await Promise.race([
      frame.bridge.teardownResource({}).catch(() => undefined),
      new Promise((r) => setTimeout(r, 300)),
    ]);
    await frame.bridge.close().catch(() => undefined);
  }

  private async frameFor(uri: string): Promise<Frame> {
    if (this.frame?.uri === uri) return this.frame;
    if (!this.opening) {
      this.opening = this.open(uri).finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async open(uri: string): Promise<Frame> {
    await this.close();
    const { contents } = await this.client.readResource({ uri });
    const first = contents[0];
    const html = first && 'text' in first ? first.text : '';

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.title = 'Plan check';
    this.container.replaceChildren(iframe);
    const target = iframe.contentWindow;
    if (!target) throw new Error('The view frame has no window');

    const box = this.container.getBoundingClientRect();
    const bridge = new AppBridge(
      null,
      HOST,
      { serverTools: {}, serverResources: {}, updateModelContext: { text: {} } },
      {
        hostContext: {
          theme: 'dark',
          platform: 'web',
          displayMode: 'inline',
          availableDisplayModes: ['inline'],
          containerDimensions: { width: Math.round(box.width), height: Math.round(box.height) },
        },
      },
    );
    bridge.oncalltool = async (params) => {
      const result = (await this.client.callTool(params)) as CallToolResult;
      this.events.onViewCall({ name: params.name, arguments: params.arguments ?? {}, result });
      return result;
    };
    bridge.onreadresource = (params) => this.client.readResource(params);
    bridge.onlistresources = (params) => this.client.listResources(params);
    bridge.onupdatemodelcontext = async (params) => {
      const text = (params.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join(' ')
        .trim();
      if (text) this.events.onModelContext(text);
      return {};
    };
    const ready = new Promise<void>((resolve) => {
      bridge.oninitialized = () => resolve();
    });
    // Listen before the view loads, so its first message isn't missed.
    await bridge.connect(new PostMessageTransport(target, target));
    iframe.srcdoc = withPolicy(html);
    this.frame = { uri, bridge, ready };
    return this.frame;
  }
}
