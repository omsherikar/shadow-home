/**
 * The earcon: a short rising chime when she starts listening for a request, made on the spot with
 * Web Audio, so nothing is downloaded. Browsers allow sound only after a tap, so the audio is
 * readied inside the tap that turns hands-free on.
 */
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    context ??= new AudioContext();
    return context;
  } catch {
    return null;
  }
}

/** Ready the earcon's audio; call it inside a tap. */
export function readyEarcon(): void {
  void audio()
    ?.resume()
    .catch(() => undefined);
}

/** Two quick notes, rising: she's listening. */
export function earcon(): void {
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime;
  for (const [i, hz] of [660, 880].entries()) {
    const tone = ctx.createOscillator();
    const level = ctx.createGain();
    const at = start + i * 0.11;
    tone.type = 'sine';
    tone.frequency.value = hz;
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(0.18, at + 0.015);
    level.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    tone.connect(level).connect(ctx.destination);
    tone.start(at);
    tone.stop(at + 0.11);
  }
}
