/**
 * What the house says in plain words while it plays: each change as it happens ("Garage freezer
 * off"), and at the end what each run came to ("Your plan: 4 house rules break; the garage drops
 * below 4 °C Sat 10:37 PM."). Only from the run itself: its changes, its breaks, its temperature
 * rules and its trace.
 */
import type { LiveDevice } from './looks.ts';
import type { Change } from './playback.ts';

/** "dishwasher_latch: battery 4% …" with the device's own name: "Dishwasher door latch: …". */
export function readable(text: string, name: (id: string) => string | undefined): string {
  return text.replace(/^([a-z0-9_]+):/, (whole, id: string) => {
    const n = name(id);
    return n ? `${n}:` : whole;
  });
}

/** "Garage freezer off", "Front door locked", "Main thermostat to 10 °C". */
export function changeWords(c: Change, device: LiveDevice | undefined): string {
  const name = device?.name ?? c.device;
  switch (c.attr) {
    case 'onOff':
      return `${name} ${c.to === true ? 'on' : 'off'}`;
    case 'lockState': {
      const door = name.replace(/ lock$/i, '');
      if (c.to === 'LOCKED') return `${door} locked`;
      if (c.to === 'UNLOCKED') return `${door} unlocked`;
      return `${name}: ${String(c.to).toLowerCase()}`;
    }
    case 'heatingSetpointC':
      return `${name} to ${c.to} °C`;
    case 'systemMode':
      return c.to === 'off' ? `${name} off` : `${name} set to ${c.to}`;
    case 'brightness':
      return `${name} at ${c.to}%`;
    case 'contact':
      return `${name} ${c.to}`;
    default:
      return `${name}: ${c.attr} ${String(c.to)}`;
  }
}
