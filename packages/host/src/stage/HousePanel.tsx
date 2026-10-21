'use client';

import dynamic from 'next/dynamic';
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, HouseView } from '../house/House.tsx';
import { houseLayout as layout } from '../house/layout.ts';
import { daylight, dotFor, type LiveDevice, type LiveHome, skyColors } from '../house/looks.ts';
import { type Pace, paceFrom, rememberPace, sessionPace } from '../house/pace.ts';
import {
  type Break,
  changesBy,
  chartOf,
  devicesAt,
  type Guard,
  guarding,
  homeClock,
  homeIso,
  moment,
  presenceAt,
  type Run,
  roomOf,
  SHOW_TIMING,
  temperaturesAt,
} from '../house/playback.ts';
import { dayAndTime } from './stage.ts';

// three.js and the scene load in the browser only, and only on this page.
const House = dynamic(() => import('../house/House.tsx'), { ssr: false });

/** What the house is asked to do: play runs (a preview, a rule's sample day), or show the home. */
export interface HouseRequest {
  /** A new number for every request, so the same runs can be asked for twice. */
  id: number;
  play: Run[] | null;
  guard?: Guard;
}

/** The devices the story turns on, each with a status dot over it and a short name beside it. */
const DOTS = new Map<string, string>([
  ['front_door_lock', 'Front door'],
  ['back_door_lock', 'Back door'],
  ['plug_garage_freezer', 'Freezer'],
  ['plug_aquarium', 'Aquarium'],
  ['plug_bedroom_space_heater', 'Space heater'],
  ['plug_coffee_maker', 'Coffee maker'],
  ['thermostat_main', 'Thermostat'],
  ['garage_thermostat', 'Garage heat'],
]);
// Seen from the front, names that would cover a neighbour's dot sit on the dot's left instead.
const NAME_LEFT = new Set(['garage_thermostat']);

/** Where things are pinned to the house: each room's middle, and above each device. */
const ANCHORS: Anchor[] = [
  ...layout.rooms.map(
    (r): Anchor => ({ id: `room:${r.id}`, at: [r.x + r.width / 2, 0.3, r.z + r.depth / 2] }),
  ),
  ...layout.devices.map((d): Anchor => ({ id: `pin:${d.device}`, at: [d.x, d.y + 0.35, d.z] })),
];

interface Show {
  id: number;
  runs: Run[];
  guard?: Guard;
  /** The house as it was when the plan was checked: where every run starts. */
  devices: LiveDevice[];
  presence: Record<string, 'home' | 'away'>;
}

/**
 * The house panel: the 3D house under a sky that follows its clock, with room names, status dots
 * and what breaks pinned to it, and a card with the home's time and temperatures. When a plan is
 * checked it plays the plan forward in the shadow twin, then the plan with its fixes. It draws
 * again only when what it shows changes: the device beside it re-renders on every word of a turn,
 * and on a slow renderer each frame of the house holds the page for a second or more.
 */
export const HousePanel = memo(function HousePanel(props: {
  home: LiveHome | null;
  request: HouseRequest | null;
  mode: 'split' | 'house';
  /** The person asked for less motion: no sweep, no glides, just where each run ends. */
  still: boolean;
  /** WebGL here draws on the CPU: the house draws lean and shows where each run ends. */
  lean: boolean;
  onFail(): void;
}) {
  const { home, request, mode, still, lean } = props;
  const pins = useRef(new Map<string, HTMLElement>());
  // Beside the device the card runs across the top of the panel; the house is framed below it.
  const card = useRef<HTMLDivElement>(null);
  const cardBottom = useCardBottom(card);
  const pinned = useCallback((id: string) => pins.current.get(id), []);
  const pin = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) pins.current.set(id, el);
      else pins.current.delete(id);
    },
    [],
  );

  const [show, setShow] = useState<Show | null>(null);
  // A show begins drawing once the page is next idle (a second at most): by then the screen beside
  // the house has drawn what it was sent, the plan view with its verdict, so the twin's first
  // frame comes after it however long that frame takes.
  const [begun, setBegun] = useState(false);
  const [only, setOnly] = useState<number | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  // Whether this machine draws the house fast enough to sweep through a plan; found in the first
  // playback, then kept for the session. Read after mounting: the server has no session.
  const [pace, setPace] = useState<Pace>('unsure');
  useEffect(() => setPace(sessionPace()), []);
  // Software WebGL is too slow to sweep: no need to spend frames finding out.
  useEffect(() => {
    if (!lean || sessionPace() !== 'unsure') return;
    rememberPace('still');
    setPace('still');
  }, [lean]);
  const started = useRef(0);
  const homeNow = useRef(home);
  homeNow.current = home;

  // A new request starts a show from the house as it is now, or ends one.
  const requestId = request?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request starts once, by its ID.
  useEffect(() => {
    const live = homeNow.current;
    if (!request) return;
    setBegun(false);
    if (!request.play || !live) {
      setShow(null);
      return;
    }
    setShow({
      id: request.id,
      runs: request.play,
      ...(request.guard ? { guard: request.guard } : {}),
      devices: live.devices,
      presence: live.presence,
    });
    setOnly(undefined);
    setElapsed(0);
    const begin = () => {
      started.current = performance.now();
      setBegun(true);
    };
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(begin, { timeout: 1000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(begin, 100);
    return () => clearTimeout(id);
  }, [requestId]);

  // With less motion, or where frames are too slow to sweep, each run is shown where it ends: the
  // plan first, then whichever is chosen.
  const calm = still || pace === 'still';
  const shown = calm ? (only ?? 0) : only;
  const m =
    show && begun
      ? moment(show.runs, SHOW_TIMING, calm ? Number.POSITIVE_INFINITY : elapsed, shown)
      : null;
  // Waiting to begin isn't done: nothing about the show is on the house or its card yet.
  const done = show ? (m?.done ?? false) : true;

  // The clock runs while a show plays, then stops. Until the pace is known, the gaps between the
  // first frames decide it; a machine too slow to sweep goes straight to where the run ends.
  useEffect(() => {
    if (!show || !begun || calm || done) return;
    let judging = sessionPace() === 'unsure';
    const gaps: number[] = [];
    let last = performance.now();
    let frame = requestAnimationFrame(function tick() {
      const now = performance.now();
      if (judging) {
        gaps.push(now - last);
        last = now;
        const found = paceFrom(gaps);
        if (found !== 'unsure') {
          judging = false;
          rememberPace(found);
          setPace(found);
          if (found === 'still') return;
        }
      }
      setElapsed(now - started.current);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [show, begun, calm, done]);

  const replay = (i: number) => {
    setOnly(i);
    started.current = performance.now();
    setElapsed(0);
  };

  const run = show && m ? show.runs[m.run] : undefined;
  const homeMs = m?.homeMs ?? 0;
  const count = run ? changesBy(run.changes, homeMs) : 0;
  const devices = useMemo(
    () =>
      show && run
        ? devicesAt(show.devices, run.changes.slice(0, count), Number.POSITIVE_INFINITY)
        : (home?.devices ?? null),
    [show, run, count, home],
  );
  const presenceNow =
    show && run ? presenceAt(show.presence, run.presence, homeMs) : home?.presence;
  const presenceKey = JSON.stringify(presenceNow ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the same people, kept as one object.
  const presence = useMemo(() => presenceNow, [presenceKey]);
  const temps = run?.trace ? temperaturesAt(run.trace, homeMs) : null;
  const time = run ? homeIso(homeMs, run.offset) : (home?.now ?? '');
  const held = m?.held ?? [];
  const focusDevice = held.find((b) => b.device)?.device;
  const focus = !calm && focusDevice ? (roomOf(layout, focusDevice) ?? null) : null;

  const view: HouseView = {
    devices,
    presence,
    time,
    zonesC: temps?.zonesC ?? null,
    shadow: m ? 1 : 0,
    focus,
  };

  const sky = skyColors(daylight(time));
  const skyStyle = {
    '--sky-top': sky.top,
    '--sky-horizon': sky.horizon,
    '--sky-ground': sky.ground,
  } as CSSProperties;

  // What's broken so far in this run, by device; and what's shown as a card right now.
  const fired = run ? run.breaks.filter((b) => b.atMs <= homeMs) : [];
  const brokenAt = new Map<string, Break['kind']>();
  for (const b of fired) if (b.device && b.kind !== 'guard') brokenAt.set(b.device, b.kind);
  const cards = done ? fired.filter((b) => b.kind !== 'guard' || calm) : held;
  // Beside the device, whose screen already shows each rule and the garage's chart, the house
  // keeps the scene clear: what breaks right now goes in its card, and its dots keep the rest.
  // Alone, one card is pinned where it breaks; several at once, as at a run's end, would cover
  // each other and the rooms, so they're listed in the house's card instead.
  const docked = mode === 'split';
  const pinnedCards = !docked && cards.length === 1 ? cards.filter((b) => b.device) : [];
  const inCard = docked ? held : cards.filter((b) => !pinnedCards.includes(b));
  const guardOn = show?.guard && guarding(show.guard, time) ? show.guard.device : undefined;
  const byId = new Map((devices ?? []).map((d) => [d.id, d]));

  return (
    <>
      <div className="sky" style={skyStyle} aria-hidden="true" />
      <House
        view={view}
        mode={mode}
        anchors={ANCHORS}
        pinned={pinned}
        inset={docked ? { top: cardBottom, bottom: 76 } : NO_INSET}
        still={calm}
        onFail={props.onFail}
        lean={lean}
      />
      <div className="pins" data-playing={show ? 'yes' : 'no'}>
        {layout.rooms.map((r) => {
          const c = temps?.zonesC[r.zone];
          const showTemp = c !== undefined && (r.id === 'garage' || r.id === 'living_room');
          return (
            <div key={r.id} className="pin" ref={pin(`room:${r.id}`)} aria-hidden="true">
              <span className="room-label">
                {r.name}
                {showTemp ? <b> {c.toFixed(1)} °C</b> : null}
              </span>
            </div>
          );
        })}
        {layout.devices.map((d) => {
          const dot = DOTS.has(d.device) ? dotFor(byId.get(d.device)) : null;
          const broken = brokenAt.get(d.device);
          const mine = pinnedCards.filter((b) => b.device === d.device);
          if (!dot && mine.length === 0) {
            return <div key={d.device} className="pin" ref={pin(`pin:${d.device}`)} />;
          }
          return (
            <div key={d.device} className="pin" ref={pin(`pin:${d.device}`)}>
              {dot ? (
                <span
                  className={
                    mode === 'house' && NAME_LEFT.has(d.device) ? 'dot-name left' : 'dot-name'
                  }
                >
                  {DOTS.get(d.device)}
                </span>
              ) : null}
              {dot ? (
                <span
                  className={[
                    'dot',
                    `dot-${dot.tone}`,
                    broken ? `dot-${broken}` : '',
                    guardOn === d.device ? 'dot-guarding' : '',
                  ].join(' ')}
                  title={`${byId.get(d.device)?.name ?? d.device}: ${dot.label}`}
                  data-device={d.device}
                  data-state={dot.tone}
                />
              ) : null}
              {mine.map((b) => (
                <BreakCard
                  key={`${b.kind}:${b.rule ?? b.text}`}
                  b={b}
                  offset={run?.offset}
                  name={(id) => byId.get(id)?.name}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className={`house-card glass${inCard.length > 0 ? ' listing' : ''}`} ref={card}>
        <div className="card-head">
          <h1 className="house-name">{layout.name}</h1>
          <p className="house-time">{time ? dayAndTime(time) : ' '}</p>
        </div>
        <div className="card-now">
          {run ? (
            <p className={`run-chip ${run.tone}`} data-run={run.tone}>
              {m?.rewinding ? 'Back to the start' : run.label}
            </p>
          ) : null}
          <dl className="house-zones">
            {temps ? (
              <div>
                <dt>Outside</dt>
                <dd>{temps.outdoorC.toFixed(1)} °C</dd>
              </div>
            ) : null}
            {(home?.zones ?? []).map((z) => (
              <div key={z.id}>
                <dt>{z.name}</dt>
                <dd>{(temps?.zonesC[z.id] ?? z.tempC).toFixed(1)} °C</dd>
              </div>
            ))}
          </dl>
        </div>
        {show && show.runs.length > 1 && done ? (
          <div className="run-switch">
            {show.runs.map((r, i) => (
              <button
                key={r.planId}
                type="button"
                aria-pressed={m?.run === i}
                className={r.tone}
                onClick={() => replay(i)}
              >
                {r.label}
              </button>
            ))}
          </div>
        ) : null}
        {inCard.map((b) => (
          <BreakCard
            key={`${b.kind}:${b.text}`}
            b={b}
            offset={run?.offset}
            name={(id) => byId.get(id)?.name}
            inline
          />
        ))}
      </div>
      {run && !docked ? <ZoneChart run={run} homeMs={homeMs} zone="garage" /> : null}
    </>
  );
});

const NO_INSET = { top: 0, bottom: 0 };

/** Where a card's bottom edge sits in its panel, following it as it grows and shrinks. */
function useCardBottom(card: { current: HTMLElement | null }): number {
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const measure = () => setBottom(Math.round(el.offsetTop + el.offsetHeight + 12));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [card]);
  return bottom;
}

const AUTHOR = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** "dishwasher_latch: battery 4% …" with the device's own name: "Dishwasher door latch: …". */
function readable(text: string, name: (id: string) => string | undefined): string {
  return text.replace(/^([a-z0-9_]+):/, (whole, id: string) => {
    const n = name(id);
    return n ? `${n}:` : whole;
  });
}

/** A rule breaking (coral), a rule that may break or a reading that can't be trusted (amber). */
function BreakCard({
  b,
  offset,
  name,
  inline,
}: {
  b: Break;
  offset: string | undefined;
  name(id: string): string | undefined;
  inline?: boolean;
}) {
  const when = offset ? homeClock(b.atMs, offset) : '';
  const head =
    b.kind === 'violation'
      ? `${b.rule} breaks ${when}`
      : b.kind === 'not_robust'
        ? `${b.rule} may break ${when}`
        : b.kind === 'guard'
          ? `Guarded from ${when}`
          : 'Can’t confirm';
  return (
    <div
      className={`break-card glass ${b.kind}${inline ? ' inline' : ''}`}
      role="status"
      data-covers={inline ? undefined : ''}
    >
      <p className="break-head">{head}</p>
      <p className="break-text">{readable(b.text, name)}</p>
      {b.author ? <p className="break-who">{AUTHOR(b.author)}’s rule</p> : null}
    </div>
  );
}

/**
 * A zone's temperature over the run, drawn small, when it matters: the expected line, the three
 * runs' spread, the house rule's limit, and where the playback is.
 */
function ZoneChart({ run, homeMs, zone }: { run: Run; homeMs: number; zone: string }) {
  const W = 220;
  const H = 84;
  const chart = useMemo(
    () => (run.trace ? chartOf(run.trace, zone, run.limits[zone], W, H) : null),
    [run, zone],
  );
  const limit = run.limits[zone]?.minC;
  const lowest = run.trace ? Math.min(...(run.trace.zonesC.pessimistic[zone] ?? [])) : Number.NaN;
  // Only when the zone comes near its limit.
  if (!chart || limit === null || limit === undefined || !(lowest < limit + 2)) return null;
  const temps = run.trace ? temperaturesAt(run.trace, homeMs) : null;
  const now = temps?.zonesC[zone];
  const band = temps?.bandC[zone];
  return (
    <figure className="zone-chart glass" aria-label={`${zone} temperature`}>
      <figcaption>
        <span>Garage</span>
        {now !== undefined ? <b>{now.toFixed(1)} °C</b> : null}
        {band ? (
          <small>
            {band.low.toFixed(1)} to {band.high.toFixed(1)} °C across the three runs
          </small>
        ) : null}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-hidden="true">
        <path d={chart.band} className="band" />
        {chart.limitY !== null ? (
          <line x1={0} x2={W} y1={chart.limitY} y2={chart.limitY} className="limit" />
        ) : null}
        <path d={chart.line} className="line" />
        <line x1={chart.x(homeMs)} x2={chart.x(homeMs)} y1={0} y2={H} className="playhead" />
      </svg>
      <p className="zone-limit">The house rule: {limit} °C at least</p>
    </figure>
  );
}
