'use client';

// First, before any module that builds a zod schema.
import './no-eval.ts';
import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { shownActivity, type TurnActivity } from '../chat/activity.ts';
import { Chat } from '../chat/Chat.tsx';
import {
  ask as asked,
  awaitsAnswer,
  type FollowUp,
  followUpsFor,
  forgetConversation,
  type Glance,
  glanceFor,
  loadConversation,
  type Message,
  replace,
  saveConversation,
  splitFollowUps,
  stopped,
  withEvent,
} from '../chat/conversation.ts';
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
import { NARROW, Stage, useMedia } from '../stage/Stage.tsx';
import { browserStorage } from '../stage/stage.ts';
import { fitHistory, spokenText } from '../turn/bounds.ts';
import type { Names, Remembered, ToolCall, TurnRequest } from '../turn/types.ts';
import { useHandsFree } from '../voice/useHandsFree.ts';
import { HomeCard, LogCard, type LogState, RuleCard, type RuleState } from './cards.tsx';
import { Strip } from './Strip.tsx';
import { canListen, listenOnce, speak, speech, stopSpeaking } from './voice.ts';

const NAMES_META_KEY = 'shadow-home/names';

/** A message ID's last part: the time, so IDs stay unique across reloads, as the count restarts. */
const stamp = () => Date.now().toString(36);
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

/** What the browser's speech recognition said went wrong, in plain words. */
function micProblem(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return "I can't use your microphone. Allow it in your browser, or type instead.";
  }
  if (code === 'no-speech') return "I didn't hear anything. Tap the mic and try again.";
  if (code === 'audio-capture') return "I can't find a microphone. You can type instead.";
  return "I couldn't hear that. You can type instead.";
}

/**
 * A simulated Echo Show and a chat beside it. What's said goes to the assistant as a stream: her
 * words and steps show as they come, the screen draws each result as soon as its check is done, and
 * then she says the answer. Results with a view go to the view; the home, the activity log and new
 * house rules the host draws itself.
 */
export function Device({ suggestions, demo, silent }: DeviceProps) {
  const [client, setClient] = useState<Client | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [home, setHome] = useState<LiveHome | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  // A later turn set the plan on screen aside: its buttons no longer answer anything.
  const [stale, setStale] = useState(false);
  const [houseRequest, setHouseRequest] = useState<HouseRequest | null>(null);
  const [homeBroken, setHomeBroken] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  // What the screen shows, in brief, for the strip a phone shows in its place.
  const [glance, setGlance] = useState<Glance | null>(null);
  const narrow = useMedia(NARROW);
  // The mic and the turn; her voice says on its own when it speaks (speech.watch).
  const [activity, setActivity] = useState<TurnActivity>('idle');
  const [speaking, setSpeaking] = useState(false);
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
  const turn = useRef<AbortController | null>(null);
  const turnSeq = useRef(0);
  const taps = useRef(0);
  const mic = useRef<{ stop(): void } | null>(null);
  const homeNow = useRef<LiveHome | null>(null);
  const requests = useRef(0);
  const askedHouse = useRef(false);
  const showEnds = useRef(0);
  // Calls a tap on screen made, until the view says what the tap ended on.
  const tapped = useRef<ToolCall[]>([]);
  const restored = useRef(false);
  // Stop pressed while the demo plays: it ends after the line it's on.
  const demoStopped = useRef(false);
  // What hands-free heard asked goes through `say`, like anything typed (set once `say` exists).
  const sayHeard = useRef<(text: string) => void>(() => undefined);
  const handsFree = useHandsFree({ onRequest: (text) => sayHeard.current(text), silent });
  const { turnStarted, turnEnded, stopped: stoppedHandsFree } = handsFree;

  /**
   * Set the plan on screen aside, or bring it back. Set aside, it stays readable but acts on
   * nothing: the view is inert to the pointer and the keyboard, and any tool call it makes is
   * refused before it reaches the server.
   */
  const setAside = useCallback((on: boolean) => {
    setStale(on);
    host.current?.setAside(on);
  }, []);

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
      const brief = glanceFor(call);
      if (brief) setGlance(brief);
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

  /** Say a whole reply out loud (a tap's answer), unless the device is silent. */
  const voice = useCallback(
    async (text: string) => {
      if (silent || !text) return;
      await speak(text);
    },
    [silent],
  );

  // Speaking from the moment her first clip starts to when the last ends or she's stopped.
  useEffect(() => speech.watch(setSpeaking), []);

  useEffect(() => setMicAvailable(canListen()), []);

  // The conversation from before a reload, once, after the first render.
  useEffect(() => {
    const kept = loadConversation(browserStorage());
    history.current = kept.history;
    setMessages(kept.messages);
    restored.current = true;
  }, []);

  // Kept as it changes, between turns: once when a turn ends, not on every word as it streams.
  const busy = activity === 'thinking' || activity === 'working' || activity === 'answering';
  useEffect(() => {
    if (!restored.current || busy) return;
    saveConversation(browserStorage(), { messages, history: history.current });
  }, [messages, busy]);

  useEffect(() => {
    let live = true;
    const c = new Client({ name: 'shadow-home-echo', version: '0.1.0' });
    c.connect(new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin)))
      .then(async () => {
        if (!live) return;
        setClient(c);
        await refreshHome(c);
      })
      .catch(() => setProblem("Can't reach the Shadow Home server. Reload the page to try again."));
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
        tapped.current.push(call);
        void refreshHome(client);
      },
      onModelContext: (text, structured) => {
        screenNote.current = text;
        const calls = tapped.current;
        tapped.current = [];
        // A tap that changed nothing (Cancel, OK) closes the question on screen, and the house goes
        // back to the home as it is.
        if (structured?.closed === true) {
          note({ name: 'closed', arguments: {} });
          ask({ play: null });
        }
        // The tap shows in the chat as the person's answer, and what it ended on as Alexa's.
        taps.current += 1;
        const id = `tap${taps.current}-${stamp()}`;
        const label = typeof structured?.tapped === 'string' ? structured.tapped : null;
        const say = typeof structured?.say === 'string' ? structured.say : null;
        setMessages((m) => {
          let next = label ? [...m, { id: `${id}-you`, who: 'you' as const, text: label }] : m;
          if (say) {
            const answer: Message = { id: `${id}-alexa`, who: 'alexa', text: '', steps: [] };
            const done = withEvent(
              answer,
              { type: 'done', turn: { say, calls } },
              0,
              names.current,
            );
            next = [...next, done];
          }
          return next;
        });
        setFollowUps(followUpsFor(calls));
        if (say) {
          note({ name: 'said', arguments: { text: say } });
          void voice(say);
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
  const show = useCallback(
    async (call: ToolCall) => {
      if (call.resourceUri && host.current) {
        setScreen({ kind: 'view' });
        setAside(false);
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
    },
    [setAside],
  );

  /**
   * One turn: the request goes to the assistant, and what comes back shows as it happens. Each
   * finished call goes on screen at once (the house plays once the screen has drawn it); then
   * she says the answer. Saying something stops the device mid-sentence. `said` is what the chat
   * shows as the person's line (what they tapped, when it differs from the words sent).
   */
  const send = useCallback(
    async (request: TurnRequest, said: string) => {
      stopSpeaking();
      if (working.current) return;
      working.current = true;
      turnStarted();
      turnSeq.current += 1;
      const seq = turnSeq.current;
      const id = `t${seq}-${stamp()}`;
      const alexa = `${id}-alexa`;
      setMessages((m) => asked(m, id, said, request));
      setFollowUps([]);
      setNotice(null);
      setActivity('thinking');
      // The screen's note goes with this request (and with it again on a retry).
      screenNote.current = undefined;
      askedHouse.current = false;
      holding.current = true;
      const controller = new AbortController();
      turn.current = controller;
      // Stopped, or a newer turn started: nothing more from this one shows, counts or speaks.
      const gone = () => controller.signal.aborted || turnSeq.current !== seq;
      const calls: ToolCall[] = [];
      // What was said goes in before what it led to, once it has led to something. A turn that
      // fails or is stopped before then leaves the conversation as it was, so a retry is the same
      // request to the same conversation, and a question still open stays open.
      let heard = false;
      const hear = () => {
        if (heard) return;
        heard = true;
        note({ name: 'heard', arguments: { text: request.text } });
      };
      // What she's doing, from the stream: a step running, then writing, until it ends.
      const running = new Set<string>();
      let wrote = false;
      let drew = false;
      let answer: string | null = null;
      let failure: string | null = null;
      // Her voice, a sentence at a time: what streams is spoken as each sentence is finished.
      let spoken: Promise<boolean> | null = null;
      const take = async (call: ToolCall) => {
        if (gone()) return;
        hear();
        calls.push(call);
        remember(call);
        if (await show(call)) {
          drew = true;
          // The screen has it: the house may play what it was asked, then waits for the next.
          release();
          holding.current = true;
        }
      };
      try {
        for await (const event of streamTurn(request, { signal: controller.signal })) {
          if (gone()) break;
          if (event.type === 'call') await take(event.call);
          if (event.type === 'done') {
            // A server that doesn't stream sends every call here; one that does, the same calls.
            for (const call of event.turn.calls.slice(calls.length)) await take(call);
            if (!gone()) {
              hear();
              answer = event.turn.say;
            }
          }
          if (gone()) break;
          // Her voice follows the stream: a sentence at a time as the words come, nothing of what
          // came before a tool call, and in the end `say`, which is the truth.
          if (!silent) spoken = speech.follow(event) ?? spoken;
          if (event.type === 'error') failure = event.message;
          setMessages((m) =>
            replace(m, alexa, (msg) => withEvent(msg, event, Date.now(), names.current)),
          );
          if (event.type === 'step' && event.state === 'running') running.add(event.id);
          if (event.type === 'step' && event.state !== 'running') running.delete(event.id);
          if (event.type === 'text') wrote = true;
          setActivity(running.size > 0 ? 'working' : wrote ? 'answering' : 'thinking');
        }
      } catch (e) {
        if (process.env.NODE_ENV !== 'production') console.error('The turn failed:', e);
        if (!gone()) {
          failure = 'Something went wrong on my side. Try again.';
          const event = { type: 'error' as const, message: failure, retryable: true };
          setMessages((m) => replace(m, alexa, (msg) => withEvent(msg, event, Date.now())));
        }
      } finally {
        if (controller.signal.aborted) setMessages((m) => replace(m, alexa, stopped));
        // A turn that played nothing ("no", the activity log) leaves the house showing the home.
        if (!askedHouse.current) ask({ play: null });
        release();
        turn.current = null;
        working.current = false;
        setActivity('idle');
      }
      // Nothing came of it: the screen's note waits for whatever is said next.
      if (!heard && request.screen && screenNote.current === undefined) {
        screenNote.current = request.screen;
      }
      if (gone()) return;
      // What went wrong is said, not whatever streamed before it.
      if (answer === null && failure && !silent) spoken = speak(failure);
      // A plan still on screen from before a turn that led somewhere else is now set aside.
      if (heard && !drew) setAside(true);
      if (answer !== null) {
        setFollowUps(followUpsFor(calls));
        note({ name: 'said', arguments: { text: answer } });
      }
      if (client) await refreshHome(client).catch(() => undefined);
      if (gone()) return;
      // The demo, played out loud, waits for her to finish before its next line.
      const heardAloud = spoken ? await spoken : false;
      if (gone()) return;
      // Hands-free: after a question, listen for the answer without the wake word, but only if
      // the question was heard (not silent, not held back by the browser).
      turnEnded(answer !== null && awaitsAnswer(answer, calls) && heardAloud);
    },
    [
      client,
      note,
      refreshHome,
      remember,
      show,
      ask,
      release,
      setAside,
      silent,
      turnStarted,
      turnEnded,
    ],
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

  useEffect(() => {
    sayHeard.current = (text) => void say(text);
  }, [say]);

  /** Stop: the answer coming in (the server stops too), her voice, and the demo if it's playing. */
  const stop = useCallback(() => {
    demoStopped.current = true;
    turn.current?.abort();
    // A turn whose words are over but whose voice still plays ends here too: nothing more of it
    // counts (it would open a window for an answer to a question cut short).
    turnSeq.current += 1;
    stopSpeaking();
    stoppedHandsFree();
  }, [stoppedHandsFree]);

  /** Try a failed answer again: the same request, exactly, in place of the answer that failed. */
  const retry = useCallback(
    (m: Message) => {
      if (!m.request || working.current) return;
      const at = messages.indexOf(m);
      const you = messages[at - 1];
      setMessages((all) => all.filter((x) => x !== m && x !== you));
      void send(m.request, you?.who === 'you' ? you.text : m.request.text);
    },
    [messages, send],
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
      setNotice(micProblem(e));
    }
  }, [say]);

  /** Start afresh: no conversation, the home screen, the house as it is. */
  const forget = useCallback(() => {
    stop();
    history.current = [];
    screenNote.current = undefined;
    setMessages([]);
    setFollowUps([]);
    setGlance(null);
    setNotice(null);
    setAside(false);
    forgetConversation(browserStorage());
    ask({ play: null });
    setScreen({ kind: 'home' });
  }, [ask, stop, setAside]);

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
    forget();
    demoStopped.current = false;
    if (client) await refreshHome(client);
    for (const step of demo) {
      if (demoStopped.current) break;
      await say(step.line);
      // Out loud (the recorded demo), each plan finishes playing in the house before the next line.
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const left = silent || still ? 0 : showEnds.current - performance.now();
      await new Promise((r) => setTimeout(r, DEMO_PAUSE_MS + Math.max(0, left)));
    }
    setDemoState(demoStopped.current ? 'idle' : 'finished');
    setNotice(demoStopped.current ? 'Demo stopped.' : 'Demo finished.');
  }, [client, demo, demoState, refreshHome, say, forget, silent]);

  const ready = client !== null && demoState !== 'playing';
  const phone = splitFollowUps(followUps);
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
                  onClick={() => {
                    setScreen({ kind: 'home' });
                    setGlance(null);
                    setAside(false);
                  }}
                >
                  Home screen
                </button>
              )}
              <span>{home ? homeClock(home.now) : ''}</span>
            </div>
            <div className="content">
              <div
                ref={viewBox}
                className="view"
                hidden={screen.kind !== 'view'}
                inert={screen.kind === 'view' && stale}
              />
              {screen.kind === 'view' && stale ? (
                <div className="stale-cover">
                  <p>This plan was set aside. Ask again to act on it.</p>
                </div>
              ) : null}
              {screen.kind === 'home' ? <HomeCard home={home} problem={problem} /> : null}
              {screen.kind === 'log' ? <LogCard log={screen.log} names={names.current} /> : null}
              {screen.kind === 'rule' ? <RuleCard rule={screen.rule} /> : null}
            </div>
            <div
              className={busy || speaking || activity === 'listening' ? 'lightbar on' : 'lightbar'}
              aria-hidden="true"
            />
          </div>
        </div>
      }
      strip={(open) => (
        <Strip
          glance={screen.kind === 'home' ? null : glance}
          home={home}
          stale={stale && screen.kind === 'view'}
          answers={phone.answers}
          ready={ready && !busy}
          onOpen={open}
          onAnswer={(a) => void say(a.says, a.label)}
        />
      )}
      chat={
        <Chat
          messages={messages}
          followUps={narrow ? phone.rest : followUps}
          placeholder={narrow ? 'Ask Alexa' : 'Ask Alexa to change something'}
          starters={suggestions.map((s) => ({ label: s, says: s }))}
          activity={shownActivity(activity, speaking)}
          heard={heard}
          ready={ready}
          micAvailable={micAvailable}
          notice={notice}
          onSend={(says, label) => void say(says, label)}
          onMic={() => void toggleMic()}
          onStop={stop}
          onRetry={retry}
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
                <button
                  type="button"
                  disabled={busy || demoState === 'playing'}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    forget();
                  }}
                >
                  New conversation
                </button>
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
