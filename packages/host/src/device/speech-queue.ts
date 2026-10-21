/**
 * Alexa's voice, sentence by sentence: each sentence is asked for as soon as it's finished, and the
 * clips play in order. The voice itself (the network, the speaker) is passed in, so the order, the
 * clearing and the replacing can be tested without a browser.
 */

/** One sentence's sound: a clip from /api/speak, or the browser's own voice saying it. */
export type Clip = { kind: 'audio'; audio: Blob } | { kind: 'browser'; refused: boolean };

export interface Voice {
  /**
   * The clip for one sentence. `refused` says /api/speak turned it down (429 or 503): the browser
   * says the rest of that answer.
   */
  fetch(text: string, signal: AbortSignal): Promise<Clip>;
  /** Say one sentence; resolves once it's said, or at once when `signal` aborts. */
  play(clip: Clip, text: string, signal: AbortSignal): Promise<void>;
}
