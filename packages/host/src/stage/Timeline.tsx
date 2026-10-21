'use client';

import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import type { Run, Speed } from '../house/playback.ts';
import { SPEEDS } from '../house/playback.ts';
import { fractionOf, type Marker, type SeekPhase, timeAtFraction } from '../house/timeline.ts';

const HOUR_MS = 3_600_000;

/**
 * The strip under the house while a plan plays: play and pause, the speed, the home's clock, and
 * the run's hours with its nights shaded, a mark wherever something happens (red where a house
 * rule breaks) and the playhead, which can be dragged to any moment of the run.
 */
export function Timeline(props: {
  run: Run;
  homeMs: number;
  /** "Sat 2:00 AM". */
  clock: string;
  markers: Marker[];
  nights: { fromMs: number; toMs: number }[];
  playing: boolean;
  done: boolean;
  /** Shows only where each run ends (less motion asked for, or a slow renderer): no playing. */
  calm: boolean;
  speed: Speed;
  onPlay(): void;
  onPause(): void;
  onReplay(): void;
  onSpeed(speed: Speed): void;
  /** The person is dragging, or stepping with the keys, to a home time. */
  onSeek(homeMs: number, phase: SeekPhase): void;
}) {
  const { run, homeMs } = props;
  const track = useRef<HTMLDivElement>(null);
  const pct = (ms: number) => `${(fractionOf(run, ms) * 100).toFixed(2)}%`;

  const timeAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return homeMs;
    return timeAtFraction(run, (clientX - box.left) / box.width);
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    props.onSeek(timeAt(e.clientX), 'start');
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) props.onSeek(timeAt(e.clientX), 'move');
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    props.onSeek(timeAt(e.clientX), 'end');
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? homeMs + HOUR_MS
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? homeMs - HOUR_MS
          : e.key === 'PageUp'
            ? homeMs + 6 * HOUR_MS
            : e.key === 'PageDown'
              ? homeMs - 6 * HOUR_MS
              : e.key === 'Home'
                ? run.startMs
                : e.key === 'End'
                  ? run.endMs
                  : null;
    if (to === null) return;
    e.preventDefault();
    props.onSeek(Math.min(run.endMs, Math.max(run.startMs, to)), 'key');
  };

  return (
    <div className="timeline glass" data-playing={props.playing && !props.done ? 'yes' : 'no'}>
      {props.calm ? null : (
        <div className="timeline-controls">
          <button
            type="button"
            className="timeline-play"
            aria-label={props.done ? 'Play again' : props.playing ? 'Pause' : 'Play'}
            onClick={props.done ? props.onReplay : props.playing ? props.onPause : props.onPlay}
          >
            <span aria-hidden="true">{props.done ? '↻' : props.playing ? '❚❚' : '▶'}</span>
          </button>
          <div className="timeline-speeds">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={props.speed === s}
                aria-label={`${s}x speed`}
                onClick={() => props.onSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="timeline-clock">{props.clock}</p>
      <div
        ref={track}
        className="timeline-track"
        role="slider"
        tabIndex={0}
        aria-label="Time in the plan"
        aria-valuemin={run.startMs}
        aria-valuemax={run.endMs}
        aria-valuenow={Math.round(homeMs)}
        aria-valuetext={props.clock}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      >
        <div className="timeline-rail">
          {props.nights.map((n) => (
            <span
              key={n.fromMs}
              className="timeline-night"
              style={{ left: pct(n.fromMs), width: `calc(${pct(n.toMs)} - ${pct(n.fromMs)})` }}
            />
          ))}
          <span className="timeline-done" style={{ width: pct(homeMs) }} />
        </div>
        {props.markers.map((m) => (
          <span
            key={`${m.kind}:${m.atMs}:${m.label}`}
            className={`timeline-mark mark-${m.kind}`}
            style={{ left: pct(m.atMs) }}
            title={m.label}
          />
        ))}
        <span className="timeline-head" style={{ left: pct(homeMs) }} />
      </div>
    </div>
  );
}
