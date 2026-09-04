/** Resolve a wall-clock time in an IANA zone without depending on the host timezone. */
export function resolveEventTime(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(
    value,
  );
  if (!match) throw new Error("Use a date and time such as 2026-09-05T20:00:00.");
  const [, y, m, d, h, min, sec = "00", offset] = match;
  const wall = Date.UTC(+y, +m - 1, +d, +h, +min, +sec);
  const expected = `${y}-${m}-${d}T${h}:${min}:${sec}`;
  if (new Date(wall).toISOString().slice(0, 19) !== expected) {
    throw new Error("That date or time is not valid.");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(
      "Which timezone should I use? Please use a city timezone such as America/Vancouver.",
    );
  }
  const local = (instant: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  if (offset) {
    const instant = Date.parse(`${expected}${offset}`);
    if (!Number.isFinite(instant) || local(instant) !== expected) {
      throw new Error("The UTC offset does not match that local time and timezone.");
    }
    return new Date(instant).toISOString();
  }
  // Sampling either side of the date discovers both offsets at a DST transition.
  const candidates = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = wall + hours * 3_600_000;
    const zoneOffset = Date.parse(`${local(sample)}Z`) - sample;
    const instant = wall - zoneOffset;
    if (local(instant) === expected) candidates.add(instant);
  }
  if (candidates.size === 0) {
    throw new Error(
      "That local time does not exist because the clocks move forward. Choose another time.",
    );
  }
  if (candidates.size > 1) {
    throw new Error(
      "That local time happens twice because the clocks move back. Specify the UTC offset.",
    );
  }
  return new Date([...candidates][0]).toISOString();
}
