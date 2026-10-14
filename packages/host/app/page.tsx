import { Device } from '@/device/Device.tsx';
import { loadBeats } from '@/turn/beats.ts';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const beats = await loadBeats();
  return <Device suggestions={beats.flatMap((b) => [b.say].flat())} />;
}
