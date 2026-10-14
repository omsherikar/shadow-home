'use client';

import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ScreenHost } from '../screen/ScreenHost.ts';
import { spokenFrom } from '../turn/scripted.ts';
import type { Names, Remembered, ToolCall, TurnResponse } from '../turn/types.ts';
import { HomeCard, type HomeState, LogCard, type LogState } from './cards.tsx';

const NAMES_META_KEY = 'shadow-home/names';

type Screen = { kind: 'home' } | { kind: 'view' } | { kind: 'log'; log: LogState };

/**
 * A simulated Echo Show: one screen, a caption of what was said, and a way to say something.
 * Results with a view go to the view; the home card and the activity log the host draws itself.
 */
export function Device({ suggestions }: { suggestions: string[] }) {
  const [client, setClient] = useState<Client | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [home, setHome] = useState<HomeState | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const viewBox = useRef<HTMLDivElement>(null);
  const host = useRef<ScreenHost | null>(null);
  const history = useRef<Remembered[]>([]);
  const names = useRef<Names | undefined>(undefined);
  const screenNote = useRef<string | undefined>(undefined);

  const remember = useCallback((call: ToolCall) => {
    const sc = call.result.structuredContent as Record<string, unknown> | undefined;
    history.current = [
      ...history.current.slice(-30),
      { name: call.name, arguments: call.arguments, ...(sc ? { structuredContent: sc } : {}) },
    ];
    const fresh = call.result._meta?.[NAMES_META_KEY] as Names | undefined;
    if (fresh) names.current = fresh;
  }, []);

  const refreshHome = useCallback(async (c: Client) => {
    const r = await c.callTool({ name: 'get_home_state', arguments: {} });
    setHome((r.structuredContent as HomeState | undefined) ?? null);
  }, []);

  useEffect(() => {
    let live = true;
    const c = new Client({ name: 'shadow-home-echo', version: '0.1.0' });
    c.connect(new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin)))
      .then(async () => {
        if (!live) return;
        setClient(c);
        await refreshHome(c);
      })
      .catch((e: unknown) => setProblem(`Can't reach the Shadow Home server: ${String(e)}`));
    return () => {
      live = false;
      void c.close();
    };
  }, [refreshHome]);

  useEffect(() => {
    if (!client || !viewBox.current) return;
    const screenHost = new ScreenHost(viewBox.current, client, {
      onViewCall: (call) => {
        remember(call);
        setSaid(
          spokenFrom(call.result.structuredContent as Record<string, unknown>, call.result.content),
        );
        void refreshHome(client);
      },
      onModelContext: (text) => {
        screenNote.current = text;
      },
    });
    host.current = screenHost;
    return () => {
      host.current = null;
      void screenHost.close();
    };
  }, [client, remember, refreshHome]);

  const show = useCallback(async (calls: ToolCall[]) => {
    const withView = calls.findLast((c) => c.resourceUri);
    if (withView?.resourceUri && host.current) {
      setScreen({ kind: 'view' });
      await host.current.show({
        resourceUri: withView.resourceUri,
        arguments: withView.arguments,
        result: withView.result as CallToolResult,
      });
      return;
    }
    const log = calls.findLast((c) => c.name === 'get_activity_log');
    if (log) setScreen({ kind: 'log', log: log.result.structuredContent as unknown as LogState });
  }, []);

  const say = useCallback(
    async (text: string) => {
      const words = text.trim();
      if (!words || busy) return;
      setHeard(words);
      setSaid('');
      setBusy(true);
      try {
        const res = await fetch('/api/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: words,
            history: history.current,
            ...(names.current ? { names: names.current } : {}),
            ...(screenNote.current ? { screen: screenNote.current } : {}),
          }),
        });
        if (!res.ok) throw new Error(`turn failed (${res.status})`);
        const turn = (await res.json()) as TurnResponse;
        screenNote.current = undefined;
        for (const call of turn.calls) remember(call);
        setSaid(turn.say);
        await show(turn.calls);
        if (client) await refreshHome(client);
      } catch (e) {
        setSaid(`Sorry, something went wrong: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, client, refreshHome, remember, show],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void say(draft);
    setDraft('');
  };

  return (
    <div className="room">
      <div className="device">
        <div className="camera" aria-hidden="true" />
        <div className="screen">
          <div className="status">
            <span>Shadow Home</span>
            <span>{home ? homeClock(home.now) : ''}</span>
          </div>
          <div className="content">
            <div ref={viewBox} className="view" hidden={screen.kind !== 'view'} />
            {screen.kind === 'home' ? <HomeCard home={home} problem={problem} /> : null}
            {screen.kind === 'log' ? <LogCard log={screen.log} names={names.current} /> : null}
          </div>
          <div className={busy ? 'caption thinking' : 'caption'}>
            {heard ? <p className="heard">“{heard}”</p> : null}
            {said ? <p className="said">{said}</p> : null}
          </div>
          <div className={busy ? 'lightbar on' : 'lightbar'} aria-hidden="true" />
        </div>
      </div>

      <form className="voice" onSubmit={submit}>
        <input
          aria-label="Say something"
          placeholder="Type what you'd say to Alexa"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!client}
        />
        <button type="submit" disabled={!client || busy || !draft.trim()}>
          Say it
        </button>
      </form>
      <div className="suggestions">
        {suggestions.map((s) => (
          <button key={s} type="button" disabled={!client || busy} onClick={() => void say(s)}>
            {s}
          </button>
        ))}
        {screen.kind !== 'home' ? (
          <button type="button" onClick={() => setScreen({ kind: 'home' })}>
            Home screen
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** "Fri 5:45 PM" from the home's ISO time, read as the home's wall clock. */
export function homeClock(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  ];
  return `${day} ${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
