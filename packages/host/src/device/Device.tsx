'use client';

// First, before any module that builds a zod schema.
import './no-eval.ts';
import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Activity, Chat } from '../chat/Chat.tsx';
import { ask as asked, type Message, replace, withEvent } from '../chat/conversation.ts';
import { streamTurn } from '../chat/stream.ts';
import type { DemoStep } from '../demo/steps.ts';
import { type LiveHome, parseLiveHome } from '../house/looks.ts';
import {
  carriesPreview,
  guardFrom,
  runsFrom,
  SHOW_TIMING,
  sampleDay,
  showLength,
} from '../house/playback.ts';
import { ScreenHost } from '../screen/ScreenHost.ts';
import type { HouseRequest } from '../stage/HousePanel.tsx';
import { Stage } from '../stage/Stage.tsx';
import { fitHistory, spokenText } from '../turn/bounds.ts';
import type { Names, Remembered, ToolCall, TurnRequest } from '../turn/types.ts';
import { HomeCard, LogCard, type LogState, RuleCard, type RuleState } from './cards.tsx';
import { canListen, listenOnce, speak, stopSpeaking } from './voice.ts';

const NAMES_META_KEY = 'shadow-home/names';
const DEMO_PAUSE_MS = 900;

type Screen =
  | { kind: 'home' }
  | { kind: 'view' }
  | { kind: 'log'; log: LogState }
  | { kind: 'rule'; rule: RuleState };

export interface DeviceProps {
  /** What a first-time visitor can tap to start: the demo's own requests. */
  suggestions: string[];
  /** The demo's lines, when the host runs in demo mode. */
  demo: DemoStep[] | null;
  /** Don't speak out loud (browser tests). */
  silent: boolean;
}

/**
 * A simulated Echo Show and a chat beside it. What's said goes to the assistant; the screen draws
 * each result, the chat shows her answer, and then she says it. Results with a view go to the view;
 * the home, the activity log and new house rules the host draws itself.
 */
export function Device({ suggestions, demo, silent }: DeviceProps) {
  const [client, setClient] = useState<Client | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [home, setHome] = useState<LiveHome | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [houseRequest, setHouseRequest] = useState<HouseRequest | null>(null);
  const [homeBroken, setHomeBroken] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activity, setActivity] = useState<Activity>('idle');
  const [heard, setHeard] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [demoState, setDemoState] = useState<'idle' | 'playing' | 'finished'>('idle');
  // Known only in the browser; deciding after the first render keeps the server's HTML the same.
  const [micAvailable, setMicAvailable] = useState(false);
  const viewBox = useRef<HTMLDivElement>(null);
  const host = useRef<ScreenHost | null>(null);
  const history = useRef<Remembered[]>([]);
  const names = useRef<Names | undefined>(undefined);
  const screenNote = useRef<string | undefined>(undefined);
  const working = useRef(false);
  const turnSeq = useRef(0);
  const mic = useRef<{ stop(): void } | null>(null);
  const homeNow = useRef<LiveHome | null>(null);
  const requests = useRef(0);
  const askedHouse = useRef(false);
  const showEnds = useRef(0);

  // During a turn the house waits for the screen: what it's asked to play goes to it once the plan
  // view has the result, so drawing the house never holds up the device.
  const holding = useRef(false);
  const held = useRef<Omit<HouseRequest, 'id'> | null>(null);

  /**
   * Ask the house to play something, or with `null` to show the home as it is. It waits for the
   * screen to draw what it was last sent, so the verdict is up before the house draws anything.
   */
  const ask = useCallback((play: Omit<HouseRequest, 'id'>) => {
    askedHouse.current = true;
    if (holding.current) {
      held.current = play;
      return;
    }
    requests.current += 1;
    const id = requests.current;
    const apply = () => {
      // A later request has taken its place.
      if (id !== requests.current) return;
      showEnds.current = play.play ? performance.now() + showLength(play.play, SHOW_TIMING) : 0;
      setHouseRequest({ id, ...play });
    };
    const drawing = host.current?.drawn();
    if (drawing) void drawing.then(apply);
    else apply();
  }, []);

  /** Pass on what the house was asked during the turn. */
  const release = useCallback(() => {
    holding.current = false;
    const play = held.current;
    held.current = null;
    if (play) ask(play);
  }, [ask]);

  // Kept within what the turn route accepts, so one large result can't refuse every later turn.
  const note = useCallback((entry: Remembered) => {
    history.current = fitHistory([...history.current.slice(-40), entry]);
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
      // What the house plays: a checked plan (and its fixes), a new rule's sample day, or, once a
      // plan is committed, the home as it now is. Both are read with zod, and what the house
      // can't read plays nothing; the house is never a reason for a turn to fail, so anything
      // else that goes wrong here leaves it showing the home as it is.
      try {
        const runs = runsFrom(call.name, sc, call.result._meta);
        const guard = guardFrom(call.name, call.arguments, sc);
        if (runs.length > 0) ask({ play: runs });
        else if (guard && homeNow.current) {
          ask({ play: [sampleDay(guard, homeNow.current.now)], guard });
        } else if (
          (call.name === 'commit_plan' && sc?.status === 'committed') ||
          carriesPreview(call.name, sc)
        ) {
          ask({ play: null });
        }
      } catch (e) {
        // Silent in production; while developing, a fault in the house's own code should show.
        if (process.env.NODE_ENV !== 'production') console.error('The house could not play:', e);
        ask({ play: null });
      }
    },
    [note, ask],
  );

  // The home's state is checked, not trusted: if it isn't what the page expects, the device keeps
  // the last good one and the house steps aside rather than draw something wrong.
  const refreshHome = useCallback(async (c: Client) => {
    const r = await c.callTool({ name: 'get_home_state', arguments: {} });
    const parsed = parseLiveHome(r.structuredContent);
    setHomeBroken(parsed === null);
    if (parsed) {
      homeNow.current = parsed;
      setHome(parsed);
    }
  }, []);

  /** Say it out loud, showing that she's speaking; anything new cuts it short. */
  const voice = useCallback(
    async (text: string) => {
      if (silent || !text) return;
      setActivity('speaking');
      await speak(text);
      setActivity((a) => (a === 'speaking' ? 'idle' : a));
    },
    [silent],
  );

  useEffect(() => setMicAvailable(canListen()), []);

  const busy = activity === 'thinking' || activity === 'working' || activity === 'answering';

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
        // A tap that changed nothing (Cancel, OK) closes the question on screen, and the house goes
        // back to the home as it is.
        if (structured?.closed === true) {
          note({ name: 'closed', arguments: {} });
          ask({ play: null });
        }
        // Say what the tap ended on, once: not each call it made on the way there.
        if (typeof structured?.say === 'string') {
          note({ name: 'said', arguments: { text: structured.say } });
          void voice(structured.say);
        }
      },
    });
    host.current = screenHost;
    return () => {
      host.current = null;
      void screenHost.close();
    };
  }, [client, note, remember, refreshHome, ask, voice]);

  /** Put a call's result on screen: its view, or the host's own card for the log and new rules. */
  const show = useCallback(async (call: ToolCall) => {
    if (call.resourceUri && host.current) {
      setScreen({ kind: 'view' });
      await host.current.show({
        resourceUri: call.resourceUri,
        arguments: call.arguments,
        result: call.result as CallToolResult,
      });
      return true;
    }
    const sc = call.result.structuredContent as unknown;
    // A failed call has nothing to draw; the answer says what went wrong.
    if (!sc || call.result.isError) return false;
    if (call.name === 'get_activity_log') {
      setScreen({ kind: 'log', log: sc as LogState });
      return true;
    }
    if (call.name === 'add_house_rule') {
      setScreen({ kind: 'rule', rule: sc as RuleState });
      return true;
    }
    return false;
  }, []);

  /**
   * One turn: the request goes to the assistant. Each call it made goes on screen (the house plays
   * once the screen has drawn it), and her answer shows in the chat; then she says it. Saying
   * something stops the device mid-sentence. `said` is what the chat shows as the person's line
   * (what they tapped, when it differs from the words sent).
   */
  const send = useCallback(
    async (request: TurnRequest, said: string) => {
      stopSpeaking();
      if (working.current) return;
      working.current = true;
      turnSeq.current += 1;
      const seq = turnSeq.current;
      const id = `t${seq}`;
      const alexa = `${id}-alexa`;
      setMessages((m) => asked(m, id, said, request));
      setNotice(null);
      setActivity('thinking');
      // The screen's note goes with this request.
      screenNote.current = undefined;
      askedHouse.current = false;
      holding.current = true;
      // What was said goes in before what it led to, once it has led to something. A turn that
      // fails before then leaves the conversation as it was, and a question still open stays open.
      let heard = false;
      const hear = () => {
        if (heard) return;
        heard = true;
        note({ name: 'heard', arguments: { text: request.text } });
      };
      let answer: string | null = null;
      let failure: string | null = null;
      const take = async (call: ToolCall) => {
        hear();
        remember(call);
        if (await show(call)) {
          // The screen has it: the house may play what it was asked, then waits for the next.
          release();
          holding.current = true;
        }
      };
      try {
        for await (const event of streamTurn(request)) {
          // How the turn ends: its calls and answer, or what went wrong.
          if (event.type === 'done') {
            for (const call of event.turn.calls) await take(call);
            hear();
            answer = event.turn.say;
          }
          if (event.type === 'error') failure = event.message;
          if (event.type === 'done' || event.type === 'error') {
            setMessages((m) =>
              replace(m, alexa, (msg) => withEvent(msg, event, Date.now(), names.current)),
            );
          }
        }
      } catch (e) {
        if (process.env.NODE_ENV !== 'production') console.error('The turn failed:', e);
        failure = 'Something went wrong on my side. Try again.';
        const event = { type: 'error' as const, message: failure, retryable: true };
        setMessages((m) => replace(m, alexa, (msg) => withEvent(msg, event, Date.now())));
      } finally {
        // A turn that played nothing ("no", the activity log) leaves the house showing the home.
        if (!askedHouse.current) ask({ play: null });
        release();
        working.current = false;
        setActivity('idle');
      }
      // Nothing came of it: the screen's note waits for whatever is said next.
      if (!heard && request.screen && screenNote.current === undefined) {
        screenNote.current = request.screen;
      }
      if (answer !== null) note({ name: 'said', arguments: { text: answer } });
      if (client) await refreshHome(client).catch(() => undefined);
      if (answer !== null) await voice(answer);
      else if (failure) await voice(failure);
    },
    [client, note, refreshHome, remember, show, ask, release, voice],
  );

  /** A turn for words the person said, typed or tapped: `label` is what they tapped. */
  const say = useCallback(
    async (text: string, label?: string) => {
      const words = spokenText(text);
      if (!words) return;
      const request: TurnRequest = {
        text: words,
        history: history.current,
        ...(names.current ? { names: names.current } : {}),
        ...(screenNote.current ? { screen: screenNote.current } : {}),
      };
      await send(request, label ?? words);
    },
    [send],
  );

  const toggleMic = useCallback(async () => {
    if (mic.current) {
      mic.current.stop();
      return;
    }
    stopSpeaking();
    setActivity('listening');
    setHeard('');
    setNotice(null);
    const session = listenOnce((words) => setHeard(words));
    mic.current = session;
    try {
      const words = await session.result;
      mic.current = null;
      setActivity('idle');
      setHeard('');
      if (words) await say(words);
    } catch (e) {
      mic.current = null;
      setActivity('idle');
      setNotice(`I couldn't hear that: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [say]);

  /** The whole demo, start to finish: a fresh home, then every line in order. */
  const playDemo = useCallback(async () => {
    if (!demo || demoState === 'playing' || working.current) return;
    stopSpeaking();
    setDemoState('playing');
    const res = await fetch('/api/demo', { method: 'POST' });
    if (!res.ok) {
      setNotice("The demo isn't available on this server.");
      setDemoState('idle');
      return;
    }
    history.current = [];
    screenNote.current = undefined;
    setMessages([]);
    setNotice(null);
    ask({ play: null });
    setScreen({ kind: 'home' });
    if (client) await refreshHome(client);
    for (const step of demo) {
      await say(step.line);
      // Out loud (the recorded demo), each plan finishes playing in the house before the next line.
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const left = silent || still ? 0 : showEnds.current - performance.now();
      await new Promise((r) => setTimeout(r, DEMO_PAUSE_MS + Math.max(0, left)));
    }
    setDemoState('finished');
    setNotice('Demo finished.');
  }, [client, demo, demoState, refreshHome, say, ask, silent]);

  const ready = client !== null && demoState !== 'playing';
  return (
    <Stage
      home={home}
      request={houseRequest}
      homeBroken={homeBroken}
      device={
        <div className="device">
          <div className="camera" aria-hidden="true" />
          <div className="screen">
            <div className="status">
              {screen.kind === 'home' ? (
                <span>Shadow Home</span>
              ) : (
                <button
                  type="button"
                  className="home-button"
                  onClick={() => setScreen({ kind: 'home' })}
                >
                  Home screen
                </button>
              )}
              <span>{home ? homeClock(home.now) : ''}</span>
            </div>
            <div className="content">
              <div ref={viewBox} className="view" hidden={screen.kind !== 'view'} />
              {screen.kind === 'home' ? <HomeCard home={home} problem={problem} /> : null}
              {screen.kind === 'log' ? <LogCard log={screen.log} names={names.current} /> : null}
              {screen.kind === 'rule' ? <RuleCard rule={screen.rule} /> : null}
            </div>
            <div
              className={busy || activity === 'listening' ? 'lightbar on' : 'lightbar'}
              aria-hidden="true"
            />
          </div>
        </div>
      }
      chat={
        <Chat
          messages={messages}
          placeholder="Ask Alexa to change something"
          starters={suggestions.map((s) => ({ label: s, says: s }))}
          activity={activity}
          heard={heard}
          ready={ready}
          micAvailable={micAvailable}
          notice={notice}
          onSend={(says, label) => void say(says, label)}
          onMic={() => void toggleMic()}
          menu={
            <details className="menu">
              <summary aria-label="More">
                <span aria-hidden="true">•••</span>
              </summary>
              <div className="menu-items">
                {demo ? (
                  <button
                    type="button"
                    disabled={!client || busy || demoState === 'playing'}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      void playDemo();
                    }}
                  >
                    {demoState === 'playing' ? 'Playing the demo…' : 'Play the demo'}
                  </button>
                ) : null}
              </div>
            </details>
          }
        />
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
