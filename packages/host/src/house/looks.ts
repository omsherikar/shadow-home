/**
 * What the house shows for the home's live state: how each device looks, and the light outside
 * at the home's time of day. Pure functions, so the scene stays a drawing of these.
 */

export type Value = boolean | number | string;

/** A device as get_home_state reports it. */
export interface LiveDevice {
  id: string;
  kind: string;
  state: Record<string, Value>;
  sensor?: { trusted: boolean };
}

/** The parts of get_home_state the house draws. */
export interface LiveHome {
  now: string;
  mode: string;
  presence: Record<string, 'home' | 'away'>;
  zones: { id: string; name: string; tempC: number }[];
  devices: LiveDevice[];
}
