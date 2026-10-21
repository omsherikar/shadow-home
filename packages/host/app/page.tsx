import { demoSteps } from '@/demo/steps.ts';
import { Device } from '@/device/Device.tsx';
import { loadBeats } from '@/turn/beats.ts';

export const dynamic = 'force-dynamic';

/**
 * DEMO_MODE=1 adds "Play the demo", which replays fixtures/demo-script.json start to finish.
 * SHADOW_HOME_SILENT=1 keeps the device quiet (browser tests); there, a page opened with
 * `?speak=1` speaks after all, for the one test that checks the voice with /api/speak stubbed.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const beats = await loadBeats();
  const { speak } = await searchParams;
  return (
    <Device
      suggestions={beats.flatMap((b) => [b.say].flat())}
      demo={process.env.DEMO_MODE === '1' ? demoSteps(beats) : null}
      silent={process.env.SHADOW_HOME_SILENT === '1' && speak !== '1'}
    />
  );
}
