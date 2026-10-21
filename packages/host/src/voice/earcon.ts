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
