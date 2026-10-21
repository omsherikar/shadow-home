import { describe, expect, test } from 'vitest';
import {
  drawsInSoftware,
  type Judging,
  judge,
  NEW_PLAYBACK,
  paceFrom,
  SLOW_FRAME_MS,
  showsEnds,
} from './pace.ts';

describe('the pace of a playback', () => {
  test('a GPU at the display’s refresh plays it, whatever its first frame cost', () => {
    expect(paceFrom([400, 17, 16, 17])).toBe('animate');
    expect(paceFrom([16, 33, 17, 50])).toBe('animate');
  });

  test('software WebGL, at a second or more a frame, shows the end after two frames', () => {
    // CI's Chromium: the first gap with the twin's shaders, then 2.8 s and 1.6 s.
    expect(paceFrom([2900, 2800, 1600])).toBe('still');
  });

  test('frames past the limit, but not by much, are judged on three', () => {
    expect(paceFrom([20, 200, 180])).toBe('unsure');
    expect(paceFrom([20, 200, 180, 220])).toBe('still');
  });

  test('one slow frame among fast ones doesn’t stop the playback', () => {
    expect(paceFrom([20, 900, 17, 18])).toBe('animate');
    expect(paceFrom([20, 17, 900, 18])).toBe('animate');
  });

  test('the first gap alone, however long, settles nothing', () => {
    expect(paceFrom([])).toBe('unsure');
    expect(paceFrom([30_000])).toBe('unsure');
    expect(paceFrom([30_000, 17])).toBe('unsure');
  });

  test('right at the limit still plays; just past it doesn’t', () => {
    expect(paceFrom([0, SLOW_FRAME_MS, SLOW_FRAME_MS, SLOW_FRAME_MS])).toBe('animate');
    expect(paceFrom([0, SLOW_FRAME_MS + 1, SLOW_FRAME_MS + 1, 10])).toBe('still');
  });
});

describe('a renderer that draws on the CPU', () => {
  test('is known by its name', () => {
    expect(
      drawsInSoftware(
        'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
      ),
    ).toBe(true);
    expect(drawsInSoftware('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(drawsInSoftware('Microsoft Basic Render Driver')).toBe(true);
  });

  test('a GPU isn’t one', () => {
    expect(
      drawsInSoftware('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'),
    ).toBe(false);
    expect(
      drawsInSoftware('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)'),
    ).toBe(false);
    expect(drawsInSoftware('WebKit WebGL')).toBe(false);
  });
});

describe('each playback finds its own pace', () => {
  const played = (gapsMs: number[]): Judging => gapsMs.reduce(judge, NEW_PLAYBACK);

  test('a slow first playback, then a fast second one: the second sweeps', () => {
    // A stall at the start (a shader built, a recording starting) costs the first its sweep.
    const first = played([30, 900, 1200, 16, 17]);
    expect(showsEnds(first.pace, false, false)).toBe(true);
    // Nothing carries over: the next playback is judged on its own frames.
    const second = played([30, 17, 16, 17]);
    expect(showsEnds(second.pace, false, false)).toBe(false);
  });

  test('once found, later frames don’t change it', () => {
    const fast = played([30, 17, 16, 17]);
    expect(fast.pace).toBe('animate');
    expect(judge(fast, 5000)).toBe(fast);
    expect(played([30, 17, 16, 17, 5000, 5000, 5000]).pace).toBe('animate');
  });

  test('software WebGL always shows where each run ends, however fast its frames', () => {
    for (const pace of ['unsure', 'animate', 'still'] as const) {
      expect(showsEnds(pace, false, true)).toBe(true);
    }
    expect(showsEnds(played([16, 16, 16, 16]).pace, false, true)).toBe(true);
  });

  test('so does less motion asked for', () => {
    expect(showsEnds('animate', true, false)).toBe(true);
  });
});
