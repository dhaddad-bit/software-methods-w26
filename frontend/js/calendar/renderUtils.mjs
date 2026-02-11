export function parseEventMs(value) {
  if (value === undefined || value === null || value === "") return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const str = String(value);
  if (str.match(/^\d+$/)) {
    const ms = Number(str);
    return Number.isFinite(ms) ? ms : null;
  }

  const dateOnly = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const ms = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? null : parsed;
}

export function processEventsForRender(events) {
  const list = Array.isArray(events) ? events : [];
  /** @type {any[]} */
  const out = [];

  for (const event of list) {
    if (!event) continue;

    const startMs = parseEventMs(event.startMs ?? event.start);
    const endMs = parseEventMs(event.endMs ?? event.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;

    const source = event.source || "google";
    const id = event.id ?? event.eventId ?? event.busyBlockId ?? "unknown";
    const baseKey = `${source}:${id}`;

    const fullStartMs = startMs;
    const fullEndMs = endMs;

    let segStartMs = startMs;
    let segIndex = 0;

    while (true) {
      const segStartDate = new Date(segStartMs);
      const nextMidnightMs = new Date(
        segStartDate.getFullYear(),
        segStartDate.getMonth(),
        segStartDate.getDate() + 1,
        0,
        0,
        0,
        0
      ).getTime();

      if (!(nextMidnightMs < endMs)) {
        out.push({
          ...event,
          start: segStartMs,
          end: endMs,
          startMs: segStartMs,
          endMs: endMs,
          fullStartMs,
          fullEndMs,
          renderKey: `${baseKey}|seg:${segIndex}`
        });
        break;
      }

      out.push({
        ...event,
        start: segStartMs,
        end: nextMidnightMs,
        startMs: segStartMs,
        endMs: nextMidnightMs,
        fullStartMs,
        fullEndMs,
        renderKey: `${baseKey}|seg:${segIndex}`
      });

      segStartMs = nextMidnightMs;
      segIndex += 1;
      if (segStartMs >= endMs) break;
    }
  }

  return out;
}

