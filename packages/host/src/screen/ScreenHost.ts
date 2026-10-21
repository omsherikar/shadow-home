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
  onModelContext(text: string, structured?: Record<string, unknown>): void;
}

const HOST = { name: 'shadow-home-echo', version: '0.1.0' };

/**
 * What a view may do inside its frame: run its own inline script and styles, and nothing else.
 * No fetches, forms or other origins; it reaches the server only through the bridge.
 */
export const VIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/**
 * The view's HTML behind the policy. The meta goes before everything, not into the view's own
 * <head>, so nothing in the view's HTML (a comment, a <header>, an early script) can come first:
 * the parser opens the head for it, and a srcdoc document is never in quirks mode without a doctype.
 */
export function withPolicy(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">${html}`;
}

interface Frame {
  uri: string;
  bridge: AppBridge;
  ready: Promise<void>;
}

/** The longest the screen waits to hear that its view has drawn a result. */
const DRAW_WAIT_MS = 1500;

/**
 * The screen's one MCP App frame. A result for the view already on screen goes to that view;
 * a different view replaces it. Each view runs in an iframe sandboxed without same-origin, so
 * it has an opaque origin of its own and can't touch the page, its storage or the network.
 */
export class ScreenHost {
  private frame: Frame | undefined;
  private opening: Promise<Frame> | undefined;
  private drawing: { promise: Promise<void>; finish(): void } | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly client: Client,
    private readonly events: ScreenEvents,
  ) {}

  async show(shown: Shown): Promise<void> {
    const frame = await this.frameFor(shown.resourceUri);
    await frame.ready;
    await frame.bridge.sendToolInput({ arguments: shown.arguments });
    this.expectDrawing();
    await frame.bridge.sendToolResult(shown.result);
  }

  /**
   * Settles once the view has drawn the last result it was sent (it reports its size when it has),
   * or after DRAW_WAIT_MS if it doesn't say; undefined when nothing is waiting to be drawn.
   */
  drawn(): Promise<void> | undefined {
    return this.drawing?.promise;
  }

  private expectDrawing(): void {
    if (this.drawing) return;
    let settle = () => {};
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => this.finishDrawing(), DRAW_WAIT_MS);
    this.drawing = {
      promise,
      finish: () => {
        clearTimeout(timer);
        settle();
      },
    };
  }

  private finishDrawing(): void {
    const drawing = this.drawing;
    this.drawing = undefined;
    drawing?.finish();
  }

  async close(): Promise<void> {
    this.finishDrawing();
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
    // Set before the frame is in the page, so its only expected load is this document. A second
    // load means the view navigated itself; whatever loaded then must not inherit the bridge.
    iframe.srcdoc = withPolicy(html);
    let loads = 0;
    iframe.addEventListener('load', () => {
      loads += 1;
      if (loads > 1 && this.frame?.bridge === bridge) void this.close();
    });
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
      // The view draws what comes back.
      this.expectDrawing();
      this.events.onViewCall({ name: params.name, arguments: params.arguments ?? {}, result });
      return result;
    };
    // The view reports its size once it has drawn a result; its size itself isn't used, since the
    // frame always fills the screen.
    bridge.onsizechange = () => {
      if (this.frame?.bridge === bridge) this.finishDrawing();
    };
    bridge.onreadresource = (params) => this.client.readResource(params);
    bridge.onlistresources = (params) => this.client.listResources(params);
    bridge.onupdatemodelcontext = async (params) => {
      const text = (params.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join(' ')
        .trim();
      if (text || params.structuredContent) {
        this.events.onModelContext(text, params.structuredContent);
      }
      return {};
    };
    const ready = new Promise<void>((resolve) => {
      bridge.oninitialized = () => resolve();
    });
    // The document loads in a later task; connecting now listens before its first message.
    this.frame = { uri, bridge, ready };
    await bridge.connect(new PostMessageTransport(target, target));
    return this.frame;
  }
}
