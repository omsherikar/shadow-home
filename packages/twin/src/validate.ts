import { findClusterAttr, isClusterName } from './clusters.ts';
import { hasOwn, own } from './records.ts';
import {
  type Cond,
  type Device,
  type Home,
  RULE_PRIORITIES,
  type StateCond,
  type Value,
} from './schema.ts';
import { attrDomain, checkValue } from './values.ts';

/**
 * Cross-reference checks a schema can't express: every ID a home mentions exists, every
 * attribute comes from one of the device's Matter clusters, and routine values are in range.
 * Returns one plain sentence per problem; an empty list means the home is consistent.
 */
export function validateHome(home: Home): string[] {
  const problems: string[] = [];
  const devices = new Map(home.devices.map((d) => [d.id, d]));
  const roomIds = new Set(home.rooms.map((r) => r.id));
  const zoneIds = new Set(home.zones.map((z) => z.id));
  const memberIds = new Set(home.household.members.map((m) => m.id));

  for (const [what, ids] of [
    ['device', home.devices.map((d) => d.id)],
    ['room', home.rooms.map((r) => r.id)],
    ['zone', home.zones.map((z) => z.id)],
    ['member', home.household.members.map((m) => m.id)],
    ['routine', home.routines.map((r) => r.id)],
    ['rule', home.rules.map((r) => r.id)],
  ] as const) {
    for (const dup of duplicates(ids)) problems.push(`duplicate ${what} id ${dup}`);
  }

  for (const id of Object.keys(home.household.presence)) {
    if (!memberIds.has(id)) problems.push(`presence lists unknown member ${id}`);
  }
  for (const id of memberIds) {
    if (!hasOwn(home.household.presence, id)) problems.push(`member ${id} has no presence`);
  }
  const clockOffset = offsetOf(home.clock.now);
  if (clockOffset !== home.home.utcOffset) {
    problems.push(
      `clock.now offset ${clockOffset} doesn't match the home's utcOffset ${home.home.utcOffset}`,
    );
  }
  for (const room of home.rooms) {
    if (!zoneIds.has(room.zone)) problems.push(`room ${room.id} is in unknown zone ${room.zone}`);
  }

  for (const device of home.devices) problems.push(...validateDevice(device, roomIds, zoneIds));

  for (const zone of home.zones) {
    const thermostat = devices.get(zone.heater.thermostat);
    if (!thermostat) {
      problems.push(`zone ${zone.id} heater uses unknown thermostat ${zone.heater.thermostat}`);
    } else if (thermostat.controlsZone !== zone.id) {
      problems.push(`zone ${zone.id} heater thermostat ${thermostat.id} doesn't control it`);
    }
  }
  for (const c of home.couplings) {
    for (const z of c.zones) if (!zoneIds.has(z)) problems.push(`coupling uses unknown zone ${z}`);
  }
  for (const g of home.internalGains) {
    if (!devices.has(g.device)) problems.push(`internal gain uses unknown device ${g.device}`);
    if (!zoneIds.has(g.zone)) problems.push(`internal gain uses unknown zone ${g.zone}`);
  }

  for (const [group, members] of Object.entries(home.groups)) {
    for (const m of members) {
      if (!devices.has(m)) problems.push(`group ${group} includes unknown device ${m}`);
    }
    for (const dup of duplicates(members)) problems.push(`group ${group} lists ${dup} twice`);
  }

  for (const routine of home.routines) {
    if (!memberIds.has(routine.owner)) {
      problems.push(`routine ${routine.id} has unknown owner ${routine.owner}`);
    }
    routine.actions.forEach((action, i) => {
      const where = `routine ${routine.id} action ${i}`;
      const targets =
        'device' in action ? [action.device] : (own(home.groups, action.group) ?? null);
      if (targets === null) {
        problems.push(`${where} uses unknown group ${'group' in action ? action.group : ''}`);
        return;
      }
      for (const target of targets) {
        problems.push(...checkWrite(devices.get(target), target, action.set, where));
      }
    });
  }

  for (const rule of home.rules) {
    const where = `rule ${rule.id}`;
    if (!memberIds.has(rule.author)) problems.push(`${where} has unknown author ${rule.author}`);
    const conds: Cond[] = [];
    switch (rule.template) {
      case 'always':
        conds.push(rule.params.state);
        break;
      case 'never_when':
        conds.push(rule.params.x, rule.params.when);
        break;
      case 'keep_between':
        if (!zoneIds.has(rule.params.quantity.zone)) {
          problems.push(`${where} uses unknown zone ${rule.params.quantity.zone}`);
        }
        if (rule.params.min === null && rule.params.max === null) {
          problems.push(`${where} sets neither min nor max`);
        } else if (
          rule.params.min !== null &&
          rule.params.max !== null &&
          rule.params.min > rule.params.max
        ) {
          problems.push(`${where} has min ${rule.params.min} above max ${rule.params.max}`);
        }
        if (rule.params.when) conds.push(rule.params.when);
        break;
      case 'within_after':
        conds.push(rule.params.after, ...rule.params.ensure);
        break;
      case 'never_together':
        conds.push(rule.params.a, rule.params.b);
        break;
    }
    for (const cond of conds) problems.push(...checkCond(cond, devices, memberIds, where));
  }

  const order = home.rulePriorityOrder;
  if (order.length !== RULE_PRIORITIES.length || new Set(order).size !== order.length) {
    problems.push(`rulePriorityOrder must list each of ${RULE_PRIORITIES.join(', ')} once`);
  }

  const times = home.forecast.hourly.map((h) => Date.parse(h.time));
  for (let i = 1; i < times.length; i++) {
    if ((times[i] ?? 0) <= (times[i - 1] ?? 0)) {
      problems.push(`forecast time ${home.forecast.hourly[i]?.time} is not after the one before`);
    }
  }

  return problems;
}

function validateDevice(device: Device, roomIds: Set<string>, zoneIds: Set<string>): string[] {
  const problems: string[] = [];
  const where = `device ${device.id}`;
  if (!roomIds.has(device.room)) problems.push(`${where} is in unknown room ${device.room}`);
  if (device.controlsZone && !zoneIds.has(device.controlsZone)) {
    problems.push(`${where} controls unknown zone ${device.controlsZone}`);
  }

  const clusters = device.matter.clusters;
  for (const c of clusters) {
    if (!isClusterName(c)) problems.push(`${where} has unmodelled cluster ${c}`);
  }
  for (const [attr, cap] of Object.entries(device.capabilities)) {
    if (cap.type === 'number' && cap.min > cap.max) {
      problems.push(`${where} capability ${attr} has min ${cap.min} above max ${cap.max}`);
    }
    if (!hasOwn(device.state, attr)) {
      problems.push(`${where} has no state for its capability ${attr}`);
    }
    const found = findClusterAttr(clusters, attr);
    if (!found) problems.push(`${where} capability ${attr} isn't in any of its clusters`);
    else if (found.access !== 'write') {
      problems.push(`${where} capability ${attr} is read-only in ${found.cluster}`);
    }
  }
  for (const [attr, value] of Object.entries(device.state)) {
    if (!findClusterAttr(clusters, attr)) {
      problems.push(`${where} state ${attr} isn't in any of its clusters`);
    }
    const domain = attrDomain(device, attr);
    const bad = domain ? checkValue(domain, value) : null;
    if (bad) problems.push(`${where} state ${attr}: ${bad.message}`);
  }
  const offered = new Set<string>();
  for (const c of clusters) {
    if (!isClusterName(c)) continue;
    for (const attr of Object.keys(device.capabilities).concat(Object.keys(device.state))) {
      const found = findClusterAttr([c], attr);
      if (found?.alexa) offered.add(found.alexa);
    }
  }
  for (const iface of device.alexa.interfaces) {
    if (!offered.has(iface)) {
      problems.push(`${where} lists Alexa interface ${iface} but no attribute uses it`);
    }
  }
  return problems;
}

function checkWrite(
  device: Device | undefined,
  deviceId: string,
  set: Record<string, Value>,
  where: string,
): string[] {
  if (!device) return [`${where} uses unknown device ${deviceId}`];
  const problems: string[] = [];
  for (const [attr, value] of Object.entries(set)) {
    const cap = own(device.capabilities, attr);
    if (!cap) {
      problems.push(`${where} writes ${deviceId}.${attr}, which it can't set`);
      continue;
    }
    const bad = checkValue(cap, value);
    if (bad) problems.push(`${where} ${deviceId}.${attr}: ${bad.message}`);
  }
  return problems;
}

function checkCond(
  cond: Cond,
  devices: Map<string, Device>,
  memberIds: Set<string>,
  where: string,
): string[] {
  if ('any' in cond) return cond.any.flatMap((c) => checkCond(c, devices, memberIds, where));
  if ('all' in cond) return cond.all.flatMap((c) => checkCond(c, devices, memberIds, where));
  if ('not' in cond) return checkCond(cond.not, devices, memberIds, where);
  if ('time' in cond) return [];
  if ('presence' in cond) {
    const p = cond.presence;
    return typeof p === 'object' && !memberIds.has(p.member)
      ? [`${where} refers to unknown member ${p.member}`]
      : [];
  }
  return checkStateCond(cond, devices, where);
}

function checkStateCond(cond: StateCond, devices: Map<string, Device>, where: string): string[] {
  const device = devices.get(cond.device);
  if (!device) return [`${where} refers to unknown device ${cond.device}`];
  if (!hasOwn(device.capabilities, cond.attr) && !hasOwn(device.state, cond.attr)) {
    return [`${where} refers to ${cond.device}.${cond.attr}, which it doesn't have`];
  }
  const domain = attrDomain(device, cond.attr);
  const value = 'eq' in cond ? cond.eq : cond.neq;
  const bad = domain ? checkValue(domain, value) : null;
  return bad ? [`${where} compares ${cond.device}.${cond.attr}: ${bad.message}`] : [];
}

/** "2027-01-15T17:45:00-06:00" → "-06:00"; "…Z" → "+00:00". */
function offsetOf(iso: string): string {
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(iso);
  return m?.[1] === 'Z' ? '+00:00' : (m?.[1] ?? '');
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) (seen.has(id) ? dups : seen).add(id);
  return [...dups];
}
