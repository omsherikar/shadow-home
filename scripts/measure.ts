// What the latency and load scripts share: the two plans they send to preview_plan, and the
// percentile they report.

/** A plan that changes one light, and the demo's weekend plan, the heaviest real request. */
export const PLANS = {
  'weekend away (UNSAFE, with repairs)': {
    intent: "I'm away for the weekend, set the house to away.",
    requestedBy: 'om',
    presenceSchedule: [
      { from: '2027-01-15T18:00:00-06:00', to: '2027-01-17T18:00:00-06:00', presence: 'nobody' },
    ],
    planEnd: '2027-01-17T18:00:00-06:00',
    actions: [
      { device: 'thermostat_main', set: { heatingSetpointC: 10 } },
      { device: 'garage_thermostat', set: { systemMode: 'off' } },
      { group: 'all_plugs', set: { onOff: false } },
      { group: 'all_lights', set: { onOff: false } },
      { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
      { device: 'back_door_lock', set: { lockState: 'LOCKED' } },
      { mode: 'away' },
    ],
  },
  'dim the living room (SAFE)': {
    intent: 'Dim the living room to 30 percent.',
    requestedBy: 'om',
    actions: [{ device: 'light_living', set: { brightness: 30 } }],
  },
};

/** The p-th percentile of ascending times, by nearest rank. */
export const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
