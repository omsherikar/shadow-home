import {
  compiledRuleSchema,
  isoDateTime,
  planActionSchema,
  presenceSpecSchema,
  valueSchema,
} from '@shadow-home/twin';
import { z } from 'zod';

const iso = z.string().describe('ISO 8601 time with offset, in the home time zone');
/** Times the caller sends must carry an offset, or they would be read in the server's time zone. */
const isoIn = isoDateTime.describe(
  'ISO 8601 time with a UTC offset, e.g. 2027-01-17T18:00:00-06:00',
);
const verdict = z.enum(['SAFE', 'UNSAFE', 'UNPROVEN']);
const tier = z.enum(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
const reversibility = z.enum(['holdable', 'compensable', 'irreversible']);
const member = z.string().describe('Household member ID, e.g. "om"');

export const speechSchema = z
  .object({
    headline: z.string().describe('At most 15 words'),
    reason: z.string().optional().describe('At most 25 words'),
    ask: z.string().optional().describe('The one question to ask, at most 25 words'),
  })
  .describe('What Alexa speaks from. Data, not a script.');

const diffRow = z.object({
  target: z.string(),
  name: z.string(),
  kind: z.enum(['device', 'mode', 'routine']),
  attr: z.string(),
  from: valueSchema.nullable(),
  to: valueSchema,
  at: iso,
  actionIndex: z.number().int(),
  group: z.string().optional(),
  reversibility,
});

const timelineEntry = z.object({
  at: iso,
  source: z.string().describe('"plan", a routine ID, or what scheduled it'),
  actionIndex: z.number().int().optional(),
  device: z.string(),
  attr: z.string(),
  from: valueSchema.nullable(),
  to: valueSchema,
});

const violation = z.object({
  rule: z.string(),
  text: z.string(),
  author: z.string(),
  priority: z.enum(['life-safety', 'security', 'device-protection', 'comfort']),
  refuse: z.boolean().optional(),
  run: z.enum(['nominal', 'pessimistic', 'optimistic']),
  firstAt: iso,
  cause: timelineEntry.optional(),
});

const invalid = z.object({
  code: z.string(),
  actionIndex: z.number().int().nullable(),
  message: z.string(),
});

const alternative = z.object({
  planId: z.string(),
  verdict,
  tier,
  diff: z.array(diffRow),
});

export const previewOutput = z.object({
  planId: z.string().describe('Signed; pass to commit_plan within 5 minutes'),
  expiresAt: z.string().describe('Wall-clock expiry, ISO 8601 UTC'),
  stateVersion: z.number().int(),
  kind: z.enum(['plan', 'repair', 'safe_part', 'undo']),
  verdict,
  tier,
  tierWhy: z.string(),
  affects: z.array(member),
  speech: speechSchema,
  diff: z.array(diffRow),
  timeline: z.array(timelineEntry),
  violations: z.array(violation).describe('Broken rules, most important first'),
  invalid: z.array(invalid).describe('Why lint rejected the plan'),
  unknowns: z.array(z.string()),
  horizon: z.object({ start: iso, end: iso }),
  repair: alternative
    .extend({
      changes: z.array(z.object({ rule: z.string(), kind: z.string(), description: z.string() })),
    })
    .nullable()
    .describe('A version of the plan that fixes what broke, with its own plan ID'),
  safePart: alternative
    .extend({ dropped: z.array(z.number().int()) })
    .nullable()
    .describe('Just the actions that are SAFE on their own, with its own plan ID'),
});
export type PreviewOutput = z.infer<typeof previewOutput>;

export const previewInput = z.object({
  actions: z
    .array(planActionSchema)
    .min(1)
    .describe(
      'Device or group writes ({ device, set, at? }), routine pauses ({ routine, pauseUntil }) and mode changes ({ mode, at? }). Without `at`, an action runs now.',
    ),
  intent: z.string().min(1).describe('What the person asked for, in their words'),
  requestedBy: member.optional(),
  presenceSchedule: z
    .array(z.object({ from: isoIn, to: isoIn, presence: presenceSpecSchema }))
    .optional()
    .describe('Who will be home when, if the request says ("away until Sunday")'),
  planEnd: isoIn.optional().describe('When the plan stops mattering ("until Sunday 6 PM")'),
});

const logChange = z.object({
  target: z.string(),
  attr: z.string(),
  from: valueSchema.nullable(),
  to: valueSchema,
});

export const commitInput = z.object({
  planId: z.string().min(1),
  confirmed: z
    .boolean()
    .optional()
    .describe('The person said yes to the question the preview asked (T2 and T4)'),
  safePartOnly: z.boolean().optional().describe("Commit only the preview's safe part"),
});

export const commitOutput = z.object({
  status: z.enum(['committed', 'needs_confirmation', 'refused']),
  reason: z
    .enum([
      'tampered',
      'expired',
      'state_changed',
      'unknown_plan',
      'unsafe',
      'refused_by_rule',
      'irreversible_needs_safe',
      'no_safe_part',
    ])
    .optional(),
  planId: z.string().describe('The plan ID that was (or would be) committed'),
  speech: speechSchema,
  applied: z.array(logChange),
  held: z.array(logChange).describe('Writes scheduled for later; they can still be cancelled'),
  undoToken: z.string().optional(),
  logEntryId: z.string().optional(),
  alternatives: z
    .object({ repairPlanId: z.string().optional(), safePartPlanId: z.string().optional() })
    .optional(),
  freshPreview: previewOutput.optional().describe('Given when the old plan ID went stale'),
});
export type CommitOutput = z.infer<typeof commitOutput>;

export const undoInput = z.object({
  token: z.string().min(1).describe('An undo token from commit_plan, or "last"'),
  devices: z.array(z.string()).optional().describe('Only put these back ("undo the thermostat")'),
});

export const undoOutput = z.object({
  status: z.enum(['preview', 'nothing_to_undo']),
  undoOf: z.string().optional().describe('The log entry being undone'),
  preview: previewOutput
    .optional()
    .describe('Commit its planId with commit_plan to apply the undo'),
  cannotUndo: z.array(z.object({ target: z.string(), attr: z.string(), why: z.string() })),
  notes: z.array(z.string()),
  speech: speechSchema,
});
export type UndoOutput = z.infer<typeof undoOutput>;

export const homeStateInput = z.object({
  room: z.string().optional().describe('Only devices in this room'),
});

export const homeStateOutput = z.object({
  now: iso,
  mode: z.string(),
  stateVersion: z.number().int(),
  presence: z.record(z.string(), z.enum(['home', 'away'])),
  zones: z.array(z.object({ id: z.string(), name: z.string(), tempC: z.number() })),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      room: z.string(),
      kind: z.string(),
      state: z.record(z.string(), valueSchema),
      sensor: z
        .object({
          batteryPercent: z.number().describe('0 to 100').nullable(),
          minutesSinceReport: z.number(),
          trusted: z.boolean(),
          why: z.string().optional(),
        })
        .optional(),
    }),
  ),
  routines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      owner: member,
      enabled: z.boolean(),
      at: z.string(),
      pausedUntil: iso.optional(),
    }),
  ),
  scheduled: z.array(
    z.object({
      device: z.string(),
      set: z.record(z.string(), valueSchema),
      at: iso,
      source: z.string(),
    }),
  ),
});
export type HomeStateOutput = z.infer<typeof homeStateOutput>;

export const logInput = z.object({
  from: isoIn.optional(),
  to: isoIn.optional(),
  person: member.optional(),
  groupBy: z.enum(['cause', 'none']).optional().describe('Default: cause'),
});

const logEntry = z.object({
  id: z.string(),
  at: iso,
  who: z.string(),
  source: z.enum(['plan', 'undo', 'routine', 'scheduled']),
  what: z.string(),
  cause: z.string().optional(),
  verdict: verdict.optional(),
  tier: tier.optional(),
  changes: z.array(logChange),
  undoable: z.boolean(),
  undoToken: z.string().optional(),
  undoneBy: z.string().optional(),
});

export const logOutput = z.object({
  entries: z.array(logEntry),
  groups: z.array(
    z.object({ cause: z.string(), label: z.string(), entryIds: z.array(z.string()) }),
  ),
});
export type LogOutput = z.infer<typeof logOutput>;

export const addRuleInput = z.object({
  text: z.string().min(1).describe('The rule in the person’s words'),
  author: member,
  rule: compiledRuleSchema
    .optional()
    .describe('The compiled rule. Without it the server needs its rule compiler.'),
});

export const addRuleOutput = z.object({
  status: z.enum(['added', 'pending_owner_approval', 'invalid', 'needs_compiler']),
  ruleId: z.string().optional(),
  readBack: z.string().optional(),
  problems: z.array(z.string()),
  conflicts: z.array(
    z.object({
      rule: z.string(),
      text: z.string(),
      priority: z.string(),
      winner: z.string().describe('The rule that wins when both apply'),
    }),
  ),
  sampleDay: z
    .object({ verdict, brokenAt: iso.optional() })
    .optional()
    .describe('The next 24 hours of the home as it is, checked against the new rule'),
  needsOwnerApproval: z.boolean(),
  speech: speechSchema,
});
export type AddRuleOutput = z.infer<typeof addRuleOutput>;

export const approveInput = z.object({ planId: z.string().min(1) });
export const approveOutput = z.object({
  status: z.enum(['approved', 'refused']),
  reason: z.enum(['tampered', 'expired', 'unknown_plan']).optional(),
  planId: z.string(),
  approvedAt: z.string().optional(),
});
export type ApproveOutput = z.infer<typeof approveOutput>;
