import type { Curve, TemperatureChart } from './temperature.ts';

const W = 1000;
const H = 130;
/** Room on the left for the zone's name and the rule's line, on the right for the curves' names. */
const LEFT = 132;
const TOP = 28;
const BOTTOM = H - 8;
/** About how wide "Sat 10:37 PM" is at the break label's size. */
const TIME_WIDTH = 130;

/**
 * A zone's temperature over the plan, against a house rule's line. Each curve is the nominal run,
 * over a band for the three runs' spread. A curve that holds is green; one that breaks the rule
 * is plain, and takes the verdict's colour where it crosses the line. Nothing moves.
 */
export function TemperatureView({ c }: { c: TemperatureChart }) {
  const right = W - (c.curves.length > 1 ? 150 : 14);
  const span = Math.max(1, c.endMs - c.startMs);
  const x = (ms: number) => LEFT + ((ms - c.startMs) / span) * (right - LEFT);
  const y = (t: number) => TOP + ((c.toC - t) / (c.toC - c.fromC)) * (BOTTOM - TOP);
  const minY = c.minC === null ? BOTTOM : y(c.minC);
  const maxY = c.maxC === null ? TOP : y(c.maxC);
  const tone = c.breaks?.tone ?? 'blocked';
  const bounds = [c.minC, c.maxC].filter((b): b is number => b !== null);
  const mark = c.breaks ? { x: x(c.breaks.atMs), y: y(c.breaks.atC) } : undefined;
  const markLabel = mark && breakLabel(mark.x, mark.y, c.breaks?.atC === c.minC);

  return (
    <svg
      className={`temps ${c.breaks ? tone : 'held'}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${c.zone} temperature`}
      aria-describedby="temps-summary"
    >
      <desc id="temps-summary">{c.summary}</desc>
      <defs>
        <clipPath id="temps-inside">
          <rect x={0} y={maxY} width={W} height={Math.max(0, minY - maxY)} />
        </clipPath>
        <clipPath id="temps-outside">
          <rect x={0} y={0} width={W} height={maxY} />
          <rect x={0} y={minY} width={W} height={H - minY} />
        </clipPath>
      </defs>

      {/* Where the rule breaks: below its lowest, above its highest. */}
      {c.minC !== null ? (
        <rect x={LEFT} y={minY} width={right - LEFT} height={BOTTOM - minY} className="outside" />
      ) : null}
      {c.maxC !== null ? (
        <rect x={LEFT} y={TOP} width={right - LEFT} height={maxY - TOP} className="outside" />
      ) : null}

      <text x={LEFT} y={18} className="tick">
        now
      </text>
      {c.days.map((d) => (
        <g key={d.atMs}>
          <line x1={x(d.atMs)} x2={x(d.atMs)} y1={TOP - 6} y2={BOTTOM} className="day" />
          {x(d.atMs) - LEFT > 48 ? (
            <text x={x(d.atMs) + 5} y={18} className="tick">
              {d.label}
            </text>
          ) : null}
        </g>
      ))}

      {bounds.map((b) => (
        <line key={`line-${b}`} x1={LEFT} x2={right} y1={y(b)} y2={y(b)} className="bound" />
      ))}

      {c.curves.map((curve, i) => (
        <Band key={`band-${curve.label ?? i}`} curve={curve} x={x} y={y} tone={tone} />
      ))}
      {c.curves.map((curve, i) => (
        <Line key={`line-${curve.label ?? i}`} curve={curve} x={x} y={y} tone={tone} />
      ))}

      <text x={0} y={titleY(bounds.map(y))} className="zone">
        {c.zone}
      </text>
      {bounds.map((b) => (
        <g key={`label-${b}`}>
          <rect x={LEFT - 116} y={y(b) - 12} width={40} height={24} rx={5} className="tag" />
          <text x={LEFT - 96} y={y(b) + 6} textAnchor="middle" className="tag-text">
            {c.rule}
          </text>
          <text x={LEFT - 10} y={y(b) + 7} textAnchor="end" className="bound-label">
            {b} °C
          </text>
        </g>
      ))}

      {c.breaks && mark && markLabel ? (
        <g className="break">
          <rect
            x={mark.x - 8}
            y={mark.y - 8}
            width={16}
            height={16}
            transform={`rotate(45 ${mark.x} ${mark.y})`}
            className="mark"
          />
          <text
            x={markLabel.x}
            y={markLabel.y}
            textAnchor={markLabel.anchor}
            className="break-label"
          >
            {c.breaks.label}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

type Scale = (v: number) => number;

/** The zone's name at the top of the left gutter, or lower down if a rule's label is there. */
function titleY(boundYs: number[]): number {
  const top = TOP + 18;
  const room = (spot: number) => Math.min(...boundYs.map((b) => Math.abs(b + 7 - spot)));
  if (room(top) >= 28) return top;
  return [(TOP + BOTTOM) / 2 + 7, BOTTOM].reduce(
    (best, spot) => (room(spot) > room(best) ? spot : best),
    top,
  );
}

/**
 * The break's time beside its mark: earlier in time, on the side the rule broke towards (below a
 * lowest, above a highest), unless that runs off the chart.
 */
function breakLabel(markX: number, markY: number, below: boolean) {
  const under = markY + 28;
  const over = markY - 16;
  const y = below ? (under <= H - 4 ? under : over) : over >= TOP + 8 ? over : under;
  const before = markX - 16 - TIME_WIDTH >= LEFT;
  return { x: before ? markX - 16 : markX + 16, y, anchor: before ? 'end' : 'start' } as const;
}

function Band({ curve, x, y, tone }: { curve: Curve; x: Scale; y: Scale; tone: string }) {
  const top = curve.atMs.map((ms, i) => pt(x(ms), y(curve.highC[i] ?? 0)));
  const bottom = curve.atMs.map((ms, i) => pt(x(ms), y(curve.lowC[i] ?? 0))).reverse();
  const d = `M${[...top, ...bottom].join('L')}Z`;
  if (curve.holds) return <path d={d} className="band held" />;
  return (
    <>
      <path d={d} className="band" clipPath="url(#temps-inside)" />
      <path d={d} className={`band ${tone}`} clipPath="url(#temps-outside)" />
    </>
  );
}

function Line({ curve, x, y, tone }: { curve: Curve; x: Scale; y: Scale; tone: string }) {
  const d = `M${curve.atMs.map((ms, i) => pt(x(ms), y(curve.nominalC[i] ?? 0))).join('L')}`;
  if (curve.holds) return <path d={d} className="curve held" />;
  return (
    <>
      <path d={d} className="curve" clipPath="url(#temps-inside)" />
      <path d={d} className={`curve ${tone}`} clipPath="url(#temps-outside)" />
    </>
  );
}

function pt(px: number, py: number): string {
  return `${Math.round(px * 10) / 10} ${Math.round(py * 10) / 10}`;
}
