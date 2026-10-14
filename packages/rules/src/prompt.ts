import { attrDomain, type Capability, type Home } from '@shadow-home/twin';

/**
 * What the compiler model is told: the five templates, how conditions are written, the
 * priorities, this home's devices with the values each attribute takes, and the home's own rules
 * as worked examples. It is never shown plans or verdicts; it only translates.
 */
export function compilerPrompt(home: Home): string {
  const rooms = new Map(home.rooms.map((r) => [r.id, r.name]));
  const devices = home.devices
    .map((d) => {
      const attrs = Object.keys(d.state)
        .map((a) => `${a} ${domainText(attrDomain(d, a))}`)
        .join('; ');
      return `- ${d.id}: ${d.name} (${rooms.get(d.room) ?? d.room}${d.outdoor ? ', outdoor' : ''}). ${attrs}`;
    })
    .join('\n');
  const zones = home.zones.map((z) => `- ${z.id}: ${z.name}`).join('\n');
  const members = home.household.members.map((m) => `- ${m.id}: ${m.name} (${m.role})`).join('\n');
  const examples = home.rules
    .map((r) => {
      const { id: _id, text, author: _a, source: _s, hash: _h, ...compiled } = r;
      return `"${text}"\n${JSON.stringify(compiled)}`;
    })
    .join('\n\n');

  return `You turn one house rule, in a household member's own words, into exactly one of five rule templates for this home. You only translate: never add conditions, devices or exceptions the person didn't say, and never drop one they did.

Templates (params as JSON):
- always: params {"state": S}. Broken whenever S is false. "Never turn off the freezer" is always {freezer onOff eq true}.
- never_when: params {"x": C, "when": C}. Broken whenever x and when both hold. "Front door locked when nobody's home" is never x = {lock eq UNLOCKED} when {presence nobody}.
- keep_between: params {"quantity": {"zone": Z, "attr": "temperatureC"}, "min": number or null, "max": number or null, "when": C or null}. A zone's temperature in °C stays in range (convert °F to °C, one decimal). Use null for an open end and for "always".
- within_after: params {"minutes": n, "after": C, "ensure": [S, ...]}. Once "after" has held for more than n minutes, every state in ensure must hold.
- never_together: params {"a": C, "b": C}. Broken whenever a and b both hold.

Conditions:
- S, a device state: {"device": id, "attr": attribute, "eq": value} or {"device": id, "attr": attribute, "neq": value}. Values are exactly as listed below (true/false for on/off, enum strings in their case).
- C is S, or {"presence": "nobody"}, {"presence": "anyone"}, {"presence": {"member": id, "is": "home" | "away"}}, {"time": {"from": "HH:MM", "to": "HH:MM"}} (24-hour, home time, may cross midnight), {"any": [C, ...]}, {"all": [C, ...]}, {"not": C}.

Priority, by what the rule protects (pick one):
- life-safety: fire, smoke, heat sources, someone getting hurt
- security: locks, doors, anyone getting in
- device-protection: appliances, pipes, pets' equipment, food spoiling
- comfort: everything else (lights, temperature for comfort, noise)
Set "refuse": true only when the person says it can never happen under any circumstances, even with a yes; otherwise leave it out.

If the sentence isn't a standing rule, names something this home doesn't have, or can't be said with these templates, set "rule" to null and give the reason in "unsupported" (one short sentence). Otherwise set "unsupported" to null.

Devices (id: name (room). attribute values):
${devices}

Temperature zones:
${zones}

Household:
${members}

This home's rules, compiled (follow the same style):

${examples}`;
}

function domainText(cap: Capability | undefined): string {
  if (!cap) return '(any)';
  if (cap.type === 'boolean') return 'true | false';
  if (cap.type === 'enum') return cap.values.join(' | ');
  return `${cap.min} to ${cap.max}`;
}
