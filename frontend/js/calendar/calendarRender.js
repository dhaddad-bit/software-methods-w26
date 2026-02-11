import { parseEventMs, processEventsForRender } from "./renderUtils.mjs";

function eventKey(event) {
  if (event?.renderKey) return event.renderKey;
  const source = event?.source || "google";
  const id = event?.id ?? event?.eventId ?? event?.busyBlockId ?? "unknown";
  return `${source}:${id}`;
}

function parseEventDate(value) {
  const ms = parseEventMs(value);
  return ms === null ? null : new Date(ms);
}

export { processEventsForRender };

function computeDayLayout(dayEvents) {
  // dayEvents: { event, startMs, endMs }[]
  const sorted = dayEvents
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const clusters = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  for (const item of sorted) {
    if (cluster.length === 0) {
      cluster = [item];
      clusterEnd = item.endMs;
      continue;
    }

    if (item.startMs < clusterEnd) {
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMs);
    } else {
      clusters.push(cluster);
      cluster = [item];
      clusterEnd = item.endMs;
    }
  }
  if (cluster.length > 0) clusters.push(cluster);

  for (const group of clusters) {
    const columnsEndMs = [];
    for (const item of group) {
      let colIndex = 0;
      while (colIndex < columnsEndMs.length && columnsEndMs[colIndex] > item.startMs) {
        colIndex += 1;
      }
      if (colIndex === columnsEndMs.length) {
        columnsEndMs.push(item.endMs);
      } else {
        columnsEndMs[colIndex] = item.endMs;
      }
      item.colIndex = colIndex;
    }

    const colCount = Math.max(1, columnsEndMs.length);
    for (const item of group) {
      item.colCount = colCount;
    }
  }

  return sorted;
}

export async function renderCalendarGrid(container, weekStart, events, options = {}) {
  // container.innerHTML = "";
  const onEventClick = typeof options.onEventClick === "function" ? options.onEventClick : null;

  // Configuration
  const START_HOUR = 0;
  const END_HOUR = 23; // 9 PM

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }

  const rawEvents = processEventsForRender(events);
  const layoutByKey = new Map();
  const startsByCell = new Map(); // dayKey|hour -> [eventRenderItem]

  // Compute per-day overlap layout.
  days.forEach((day) => {
    const dayKey = day.toDateString();
    const dayEvents = [];

    rawEvents.forEach((event) => {
      const startDate = parseEventDate(event.start);
      const endDate = parseEventDate(event.end);
      if (!startDate || !endDate) return;
      if (endDate.getTime() <= startDate.getTime()) return;

      if (startDate.toDateString() !== dayKey) return;

      dayEvents.push({
        event,
        startMs: startDate.getTime(),
        endMs: endDate.getTime(),
        startDate,
        endDate
      });
    });

    const laidOut = computeDayLayout(dayEvents);
    laidOut.forEach((item) => {
      const key = eventKey(item.event);
      layoutByKey.set(key, { colIndex: item.colIndex ?? 0, colCount: item.colCount ?? 1 });

      const hour = item.startDate.getHours();
      const cellKey = `${dayKey}|${hour}`;
      const bucket = startsByCell.get(cellKey) ?? [];
      bucket.push(item);
      startsByCell.set(cellKey, bucket);
    });
  });

  const grid = document.createElement("div");
  grid.className = "calendar-grid";

  grid.appendChild(document.createElement("div"));

  days.forEach(day => {
    const header = document.createElement("div");
    header.className = "day-header";
    header.textContent = day.toLocaleDateString("default", {
      weekday: "short",
      month: "numeric",
      day: "numeric"
    });
    grid.appendChild(header);
  });


  for (let hour = START_HOUR; hour <= END_HOUR; hour++) {
      const timeLabel = document.createElement("div");
      timeLabel.className = "time-label";
      timeLabel.textContent = `${hour}:00`;
      grid.appendChild(timeLabel);

    days.forEach(day => {
      const cell = document.createElement("div");
      cell.className = "calendar-cell";
      cell.dataset.day = day.toDateString();
      cell.dataset.dayMs = day.getTime();
      cell.dataset.hour = hour;

      const cellEvents = startsByCell.get(`${day.toDateString()}|${hour}`) ?? [];
      cellEvents.forEach((item) => {
        const event = item.event;
        const start = item.startDate;
        const end = item.endDate;

        const startMins = start.getMinutes();
        const duration = (end.getTime() - start.getTime()) / (1000 * 60);

        const eventDiv = document.createElement("div");
        eventDiv.className = "calendar-event";
        const label = document.createElement("div");
        label.className = "event-description";
        label.textContent = event.title || "No Title";
        eventDiv.appendChild(label);

        const source = event.source || "google";
        const blockingLevel = (event.blockingLevel || "B3").toLowerCase();
        eventDiv.classList.add(`source-${source}`);
        eventDiv.classList.add(`blocking-${blockingLevel}`);

        eventDiv.dataset.source = source;
        eventDiv.dataset.itemId = String(event.id ?? "");
        eventDiv.dataset.blockingLevel = String(event.blockingLevel || "B3");

        const key = eventKey(event);
        const layout = layoutByKey.get(key) || { colIndex: 0, colCount: 1 };
        const colCount = Math.max(1, layout.colCount || 1);
        const colIndex = Math.max(0, layout.colIndex || 0);

        const colWidth = 100 / colCount;
        eventDiv.style.left = `${colIndex * colWidth}%`;
        eventDiv.style.width = `${colWidth}%`;

        // set event height and starting position
        eventDiv.style.height = `${duration}px`;
        eventDiv.style.top = `${startMins}px`;

        if (onEventClick) {
          eventDiv.addEventListener("click", (evt) => {
            evt.stopPropagation();
            onEventClick(event, eventDiv);
          });
        }

        cell.appendChild(eventDiv);
      });

      grid.appendChild(cell);
    });
}


  container.appendChild(grid);
}
