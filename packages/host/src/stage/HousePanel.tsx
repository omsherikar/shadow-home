'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, HouseView } from '../house/House.tsx';
import { houseLayout as layout } from '../house/layout.ts';
import type { LiveDevice, LiveHome } from '../house/looks.ts';
import {
  changesBy,
  devicesAt,
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
}

/** Where things are pinned to the house: each room's middle, and above each device. */
const ANCHORS: Anchor[] = [
  ...layout.rooms.map(
    (r): Anchor => ({ id: `room:${r.id}`, at: [r.x + r.width / 2, 0.3, r.z + r.depth / 2] }),
  ),
];

interface Show {
  id: number;
  runs: Run[];
  /** The house as it was when the plan was checked: where every run starts. */
  devices: LiveDevice[];
  presence: Record<string, 'home' | 'away'>;
}

/**
 * The house panel: the 3D house under a sky that follows its clock, with room names, status dots
 * and what breaks pinned to it, and a card with the home's time and temperatures. When a plan is
 * checked it plays the plan forward in the shadow twin, then the plan with its fixes.
 */
export function HousePanel(props: {
  home: LiveHome | null;
  request: HouseRequest | null;
  mode: 'split' | 'house';
  /** The person asked for less motion: no sweep, no glides, just where each run ends. */
  still: boolean;
  onFail(): void;
}) {
  const { home, request, mode, still } = props;
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
  const [only, setOnly] = useState<number | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);
  const homeNow = useRef(home);
  homeNow.current = home;

  // A new request starts a show from the house as it is now, or ends one.
  const requestId = request?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request starts once, by its ID.
  useEffect(() => {
    const live = homeNow.current;
    if (!request) return;
    if (!request.play || !live) {
      setShow(null);
      return;
    }
    setShow({
      id: request.id,
      runs: request.play,
      devices: live.devices,
      presence: live.presence,
    });
    setOnly(undefined);
    started.current = performance.now();
    setElapsed(0);
  }, [requestId]);

  // With less motion, each run is shown where it ends: the plan first, then whichever is chosen.
  const shown = still ? (only ?? 0) : only;
  const m = show
    ? moment(show.runs, SHOW_TIMING, still ? Number.POSITIVE_INFINITY : elapsed, shown)
    : null;
  const done = m?.done ?? true;

  // The clock runs while a show plays, then stops.
  useEffect(() => {
    if (!show || still || done) return;
    let frame = requestAnimationFrame(function tick() {
      setElapsed(performance.now() - started.current);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [show, still, done]);

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
  const focus = !still && focusDevice ? (roomOf(layout, focusDevice) ?? null) : null;

  const view: HouseView = {
    devices,
    presence,
    time,
    shadow: show ? 1 : 0,
    focus,
  };

  const docked = mode === 'split';

  return (
    <>
      <House
        view={view}
        mode={mode}
        anchors={ANCHORS}
        pinned={pinned}
        inset={docked ? { top: cardBottom, bottom: 76 } : NO_INSET}
        still={still}
        onFail={props.onFail}
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
      </div>
      <div className="house-card glass" ref={card}>
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
      </div>
    </>
  );
}

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
