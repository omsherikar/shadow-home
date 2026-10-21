/** A tool call as the screen shows it while it runs; the same `id` comes again with its new state. */
export interface Step {
  id: string;
  tool: string;
  /** Plain words for what the tool does, from a fixed list: never the model's words. */
  label: string;
  state: 'running' | 'done' | 'failed';
}

/** Why a turn ended without an answer, in words a person can read. */
export interface TurnError {
  message: string;
  retryable: boolean;
  /** For a limit: how long until a turn would be taken again. */
  retryAfterMs?: number;
}
