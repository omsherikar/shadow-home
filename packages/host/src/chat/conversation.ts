/**
 * The conversation as the chat shows it: what the person said, and Alexa's answers as they arrive,
 * with the steps she took, the verdict and what to offer next. Pure functions over plain data, so
 * the chat is a drawing of these and they can be tested without a browser.
 */
import type { Chip } from '../stage/stage.ts';
import type { TurnRequest } from '../turn/types.ts';
import type { StepState } from './stream.ts';

export interface Step {
  id: string;
  label: string;
  state: StepState;
}

/**
 * Where an answer is: waiting for its first word or step (thinking), running tools (working),
 * writing (talking), finished, stopped by the person, or failed.
 */
export type Phase = 'thinking' | 'working' | 'talking' | 'done' | 'stopped' | 'failed';

export interface Problem {
  message: string;
  retryable: boolean;
  /** For a limit: when a turn can go through again (ms since 1970). */
  retryAt?: number;
}

/** Something the person can tap to answer, and the words it sends. */
export interface FollowUp {
  label: string;
  says: string;
}

export interface Message {
  id: string;
  who: 'you' | 'alexa';
  text: string;
  /** Alexa's answers only, from here down. */
  phase?: Phase;
  steps?: Step[];
  verdict?: Chip;
  /** What the details view lists: rule numbers, whose rule, which wins. */
  details?: string[];
  problem?: Problem;
  /** For a retry: the request this answers, exactly as it was sent. */
  request?: TurnRequest;
}
