import { describe, expect, test } from 'vitest';
import { stopGracefully } from './shutdown.ts';

/** A server whose in-flight requests finish when the test says, and a process stand-in. */
function setup(graceMs: number) {
  let finish: (() => void) | undefined;
  const server = {
    closed: false,
    close(done: () => void) {
      server.closed = true;
      finish = done;
    },
  };
  const exits: number[] = [];
  let onTerm: (() => void) | undefined;
  stopGracefully(server, {
    graceMs,
    exit: (code) => exits.push(code),
    on: (_signal, fn) => {
      onTerm = fn;
    },
  });
  return { server, exits, term: () => onTerm?.(), finish: () => finish?.() };
}

describe('stopping on SIGTERM', () => {
  test('takes no new requests, lets those in flight finish, then exits', () => {
    const { server, exits, term, finish } = setup(1000);
    expect(server.closed).toBe(false);
    term();
    expect(server.closed).toBe(true);
    expect(exits).toEqual([]);
    finish();
    expect(exits).toEqual([0]);
  });

  test('a request still running when the grace is up is cut off', async () => {
    const { exits, term } = setup(20);
    term();
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toEqual([0]);
  });
});
