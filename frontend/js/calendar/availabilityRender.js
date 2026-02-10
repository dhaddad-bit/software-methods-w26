import { mockAvailability } from "./availabilityMock.js";

function normalizeSlot(slot) {
  if (!slot) return null;
  if (typeof slot.startMs === "number" && typeof slot.endMs === "number") {
    return {
      start: new Date(slot.startMs),
      end: new Date(slot.endMs),
      availabilityFraction:
        typeof slot.availabilityFraction === "number" ? slot.availabilityFraction : null,
      availableCount: Number.isFinite(slot.availableCount) ? slot.availableCount : null,
      totalCount: Number.isFinite(slot.totalCount) ? slot.totalCount : null
    };
  }
  if (slot.start && slot.end) {
    return {
      start: new Date(slot.start),
      end: new Date(slot.end),
      availabilityFraction:
        typeof slot.availabilityFraction === "number" ? slot.availabilityFraction : null,
      availableCount: Number.isFinite(slot.availableCount) ? slot.availableCount : null,
      totalCount: Number.isFinite(slot.totalCount) ? slot.totalCount : null
    };
  }
  return null;
}

export function renderAvailability(options = {}) {
  const root = options.root || document;
  const slots = Array.isArray(options.slots) ? options.slots : mockAvailability;
  const minFraction = typeof options.minFraction === "number" ? options.minFraction : 0;
  const interactive = Boolean(options.interactive);

  const cells = root.querySelectorAll(".calendar-cell");
  root.querySelectorAll(".availability-block").forEach((el) => el.remove());

  const normalizedSlots = slots.map(normalizeSlot).filter(Boolean);

  cells.forEach((cell) => {
    const day = cell.dataset.day;
    const dayMs = Number(cell.dataset.dayMs);
    const hour = Number(cell.dataset.hour);
    if ((!day && !Number.isFinite(dayMs)) || Number.isNaN(hour)) return;

    const cellStart = Number.isFinite(dayMs) ? new Date(dayMs) : new Date(day);
    cellStart.setHours(hour, 0, 0, 0);
    const cellEnd = new Date(cellStart);
    cellEnd.setHours(hour + 1, 0, 0, 0);

    normalizedSlots.forEach((slot) => {
      const fraction = slot.availabilityFraction;
      if (typeof fraction === "number" && fraction < minFraction) return;

      const overlapStartMs = Math.max(slot.start.getTime(), cellStart.getTime());
      const overlapEndMs = Math.min(slot.end.getTime(), cellEnd.getTime());
      if (overlapEndMs <= overlapStartMs) return;

      const overlay = document.createElement("div");
      overlay.className = "availability-block availability-slot";

      const top = (overlapStartMs - cellStart.getTime()) / (1000 * 60);
      const height = (overlapEndMs - overlapStartMs) / (1000 * 60);
      overlay.style.top = `${top}px`;
      overlay.style.height = `${height}px`;

      if (typeof fraction === "number") {
        if (fraction === 0) {
          overlay.classList.add("unavailable");
        } else {
          const alpha = Math.min(0.85, 0.15 + 0.7 * fraction);
          overlay.style.backgroundColor = `rgba(76, 175, 80, ${alpha})`;
        }
      } else {
        overlay.style.top = "0";
        overlay.style.height = "100%";
      }

      const slotStartMs = slot.start.getTime();
      const slotEndMs = slot.end.getTime();
      overlay.dataset.startMs = String(slotStartMs);
      overlay.dataset.endMs = String(slotEndMs);
      if (slot.availableCount !== null) {
        overlay.dataset.availableCount = String(slot.availableCount);
      }
      if (slot.totalCount !== null) {
        overlay.dataset.totalCount = String(slot.totalCount);
      }

      const isFullyFree =
        slot.availableCount !== null &&
        slot.totalCount !== null &&
        slot.availableCount === slot.totalCount;

      if (interactive && isFullyFree) {
        overlay.classList.add("selectable");
      }

      if (slot.availableCount !== null && slot.totalCount !== null) {
        overlay.title = `${slot.availableCount}/${slot.totalCount} available`;
      }

      cell.appendChild(overlay);
    });
  });
}
