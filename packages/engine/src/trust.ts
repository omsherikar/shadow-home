import { type Home, own, type Plan } from '@shadow-home/twin';

/**
 * Devices whose readings can't be trusted for this plan, with the reason: battery under
 * `lowBatteryPercent` or silent for more than `staleSensorMinutes`, after plan overrides.
 * Trust is judged at the plan's `now` and holds for the whole simulation.
 */
export function untrustedSensors(home: Home, plan: Plan): Map<string, string> {
  const { lowBatteryPercent, staleSensorMinutes } = home.simulation;
  const overrides = plan.context.stateOverrides ?? {};
  const out = new Map<string, string>();
  for (const device of home.devices) {
    if (!device.sensor) continue;
    const sensor = { ...device.sensor, ...own(overrides, device.id)?.sensor };
    const why: string[] = [];
    const battery = sensor.batteryPercent;
    if (battery !== null && battery !== undefined && battery < lowBatteryPercent) {
      why.push(`battery ${battery}% is under ${lowBatteryPercent}%`);
    }
    const silent = sensor.lastReportMinutesAgo;
    if (silent !== undefined && silent > staleSensorMinutes) {
      why.push(`silent for ${silent} minutes, over ${staleSensorMinutes}`);
    }
    if (why.length > 0) out.set(device.id, `${device.id}: ${why.join('; ')}`);
  }
  return out;
}
