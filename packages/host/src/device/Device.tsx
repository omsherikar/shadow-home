'use client';

// First, before any module that builds a zod schema.
import './no-eval.ts';
import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { DemoStep } from '../demo/steps.ts';
import { type LiveHome, parseLiveHome } from '../house/looks.ts';
import { ScreenHost } from '../screen/ScreenHost.ts';
import { Stage } from '../stage/Stage.tsx';
import { type Chip, chipFor } from '../stage/stage.ts';
import { fitHistory, MAX_TEXT, spokenText } from '../turn/bounds.ts';
import type { Names, Remembered, ToolCall, TurnResponse } from '../turn/types.ts';
import { HomeCard, LogCard, type LogState, RuleCard, type RuleState } from './cards.tsx';
import { canListen, listenOnce, speak, stopSpeaking } from './voice.ts';

const NAMES_META_KEY = 'shadow-home/names';
const TRANSCRIPT = 20;
const DEMO_PAUSE_MS = 900;

type Screen =
  | { kind: 'home' }
  | { kind: 'view' }
  | { kind: 'log'; log: LogState }
  | { kind: 'rule'; rule: RuleState };

interface Line {
  who: 'you' | 'alexa';
  text: string;
}

export interface DeviceProps {
  suggestions: string[];
  /** The demo's lines, when the host runs in demo mode. */
  demo: DemoStep[] | null;
  /** Don't speak out loud (browser tests). */
  silent: boolean;
}

/**
 * A simulated Echo Show: one screen, a caption of what was said, a mic and a typed line.
 * Results with a view go to the view; the home, the activity log and new house rules the host
 * draws itself.
 */
export function Device({ suggestions, demo, silent }: DeviceProps) {
  const [client, setClient] = useState<Client | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [home, setHome] = useState<LiveHome | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [chip, setChip] = useState<Chip | null>(null);
  const [homeBroken, setHomeBroken] = useState(false);
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState<Line[]>([]);
  const [demoState, setDemoState] = useState<'idle' | 'playing' | 'finished'>('idle');
  // Known only in the browser; deciding after the first render keeps the server's HTML the same.
  const [micAvailable, setMicAvailable] = useState(false);
  const viewBox = useRef<HTMLDivElement>(null);
  const host = useRef<ScreenHost | null>(null);
  const history = useRef<Remembered[]>([]);
  const names = useRef<Names | undefined>(undefined);
  const screenNote = useRef<string | undefined>(undefined);
  const working = useRef(false);
  const mic = useRef<{ stop(): void } | null>(null);

  // Kept within what the turn route accepts, so one large result can't refuse every later turn.
  const note = useCallback((entry: Remembered) => {
    history.current = fitHistory([...history.current.slice(-40), entry]);
  }, []);

  const line = useCallback((who: Line['who'], text: string) => {
    setTranscript((t) => [...t.slice(1 - TRANSCRIPT), { who, text }]);
  }, []);

  const remember = useCallback(
    (call: ToolCall, by?: 'screen') => {
      const sc = call.result.structuredContent as Record<string, unknown> | undefined;
      note({
        name: call.name,
        arguments: call.arguments,
        ...(sc ? { structuredContent: sc } : {}),
        ...(by ? { by } : {}),
      });
      const fresh = call.result._meta?.[NAMES_META_KEY] as Names | undefined;
      if (fresh) names.current = fresh;
      const verdict = chipFor(call.name, sc);
      if (verdict) setChip(verdict);
    },
    [note],
  );

  // The home's state is checked, not trusted: if it isn't what the page expects, the device keeps
  // the last good one and the house steps aside rather than draw something wrong.
  const refreshHome = useCallback(async (c: Client) => {
    const r = await c.callTool({ name: 'get_home_state', arguments: {} });
    const parsed = parseLiveHome(r.structuredContent);
    setHomeBroken(parsed === null);
    if (parsed) {
      setHome(parsed);
    }
  }, []);

  const reply = useCallback(
    async (text: string) => {
      setSaid(text);
      line('alexa', text);
      note({ name: 'said', arguments: { text } });
      if (!silent) await speak(text);
    },
    [line, note, silent],
  );

  useEffect(() => setMicAvailable(canListen()), []);

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
        remember(call, 'screen');
        void refreshHome(client);
      },
      onModelContext: (text, structured) => {
        screenNote.current = text;
        // A tap that changed nothing (Cancel, OK) closes the question on screen.
        if (structured?.closed === true) note({ name: 'closed', arguments: {} });
        // Say what the tap ended on, once: not each call it made on the way there.
        if (typeof structured?.say === 'string') void reply(structured.say);
      },
    });
    host.current = screenHost;
    return () => {
      host.current = null;
      void screenHost.close();
    };
  }, [client, note, remember, refreshHome, reply]);

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
    const last = calls.at(-1);
    const sc = last?.result.structuredContent as unknown;
    // A failed call has nothing to draw; the reply says what went wrong.
    if (!sc || last?.result.isError) return;
    if (last?.name === 'get_activity_log') setScreen({ kind: 'log', log: sc as LogState });
    if (last?.name === 'add_house_rule') setScreen({ kind: 'rule', rule: sc as RuleState });
  }, []);

  /**
   * One turn: what was said goes to the assistant; its reply is shown, then spoken. Saying
   * something stops the device mid-sentence. While a turn is in flight the controls are off.
   */
  const say = useCallback(
    async (text: string) => {
      const words = spokenText(text);
      if (!words) return;
      stopSpeaking();
      if (working.current) return;
      working.current = true;
      setHeard(words);
      setSaid('');
      line('you', words);
      setBusy(true);
      let answer: string;
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
        // What was said goes in before what it led to: a turn with no calls ("no") closes the question.
        note({ name: 'heard', arguments: { text: words } });
        for (const call of turn.calls) remember(call);
        await show(turn.calls);
        if (client) await refreshHome(client);
        answer = turn.say;
      } catch (e) {
        note({ name: 'heard', arguments: { text: words } });
        answer = `Sorry, something went wrong: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        working.current = false;
        setBusy(false);
      }
      await reply(answer);
    },
    [client, line, note, refreshHome, remember, reply, show],
  );

  const toggleMic = useCallback(async () => {
    if (mic.current) {
      mic.current.stop();
      return;
    }
    stopSpeaking();
    setListening(true);
    setHeard('');
    const session = listenOnce((words) => setHeard(words));
    mic.current = session;
    try {
      const words = await session.result;
      mic.current = null;
      setListening(false);
      if (words) await say(words);
    } catch (e) {
      mic.current = null;
      setListening(false);
      setSaid(`I couldn't hear that: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [say]);

  /** The whole demo, start to finish: a fresh home, then every line in order. */
  const playDemo = useCallback(async () => {
    if (!demo || demoState === 'playing' || working.current) return;
    stopSpeaking();
    setDemoState('playing');
    const res = await fetch('/api/demo', { method: 'POST' });
    if (!res.ok) {
      setSaid('The demo controls are off on the server.');
      setDemoState('idle');
      return;
    }
    history.current = [];
    screenNote.current = undefined;
    setTranscript([]);
    setChip(null);
    setScreen({ kind: 'home' });
    if (client) await refreshHome(client);
    for (const step of demo) {
      await say(step.line);
      await new Promise((r) => setTimeout(r, DEMO_PAUSE_MS));
    }
    setDemoState('finished');
  }, [client, demo, demoState, refreshHome, say]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void say(draft);
    setDraft('');
  };

  const ready = client !== null && demoState !== 'playing';
  return (
    <Stage
      home={home}
      heard={heard}
      said={said}
      busy={busy}
      chip={chip}
      homeBroken={homeBroken}
      device={
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
              {screen.kind === 'rule' ? <RuleCard rule={screen.rule} /> : null}
            </div>
            <div className={busy ? 'caption thinking' : 'caption'}>
              {heard ? <p className="heard">“{heard}”</p> : null}
              {said ? <p className="said">{said}</p> : null}
            </div>
            <div className={busy || listening ? 'lightbar on' : 'lightbar'} aria-hidden="true" />
          </div>
        </div>
      }
      controls={
        <>
          <form className="voice" onSubmit={submit}>
            {micAvailable ? (
              <button
                type="button"
                className={listening ? 'mic on' : 'mic'}
                aria-pressed={listening}
                disabled={!ready || busy}
                onClick={() => void toggleMic()}
              >
                {listening ? 'Listening…' : 'Talk'}
              </button>
            ) : null}
            <input
              aria-label="Say something"
              placeholder="Type what you'd say to Alexa"
              maxLength={MAX_TEXT}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!ready}
            />
            <button type="submit" disabled={!ready || busy || !draft.trim()}>
              Say it
            </button>
          </form>
          <div className="suggestions">
            {demo ? (
              <button
                type="button"
                className="play"
                disabled={!client || busy || demoState === 'playing'}
                onClick={() => void playDemo()}
              >
                {demoState === 'playing' ? 'Playing the demo…' : 'Play the demo'}
              </button>
            ) : null}
            {suggestions.map((s) => (
              <button key={s} type="button" disabled={!ready || busy} onClick={() => void say(s)}>
                {s}
              </button>
            ))}
            {screen.kind !== 'home' ? (
              <button type="button" onClick={() => setScreen({ kind: 'home' })}>
                Home screen
              </button>
            ) : null}
          </div>
          {demoState === 'finished' ? <p className="demo-done">Demo finished.</p> : null}
          {transcript.length > 0 ? (
            <ol className="transcript" aria-label="Conversation">
              {transcript.map((l, i) => (
                // Lines are only ever appended, so the position is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
                <li key={i} className={`line ${l.who}`}>
                  <span className="who">{l.who === 'you' ? 'You' : 'Alexa'}</span> {l.text}
                </li>
              ))}
            </ol>
          ) : null}
        </>
      }
    />
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
