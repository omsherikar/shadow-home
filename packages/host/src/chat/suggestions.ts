/** Whether the suggestions show is remembered across reloads, in the browser's local storage. */
export const SUGGESTIONS_KEY = 'shadow-home/suggestions';

/** Shown unless the person hid them, and shown when the storage can't be read. */
export function suggestionsShown(): boolean {
  try {
    return window.localStorage.getItem(SUGGESTIONS_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

export function rememberSuggestions(shown: boolean): void {
  try {
    if (shown) window.localStorage.removeItem(SUGGESTIONS_KEY);
    else window.localStorage.setItem(SUGGESTIONS_KEY, 'hidden');
  } catch {
    // Not kept: it lasts until the page reloads.
  }
}
