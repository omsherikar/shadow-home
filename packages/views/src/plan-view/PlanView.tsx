import type { App } from '@modelcontextprotocol/ext-apps';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import { useCallback, useRef, useState } from 'react';
import { type Control, type Screen, screenFor, type Timeline } from './screen.ts';
import { APPROVAL_META_KEY, type Commit, NAMES_META_KEY, type Names } from './types.ts';

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

type Shown =
  | { kind: 'waiting'; intent?: string }
  | { kind: 'screen'; screen: Screen }
  | { kind: 'message'; text: string };

const textOf = (r: ToolResult) =>
  (r.content ?? [])
    .map((c) => c.text ?? '')
    .join(' ')
    .trim();

export function PlanView() {
  const [shown, setShown] = useState<Shown>({ kind: 'waiting' });
  // The last names seen, for a result that arrives without them.
  const names = useRef<Names | undefined>(undefined);
  // Approval tokens for the plans shown so far: a tap is the only way to approve one.
  const approvals = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((r: ToolResult) => {
    const fresh = r._meta?.[NAMES_META_KEY] as Names | undefined;
    if (fresh) names.current = fresh;
    const tokens = r._meta?.[APPROVAL_META_KEY] as Record<string, string> | undefined;
    if (tokens) approvals.current = { ...approvals.current, ...tokens };
    if (r.isError) {
      setShown({ kind: 'message', text: textOf(r) || 'That didn’t work.' });
      return;
    }
    const screen = screenFor(r.structuredContent, names.current);
    setShown(screen ? { kind: 'screen', screen } : { kind: 'message', text: textOf(r) });
  }, []);

  const { app, error: connectError } = useApp({
    appInfo: { name: 'shadow-home-plan-view', version: '0.1.0' },
    capabilities: {},
    autoResize: false,
    onAppCreated: (created) => {
      created.ontoolinput = (p) => {
        const intent = p.arguments?.intent;
        setError(null);
        setShown({ kind: 'waiting', ...(typeof intent === 'string' ? { intent } : {}) });
      };
      created.ontoolresult = (r) => show(r as ToolResult);
    },
  });

  const run = useCallback(
    async (control: Control) => {
      if (!app) return;
      setBusy(true);
      setError(null);
      try {
        const result = await perform(app, control, approvals.current);
        if (result) show(result);
        else setShown({ kind: 'message', text: 'Nothing changed.' });
        await tellModel(app, control, result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [app, show],
  );

  if (connectError) return <Message text={`Can't reach the host: ${connectError.message}`} />;
  if (shown.kind === 'message') return <Message text={shown.text} />;
  if (shown.kind === 'waiting') {
    return <Message text={shown.intent ? `Checking “${shown.intent}”…` : 'Waiting for a plan…'} />;
  }
  return <ScreenView screen={shown.screen} busy={busy} error={error} onControl={run} />;
}

/** Do what a tap asks. A yes to a plan that needs one records an on-screen approval first. */
async function perform(
  app: App,
  control: Control,
  approvals: Record<string, string>,
): Promise<ToolResult | null> {
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await app.callServerTool({ name, arguments: args })) as ToolResult;
    if (r.isError) throw new Error(textOf(r) || `${name} failed`);
    return r;
  };
  const a = control.action;
  if (a.kind === 'dismiss') return null;
  if (a.kind === 'undo') return call('undo', { token: a.token });
  if (a.safePartOnly) return call('commit_plan', { planId: a.planId, safePartOnly: true });
  const first = await call('commit_plan', { planId: a.planId });
  const c = first.structuredContent as Commit | undefined;
  // Only the plan this button is for: a different plan ID means a new question, shown next.
  const approvalToken = approvals[a.planId];
  if (c?.status !== 'needs_confirmation' || c.planId !== a.planId || !approvalToken) return first;
  await call('approve_plan', { planId: a.planId, approvalToken });
  return call('commit_plan', { planId: a.planId });
}

/**
 * Tell the assistant what happened on screen, so the conversation knows on its next turn. A tap
 * that changes nothing (Cancel, OK) closes the question on screen, so a later "yes" can't answer it.
 */
async function tellModel(app: App, control: Control, result: ToolResult | null) {
  const what = result ? textOf(result) : 'Nothing changed.';
  try {
    await app.updateModelContext({
      content: [{ type: 'text', text: `On screen, the person tapped “${control.label}”. ${what}` }],
      structuredContent: { tapped: control.label, closed: control.action.kind === 'dismiss' },
    });
  } catch {
    // A host that doesn't keep model context still works; the screen already shows the result.
  }
}

function Message({ text }: { text: string }) {
  return (
    <main className="screen tone-neutral">
      <p className="message">{text}</p>
    </main>
  );
}

function ScreenView({
  screen: s,
  busy,
  error,
  onControl,
}: {
  screen: Screen;
  busy: boolean;
  error: string | null;
  onControl: (c: Control) => void;
}) {
  return (
    <main className={`screen tone-${s.tone}`} aria-busy={busy}>
      <header className="head">
        <div className="badge">
          <span className="icon" aria-hidden="true">
            {s.icon}
          </span>
          <span className="word">{s.word}</span>
        </div>
        <div className="speech">
          <h1>{s.headline}</h1>
          {s.reason ? <p className="reason">{s.reason}</p> : null}
          {s.ask ? <p className="ask">{s.ask}</p> : null}
        </div>
      </header>

      <section className={s.cards.length > 0 ? 'body two' : 'body'}>
        {s.rows.length > 0 || s.notes.length > 0 ? (
          <div className="changes">
            {s.rows.length > 0 ? (
              <>
                <h2>{s.rowsTitle}</h2>
                <ul className="rows">
                  {s.rows.map((row) => (
                    <li key={row.place} className="row">
                      <span className="place">{row.place}</span>
                      <span className="chips">
                        {row.chips.map((chip) => (
                          <span
                            key={`${chip.tone}-${chip.text}`}
                            className={`chip ${chip.tone ?? ''}`}
                          >
                            {chip.text}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {s.notes.length > 0 ? (
              <ul className="notes">
                {s.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {s.cards.length > 0 ? (
          <div className="why">
            <h2>Why</h2>
            <ol className="cards">
              {s.cards.map((c) => (
                <li key={c.id} className="card">
                  <div className="cause">
                    <span className="tag">{c.id}</span> {c.cause} <span className="at">{c.at}</span>
                  </div>
                  {c.breaks ? <div className="breaks">{c.breaks}</div> : null}
                  <div className="rule">
                    “{c.rule}” <span className="author">{c.author}’s rule</span>
                  </div>
                  {c.fix ? <div className="fix">Fix: {c.fix}</div> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>

      {s.timeline ? <TimelineView t={s.timeline} /> : null}

      <footer className="controls">
        {s.controls.map((c) => (
          <button
            key={c.label}
            type="button"
            className={c.primary ? 'primary' : ''}
            disabled={busy}
            onClick={() => onControl(c)}
          >
            <span>{c.label}</span>
            <small>Say “{c.say}”</small>
          </button>
        ))}
        {error ? <p className="error">{error}</p> : null}
      </footer>
    </main>
  );
}

const W = 1000;
const LABEL_W = 150;
const LANE_H = 21;
const TOP = 20;

function TimelineView({ t }: { t: Timeline }) {
  const span = Math.max(1, t.endMs - t.startMs);
  const x = (ms: number) => LABEL_W + ((ms - t.startMs) / span) * (W - LABEL_W - 10);
  const h = TOP + t.lanes.length * LANE_H + 6;
  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${h}`} role="img" aria-label="Timeline">
      <text x={LABEL_W} y={13} className="tick">
        now
      </text>
      {t.days.map((d) => (
        <g key={d.atMs}>
          <line x1={x(d.atMs)} x2={x(d.atMs)} y1={16} y2={h} className="day" />
          <text x={x(d.atMs) + 4} y={13} className="tick">
            {d.label}
          </text>
        </g>
      ))}
      {t.lanes.map((lane, i) => {
        const y = TOP + i * LANE_H + LANE_H / 2;
        return (
          <g key={lane.label}>
            <text x={0} y={y + 5} className="lane">
              {lane.label}
            </text>
            <line x1={LABEL_W} x2={W - 10} y1={y} y2={y} className="track" />
            {lane.marks.map((m) => (
              <g key={`${m.atMs}-${m.label}`}>
                <title>{m.label}</title>
                {m.tone === 'blocked' ? (
                  <rect
                    x={x(m.atMs) - 6}
                    y={y - 6}
                    width={12}
                    height={12}
                    transform={`rotate(45 ${x(m.atMs)} ${y})`}
                    className="mark blocked"
                  />
                ) : (
                  <circle cx={x(m.atMs)} cy={y} r={6} className="mark" />
                )}
                {m.tone === 'blocked' ? (
                  <text x={x(m.atMs) + 10} y={y + 5} className="mark-label">
                    {m.label}
                  </text>
                ) : null}
              </g>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
