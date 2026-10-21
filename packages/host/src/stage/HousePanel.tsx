'use client';

import dynamic from 'next/dynamic';
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, HouseView } from '../house/House.tsx';
import { houseLayout as layout } from '../house/layout.ts';
import { daylight, dotFor, type LiveDevice, type LiveHome, skyColors } from '../house/looks.ts';
import { judgeFrame, NEW_PLAYBACK, type Pace, showsEnds } from '../house/pace.ts';
import {
  advance,
  type Break,
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
import { fractionOf } from '../house/timeline.ts';
import { changeWords, readable, stepWords } from '../house/words.ts';
import { dayAndTime } from './stage.ts';
import './house-panel.css';

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

/** How long a device keeps its name beside it after it changes while a plan plays. */
const CHANGE_LABEL_MS = 1800;

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
  // Where the show is, in real milliseconds.
  const [position, setPosition] = useState(0);
  // Whether this playback's frames come fast enough to sweep through the plan: found from its
  // first frames of the clock running, afresh for every playback.
  const [pace, setPace] = useState<Pace>('unsure');
  const paceNow = useRef(pace);
  paceNow.current = pace;
  const positionNow = useRef(position);
  positionNow.current = position;
  const homeNow = useRef(home);
  homeNow.current = home;
  // Known before a playback's frames: less motion asked for, or software WebGL.
  const calmFromStart = useRef(still || lean);
  calmFromStart.current = still || lean;

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
    setPosition(calmFromStart.current ? Number.POSITIVE_INFINITY : 0);
    setPace('unsure');
    const begin = () => setBegun(true);
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(begin, { timeout: 1000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(begin, 100);
    return () => clearTimeout(id);
  }, [requestId]);

  // With less motion, on software WebGL, or where this playback's frames are too slow to sweep,
  // each run is shown where it ends: the plan first, then whichever is chosen.
  const calm = showsEnds(pace, still, lean);
  const shown = calm ? (only ?? 0) : only;
  useEffect(() => {
    if (calm) setPosition(Number.POSITIVE_INFINITY);
  }, [calm]);
  const m = show && begun ? moment(show.runs, SHOW_TIMING, position, shown) : null;
  // Waiting to begin isn't done: nothing about the show is on the house or its card yet.
  const done = show ? (m?.done ?? false) : true;

  // The clock runs while a show plays, then stops. Until this playback's pace is known, the gaps
  // between its frames of the clock running decide it; too slow, and it goes to where the run ends.
  useEffect(() => {
    if (!show || !begun || calm || done) return;
    let judging = paceNow.current === 'unsure' ? NEW_PLAYBACK : undefined;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick() {
      const now = performance.now();
      const gap = now - last;
      last = now;
      const at = positionNow.current;
      if (judging) {
        const sweeping = moment(show.runs, SHOW_TIMING, at, shown).phase === 'sweep';
        judging = judgeFrame(judging, gap, sweeping);
        if (judging.pace !== 'unsure') {
          setPace(judging.pace);
          if (judging.pace === 'still') return;
          judging = undefined;
        }
      }
      const next = advance(show.runs, SHOW_TIMING, at, gap, 1, shown);
      positionNow.current = next;
      setPosition(next);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [show, begun, calm, done, shown]);

  /** Play one run again from its start (in calm, show where it ends). */
  const replay = (i: number) => {
    setOnly(i);
    setPosition(calm ? Number.POSITIVE_INFINITY : 0);
  };

  const run = show && m ? show.runs[m.run] : undefined;
  const homeMs = m?.homeMs ?? 0;
  const applied = m?.applied ?? 0;
  const devices = useMemo(
    () =>
      show && run
        ? devicesAt(show.devices, run.changes.slice(0, applied), Number.POSITIVE_INFINITY)
        : (home?.devices ?? null),
    [show, run, applied, home],
  );
  // While the clock winds back for the fixes, everyone stays where the next run starts them.
  const next = show && m?.rewinding ? show.runs[m.run + 1] : undefined;
  const presenceNow =
    show && run
      ? next
        ? presenceAt(show.presence, next.presence, next.startMs)
        : presenceAt(show.presence, run.presence, homeMs)
      : home?.presence;
  const presenceKey = JSON.stringify(presenceNow ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the same people, kept as one object.
  const presence = useMemo(() => presenceNow, [presenceKey]);
  const temps = run?.trace ? temperaturesAt(run.trace, homeMs) : null;
  const time = run ? homeIso(homeMs, run.offset) : (home?.now ?? '');
  // Winding back, the sky stays where the run ended rather than flicker through two days.
  const lightTime = run && m?.rewinding ? homeIso(run.endMs, run.offset) : time;
  const held = m?.held ?? [];
  const step = m?.step ?? null;
  const focusDevice = held.find((b) => b.device)?.device;
  const focus = !calm && focusDevice ? (roomOf(layout, focusDevice) ?? null) : null;
  const moving = !!show && begun && !calm && !done;

  const view: HouseView = {
    devices,
    presence,
    time: lightTime,
    zonesC: temps?.zonesC ?? null,
    shadow: m ? 1 : 0,
    focus,
    // Tied to where the run is, so the camera winds back with it.
    dolly: run && !calm ? fractionOf(run, homeMs) : null,
  };

  const sky = skyColors(daylight(lightTime));
  const skyStyle = {
    '--sky-top': sky.top,
    '--sky-horizon': sky.horizon,
    '--sky-ground': sky.ground,
  } as CSSProperties;

  // What's broken so far in this run, by device; and what's shown as a card right now.
  const fired = m?.fired ?? [];
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
  const recent = useRecentChanges(devices, !!show);
  const acting = new Set(step?.changes.map((c) => c.device) ?? []);
  const lastChange = (id: string) =>
    run?.changes
      .slice(0, applied)
      .filter((c) => c.device === id)
      .at(-1);

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
        moving={moving}
        onFail={props.onFail}
        lean={lean}
      />
      <div
        className="pins"
        data-playing={show ? 'yes' : 'no'}
        data-moving={moving ? 'yes' : 'no'}
        data-phase={m?.phase ?? 'none'}
      >
        {layout.rooms.map((r) => {
          const c = temps?.zonesC[r.zone];
          const showTemp = c !== undefined && (r.id === 'garage' || r.id === 'living_room');
          return (
            <div key={r.id} className="pin" ref={pin(`room:${r.id}`)} aria-hidden="true">
              <span className={showTemp ? 'room-label with-temp' : 'room-label'}>
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
          const first = step?.changes[0]?.device === d.device;
          const isActing = acting.has(d.device);
          const changed = !isActing && moving && recent(d.device);
          // The plan's own changes were named as they were acted out; routines are named here.
          const latest = changed ? lastChange(d.device) : undefined;
          const change = latest?.source === 'plan' ? undefined : latest;
          if (!dot && mine.length === 0 && !isActing && !change) {
            return <div key={d.device} className="pin" ref={pin(`pin:${d.device}`)} />;
          }
          return (
            <div key={d.device} className="pin" ref={pin(`pin:${d.device}`)}>
              {isActing ? <span className="act-ring" aria-hidden="true" /> : null}
              {dot ? (
                <span
                  className={[
                    mode === 'house' && NAME_LEFT.has(d.device) ? 'dot-name left' : 'dot-name',
                    changed || isActing ? 'recent' : '',
                  ].join(' ')}
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
              {first && step ? (
                <span className="step-label" data-step="">
                  {stepWords(step.changes, devices)}
                </span>
              ) : null}
              {change && !dot ? (
                <span className="change-label">{changeWords(change, byId.get(d.device))}</span>
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

/**
 * Which devices changed in the last moments of a playback, by the page's clock: the house names a
 * device beside it when it changes, then lets the name go.
 */
function useRecentChanges(
  devices: LiveDevice[] | null,
  playing: boolean,
): (device: string) => boolean {
  const states = useRef(new Map<string, string>());
  const changed = useRef(new Map<string, number>());
  useEffect(() => {
    if (!devices) return;
    const now = performance.now();
    for (const d of devices) {
      const state = JSON.stringify(d.state);
      const before = states.current.get(d.id);
      if (playing && before !== undefined && before !== state) changed.current.set(d.id, now);
      states.current.set(d.id, state);
    }
    if (!playing) changed.current.clear();
  }, [devices, playing]);
  return (device) =>
    performance.now() - (changed.current.get(device) ?? Number.NEGATIVE_INFINITY) < CHANGE_LABEL_MS;
}

const AUTHOR = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

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
  // Plain words: the rule's own words say which rule, so its number stays on the device's screen.
  const head =
    b.kind === 'violation'
      ? `Breaks ${when}`
      : b.kind === 'not_robust'
        ? `Might break ${when}`
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
