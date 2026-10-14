import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bedrockModel } from '../src/turn/bedrock.ts';
import { DEMO_URL } from '../src/turn/demo-clock.ts';
import { connectTools } from '../src/turn/mcp.ts';
import { liveModel } from '../src/turn/providers.ts';
import { runTurn } from '../src/turn/run.ts';
import { type Beat, type RecordedPlan, recordedFrom } from '../src/turn/scripted.ts';

/**
 * Records what a real model drafts for each demo request, for demo mode to replay with no model
 * calls. Needs the server running with its demo controls (npm run dev) and a live model:
 * ANTHROPIC_API_KEY, or Bedrock with MODEL_PROVIDER=bedrock (AWS_PROFILE, default shadow-home).
 * Writes `recordedPlan` into fixtures/demo-script.json.
 */
const path = join(import.meta.dirname, '../../../fixtures/demo-script.json');
const script = JSON.parse(readFileSync(path, 'utf8')) as { beats: Beat[] };

await fetch(`${DEMO_URL}/reset`, { method: 'POST' });
for (const beat of script.beats) {
  if (!beat.draftPlanExample) continue;
  if (beat.context?.now) {
    await fetch(`${DEMO_URL}/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: beat.context.now }),
    });
  }
  const tools = await connectTools();
  try {
    const model = bedrockModel({
      ...(await liveModel()),
      tools: tools.modelTools,
      home: await tools.homeBrief(),
      ...(tools.instructions ? { serverInstructions: tools.instructions } : {}),
    });
    const line = [beat.say].flat()[0] ?? '';
    const turn = await runTurn(model, tools, { text: line, history: [] });
    const recorded: RecordedPlan | null = recordedFrom(turn.calls);
    if (!recorded) {
      console.log(`${beat.id}: the model didn't call preview_plan (it said: ${turn.say})`);
      continue;
    }
    beat.recordedPlan = recorded;
    console.log(`${beat.id}: recorded ${recorded.actions.length} actions`);
  } finally {
    await tools.close();
  }
}
writeFileSync(path, `${JSON.stringify(script, null, 2)}\n`);
// The repo's formatter, so the fixture reads (and lints) the way it did before.
execFileSync(join(import.meta.dirname, '../../../node_modules/.bin/biome'), [
  'format',
  '--write',
  path,
]);
