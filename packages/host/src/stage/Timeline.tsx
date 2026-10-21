'use client';

import type { Run } from '../house/playback.ts';
import { fractionOf, type Marker } from '../house/timeline.ts';

/**
 * The strip under the house while a plan plays: the home's clock, and the run's hours with its
 * nights shaded, a mark wherever something happens (red where a house rule breaks) and the
 * playhead.
 */
export function Timeline(props: {
  run: Run;
  homeMs: number;
  /** "Sat 2:00 AM". */
  clock: string;
  markers: Marker[];
  nights: { fromMs: number; toMs: number }[];
}) {
  const { run, homeMs } = props;
  const pct = (ms: number) => `${(fractionOf(run, ms) * 100).toFixed(2)}%`;

  return (
    <div className="timeline glass">
      <p className="timeline-clock">{props.clock}</p>
      <div className="timeline-track">
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
