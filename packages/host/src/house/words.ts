/**
 * What the house says in plain words while it plays: each change as it happens ("Garage freezer
 * off"), and at the end what each run came to ("Your plan: 4 house rules break; the garage drops
 * below 4 °C Sat 10:37 PM."). Only from the run itself: its changes, its breaks, its temperature
 * rules and its trace.
 */

/** "dishwasher_latch: battery 4% …" with the device's own name: "Dishwasher door latch: …". */
export function readable(text: string, name: (id: string) => string | undefined): string {
  return text.replace(/^([a-z0-9_]+):/, (whole, id: string) => {
    const n = name(id);
    return n ? `${n}:` : whole;
  });
}
