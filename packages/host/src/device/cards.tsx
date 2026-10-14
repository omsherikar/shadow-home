import type { Names } from '../turn/types.ts';

/** The parts of get_home_state the home card shows. */
export interface HomeState {
  now: string;
  mode: string;
  presence: Record<string, 'home' | 'away'>;
  zones: { id: string; name: string; tempC: number }[];
}

/** The parts of get_activity_log the log card shows. */
export interface LogState {
  entries: { id: string; at: string; who: string; what: string; undoable: boolean }[];
  groups: { cause: string; label: string; entryIds: string[] }[];
}

const MAX_GROUPS = 4;
const MAX_LINES = 3;

/** The idle screen: the home at a glance. Tools without a view are drawn by the host. */
export function HomeCard({ home, problem }: { home: HomeState | null; problem: string | null }) {
  if (problem) return <p className="card-message">{problem}</p>;
  if (!home) return <p className="card-message">Connecting to Shadow Home…</p>;
  const people = Object.entries(home.presence);
  const inHouse = people.filter(([, p]) => p === 'home').map(([id]) => capitalise(id));
  return (
    <div className="home-card">
      <p className="mode">{capitalise(home.mode)} mode</p>
      <p className="people">
        {inHouse.length === 0
          ? 'Nobody is home'
          : `${inHouse.join(', ')} ${inHouse.length === 1 ? 'is' : 'are'} home`}
      </p>
      <ul className="zones">
        {home.zones.map((z) => (
          <li key={z.id}>
            <span>{z.name}</span>
            <strong>{z.tempC.toFixed(1)} °C</strong>
          </li>
        ))}
      </ul>
      <p className="hint">Try one of the requests below.</p>
    </div>
  );
}

/** "What did you change?": the activity log grouped by cause, as text. */
export function LogCard({ log, names }: { log: LogState; names: Names | undefined }) {
  const byId = new Map(log.entries.map((e) => [e.id, e]));
  if (log.entries.length === 0) return <p className="card-message">Nothing has changed yet.</p>;
  return (
    <div className="log-card">
      <h2>What changed</h2>
      {log.groups.slice(0, MAX_GROUPS).map((g) => {
        const entries = g.entryIds.flatMap((id) => byId.get(id) ?? []);
        return (
          <section key={g.cause}>
            <h3>{g.label}</h3>
            <ul>
              {entries.slice(0, MAX_LINES).map((e) => (
                <li key={e.id}>
                  {e.what}
                  <span className="who"> · {names?.members[e.who] ?? capitalise(e.who)}</span>
                  {e.undoable ? <span className="undoable"> · say “undo”</span> : null}
                </li>
              ))}
              {entries.length > MAX_LINES ? <li>and {entries.length - MAX_LINES} more</li> : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
