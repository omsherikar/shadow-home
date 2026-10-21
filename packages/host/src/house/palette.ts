/**
 * The house's colours: a warm dollhouse at dusk. Glows match the plan view's verdict colours
 * (safe green, coral red, amber), so a status light means the same thing on both screens.
 */
export const palette = {
  plaster: '#dccfba',
  cut: '#3a2e25',
  lawn: '#56603f',
  soil: '#2b231d',
  paving: '#8f887d',
  path: '#a69a87',
  frontDoor: '#2f4a58',
  garageDoor: '#d6cfc2',
  glass: '#a9cbe0',
  counterFront: '#7e8d73',
  counterTop: '#e7e2d8',
  walnut: '#6a4a33',
  linen: '#ece5d9',
  sheet: '#f3efe7',
  headboard: '#b8a98f',
  duvetMain: '#4e6f7e',
  duvetSam: '#86aac2',
  rugLiving: '#a78c5f',
  rugBedroom: '#8e9aa4',
  ivory: '#f1ece2',
  graphite: '#2f2c29',
  steel: '#b8bcbf',
  skin: '#e0c3a3',
  lamp: '#ffc47a',
  screen: '#9cc7ff',
  water: '#5fc9d0',
  heat: '#ff7a3d',
  ok: '#34d399',
  warn: '#fbbf24',
  alarm: '#f87171',
  unknown: '#fbbf24',
} as const;

/** The colour of a device's status light. */
export function statusColor(status: 'ok' | 'warn' | 'alarm' | 'off' | 'unknown'): string {
  if (status === 'off') return palette.graphite;
  return palette[status];
}
