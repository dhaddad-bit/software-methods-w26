function normalizePetition(petition) {
  if (!petition) return null;

  const startRaw = petition.start_time || petition.startTime || petition.startMs || petition.start;
  const endRaw = petition.end_time || petition.endTime || petition.endMs || petition.end;

  const startMs = typeof startRaw === "number" ? startRaw : Date.parse(startRaw);
  const endMs = typeof endRaw === "number" ? endRaw : Date.parse(endRaw);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  return {
    id: petition.id,
    groupId: petition.group_id || petition.groupId,
    createdByUserId: petition.created_by_user_id || petition.createdByUserId,
    title: petition.title || "Petitioned Meeting",
    status: petition.status || "OPEN",
    priority: petition.priority || "HIGHEST",
    startMs,
    endMs,
    acceptedCount: Number.parseInt(petition.acceptedCount ?? petition.accepted_count, 10) || 0,
    declinedCount: Number.parseInt(petition.declinedCount ?? petition.declined_count, 10) || 0,
    groupSize: Number.parseInt(petition.groupSize ?? petition.group_size, 10) || 0,
    currentUserResponse: petition.currentUserResponse || petition.current_user_response || null,
    groupName: petition.group_name || petition.groupName || null
  };
}

function statusClass(status) {
  if (status === "FAILED") return "petition-failed";
  if (status === "ACCEPTED_ALL") return "petition-accepted-all";
  return "petition-open";
}

export function renderPetitions({ root = document, petitions = [], onSelect } = {}) {
  root.querySelectorAll(".petition-block").forEach((el) => el.remove());

  const normalized = petitions.map(normalizePetition).filter(Boolean);
  if (normalized.length === 0) return;

  const cells = root.querySelectorAll(".calendar-cell");

  cells.forEach((cell) => {
    const day = cell.dataset.day;
    const dayMs = Number(cell.dataset.dayMs);
    const hour = Number(cell.dataset.hour);
    if ((!day && !Number.isFinite(dayMs)) || Number.isNaN(hour)) return;

    const cellStart = Number.isFinite(dayMs) ? new Date(dayMs) : new Date(day);
    cellStart.setHours(hour, 0, 0, 0);
    const cellEnd = new Date(cellStart);
    cellEnd.setHours(hour + 1, 0, 0, 0);

    normalized.forEach((petition) => {
      const overlapStartMs = Math.max(petition.startMs, cellStart.getTime());
      const overlapEndMs = Math.min(petition.endMs, cellEnd.getTime());
      if (overlapEndMs <= overlapStartMs) return;

      const overlay = document.createElement("div");
      overlay.className = `petition-block ${statusClass(petition.status)}`;

      const top = (overlapStartMs - cellStart.getTime()) / (1000 * 60);
      const height = (overlapEndMs - overlapStartMs) / (1000 * 60);
      overlay.style.top = `${top}px`;
      overlay.style.height = `${height}px`;

      overlay.dataset.petitionId = String(petition.id);
      overlay.dataset.status = petition.status;
      overlay.dataset.startMs = String(petition.startMs);
      overlay.dataset.endMs = String(petition.endMs);

      if (overlapStartMs === petition.startMs) {
        const summary = petition.groupSize
          ? `${petition.acceptedCount}/${petition.groupSize} accepted`
          : "";
        overlay.textContent = summary ? `${petition.title} (${summary})` : petition.title;
      }

      overlay.addEventListener("click", (event) => {
        event.stopPropagation();
        if (typeof onSelect === "function") {
          onSelect(petition);
        }
      });

      cell.appendChild(overlay);
    });
  });
}
