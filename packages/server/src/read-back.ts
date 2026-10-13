import type { Cond, Home, Rule, StateCond, Value } from '@shadow-home/twin';

/**
 * A plain sentence for a compiled rule, built from the template and device names, so the person
 * can hear what the rule will actually check. The rule compiler writes a smoother read-back;
 * this one is exact.
 */
export function readBack(home: Home, rule: Rule): string {
  const say = (c: Cond) => condPhrase(home, c);
  switch (rule.template) {
    case 'always':
      return `Always: ${say(rule.params.state)}.`;
    case 'never_when':
      return `Never: ${say(rule.params.x)}, when ${say(rule.params.when)}.`;
    case 'keep_between': {
      const zone = home.zones.find((z) => z.id === rule.params.quantity.zone)?.name ?? 'the zone';
      const { min, max, when } = rule.params;
      const range =
        min !== null && max !== null
          ? `between ${min} and ${max} °C`
          : min !== null
            ? `at or above ${min} °C`
            : `at or below ${max} °C`;
      return `${zone} stays ${range}${when ? ` when ${say(when)}` : ''}.`;
    }
    case 'within_after': {
      const m = rule.params.minutes;
      const ensure = rule.params.ensure.map(say).join(', and ');
      return `Within ${m} minute${m === 1 ? '' : 's'} of ${say(rule.params.after)}: ${ensure}.`;
    }
    case 'never_together':
      return `Never at the same time: ${say(rule.params.a)}, and ${say(rule.params.b)}.`;
  }
}

function condPhrase(home: Home, c: Cond): string {
  const say = (x: Cond) => condPhrase(home, x);
  if ('any' in c) return c.any.map(say).join(' or ');
  if ('all' in c) return c.all.map(say).join(' and ');
  if ('not' in c) {
    const inner = c.not;
    if ('presence' in inner && typeof inner.presence === 'object') {
      const name = memberName(home, inner.presence.member);
      return `${name} isn't ${inner.presence.is === 'home' ? 'home' : 'away'}`;
    }
    return `not (${say(inner)})`;
  }
  if ('time' in c) return `it's between ${c.time.from} and ${c.time.to}`;
  if ('presence' in c) {
    const p = c.presence;
    if (p === 'nobody') return "nobody's home";
    if (p === 'anyone') return "someone's home";
    return `${memberName(home, p.member)} is ${p.is === 'home' ? 'home' : 'away'}`;
  }
  return statePhrase(home, c);
}

function statePhrase(home: Home, c: StateCond): string {
  const name = home.devices.find((d) => d.id === c.device)?.name ?? c.device;
  const value = (v: Value) => (c.attr === 'onOff' ? (v ? 'on' : 'off') : String(v).toLowerCase());
  return 'eq' in c ? `${name} is ${value(c.eq)}` : `${name} isn't ${value(c.neq)}`;
}

function memberName(home: Home, id: string): string {
  return home.household.members.find((m) => m.id === id)?.name ?? id;
}
