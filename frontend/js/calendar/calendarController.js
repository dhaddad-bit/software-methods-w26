import { renderCalendarGrid } from "./calendarRender.js";
import { renderPetitions } from "./petitionRender.js";
import { apiGet, apiPost, apiDelete } from "../api/api.js";

let currentWeekStart = getStartOfWeek(new Date());
let currentUserId = null;
let selectedPetition = null;
let petitionsCache = [];

function getStartOfWeek(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekWindow(weekStart) {
  const start = new Date(weekStart);
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function formatDateTimeLocal(msOrDate) {
  const date = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function parseDateTimeLocal(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

async function ensureCurrentUser() {
  if (currentUserId) return;
  const me = await apiGet("/api/me");
  if (me && me.id) {
    currentUserId = me.id;
  }
}

function formatPetitionTime(petition) {
  const start = new Date(petition.startMs);
  const end = new Date(petition.endMs);
  return `${start.toLocaleString()} → ${end.toLocaleTimeString()}`;
}

function buildActionBar(container, onAction) {
  const bar = document.createElement("div");
  bar.className = "petition-action-bar";
  container.appendChild(bar);

  const update = () => {
    bar.innerHTML = "";
    if (!selectedPetition) {
      bar.textContent = "Select a petition to respond.";
      return;
    }

    const info = document.createElement("div");
    info.className = "petition-action-info";
    info.textContent = `${selectedPetition.title} • ${selectedPetition.status} • ${formatPetitionTime(
      selectedPetition
    )}`;

    const actions = document.createElement("div");
    actions.className = "petition-action-buttons";

    if (selectedPetition.status !== "FAILED") {
      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = "Accept";
      acceptBtn.onclick = () => onAction("ACCEPT");

      const declineBtn = document.createElement("button");
      declineBtn.textContent = "Decline";
      declineBtn.onclick = () => onAction("DECLINE");

      actions.appendChild(acceptBtn);
      actions.appendChild(declineBtn);
    }

    if (
      selectedPetition.status === "FAILED" &&
      currentUserId &&
      selectedPetition.createdByUserId === currentUserId
    ) {
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.onclick = () => onAction("DELETE");
      actions.appendChild(deleteBtn);
    }

    bar.appendChild(info);
    bar.appendChild(actions);
  };

  return { bar, update };
}

export async function renderCalendar() {
  const container = document.getElementById("calendar");
  container.innerHTML = "";

  await ensureCurrentUser();
  selectedPetition = null;

  const header = document.createElement("div");
  header.className = "calendar-header";

  const prev = document.createElement("button");
  prev.textContent = "← Prev";
  prev.onclick = () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    renderCalendar();
  };

  const next = document.createElement("button");
  next.textContent = "Next →";
  next.onclick = () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    renderCalendar();
  };

  const title = document.createElement("h2");
  title.textContent = currentWeekStart.toLocaleString("default", {
    month: "long",
    year: "numeric"
  });

  header.append(prev, title, next);
  container.appendChild(header);

  const layout = document.createElement("div");
  layout.className = "calendar-layout";
  container.appendChild(layout);

  const gridContainer = document.createElement("div");
  gridContainer.className = "calendar-grid-wrapper";
  layout.appendChild(gridContainer);

  const panel = document.createElement("div");
  panel.className = "event-panel";
  layout.appendChild(panel);
  panel.addEventListener("click", (evt) => evt.stopPropagation());

  let selectedItem = null;
  let selectedEls = [];
  let isSubmittingCreateBusyBlock = false;

  const panelTitle = document.createElement("h3");
  panelTitle.textContent = "Event / Busy Block";

  const panelMessage = document.createElement("div");
  panelMessage.className = "event-panel-message";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.placeholder = "Title";
  titleInput.className = "event-panel-input";

  const startInput = document.createElement("input");
  startInput.type = "datetime-local";
  startInput.className = "event-panel-input";

  const endInput = document.createElement("input");
  endInput.type = "datetime-local";
  endInput.className = "event-panel-input";

  const levelSelect = document.createElement("select");
  levelSelect.className = "event-panel-select";
  [
    { value: "B1", label: "B1 — Low (ignorable)" },
    { value: "B2", label: "B2 — Medium" },
    { value: "B3", label: "B3 — High (strict busy)" },
  ].forEach((level) => {
    const option = document.createElement("option");
    option.value = level.value;
    option.textContent = level.label;
    levelSelect.appendChild(option);
  });
  levelSelect.value = "B3";

  const buttonRow = document.createElement("div");
  buttonRow.className = "event-panel-buttons";

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.textContent = "New Busy Block";

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.textContent = "Create Busy Block";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save Changes";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.textContent = "Delete";

  const savePriorityBtn = document.createElement("button");
  savePriorityBtn.type = "button";
  savePriorityBtn.textContent = "Save Blocking Level";

  buttonRow.append(newBtn, createBtn, saveBtn, savePriorityBtn, deleteBtn);

  panel.appendChild(panelTitle);
  panel.appendChild(panelMessage);
  panel.appendChild(titleInput);
  panel.appendChild(startInput);
  panel.appendChild(endInput);
  panel.appendChild(levelSelect);
  panel.appendChild(buttonRow);

  const setPanelMessage = (message, isError = false) => {
    panelMessage.textContent = message || "";
    panelMessage.dataset.type = isError ? "error" : "info";
  };

  const clearSelection = () => {
    selectedItem = null;
    selectedEls.forEach((el) => el.classList.remove("selected"));
    selectedEls = [];
    setPanelMessage("");
    titleInput.disabled = false;
    startInput.disabled = false;
    endInput.disabled = false;
    titleInput.value = "";
    startInput.value = "";
    endInput.value = "";
    levelSelect.value = "B3";
    createBtn.hidden = false;
    saveBtn.hidden = true;
    deleteBtn.hidden = true;
    savePriorityBtn.hidden = true;
  };

  const setSelection = (item, el) => {
    selectedEls.forEach((candidate) => candidate.classList.remove("selected"));
    selectedItem = item;
    selectedEls = [];

    const itemId = String(item?.id ?? "");
    const source = String(item?.source ?? "");
    if (itemId && source) {
      selectedEls = Array.from(
        gridContainer.querySelectorAll(
          `.calendar-event[data-source="${source}"][data-item-id="${itemId}"]`
        )
      );
    } else if (el) {
      selectedEls = [el];
    }

    selectedEls.forEach((candidate) => candidate.classList.add("selected"));

    setPanelMessage("");
    titleInput.value = item.title || "";
    startInput.value = formatDateTimeLocal(item.fullStartMs ?? item.start);
    endInput.value = formatDateTimeLocal(item.fullEndMs ?? item.end);
    levelSelect.value = item.blockingLevel || "B3";

    if (item.source === "google") {
      titleInput.disabled = true;
      startInput.disabled = true;
      endInput.disabled = true;
      createBtn.hidden = true;
      saveBtn.hidden = true;
      deleteBtn.hidden = true;
      savePriorityBtn.hidden = false;
    } else {
      titleInput.disabled = false;
      startInput.disabled = false;
      endInput.disabled = false;
      createBtn.hidden = true;
      saveBtn.hidden = false;
      deleteBtn.hidden = false;
      savePriorityBtn.hidden = true;
    }
  };

  const loadCalendarData = async () => {
    const week = getWeekWindow(currentWeekStart);
    gridContainer.innerHTML = "";
    clearSelection();

    const syncRes = await apiPost("/api/google/sync", { calendarId: "primary", force: false });
    if (syncRes && syncRes.error) {
      setPanelMessage(syncRes.error, true);
    }

    const [googleEvents, busyBlocks] = await Promise.all([
      apiGet(`/api/events?start=${week.startMs}&end=${week.endMs}`),
      apiGet(`/api/busy-blocks?start=${week.startMs}&end=${week.endMs}`)
    ]);

    const combined = [];
    if (Array.isArray(googleEvents)) {
      combined.push(
        ...googleEvents.map((event) => ({
          id: event.eventId,
          title: event.title,
          start: event.start,
          end: event.end,
          blockingLevel: event.blockingLevel,
          providerEventId: event.providerEventId,
          source: "google"
        }))
      );
    }
    if (Array.isArray(busyBlocks)) {
      combined.push(
        ...busyBlocks.map((block) => ({
          id: block.busyBlockId,
          title: block.title,
          start: block.start,
          end: block.end,
          blockingLevel: block.blockingLevel,
          source: "manual"
        }))
      );
    }

    renderCalendarGrid(gridContainer, currentWeekStart, combined, {
      onEventClick: (item, el) => setSelection(item, el)
    });

    await loadPetitions();
  };

  const actionBar = buildActionBar(container, async (action) => {
    if (!selectedPetition) return;
    try {
      if (action === "DELETE") {
        await apiDelete(`/api/petitions/${selectedPetition.id}`);
      } else {
        await apiPost(`/api/petitions/${selectedPetition.id}/respond`, {
          response: action
        });
      }
      await loadPetitions();
    } catch (error) {
      console.error("Petition action failed", error);
    }
  });

  gridContainer.onclick = () => {
    selectedPetition = null;
    actionBar.update();
    clearSelection();
  };

  async function loadPetitions() {
    const petitions = await apiGet("/api/petitions");
    petitionsCache = Array.isArray(petitions) ? petitions : [];
    selectedPetition = null;
    renderPetitions({
      root: gridContainer,
      petitions: petitionsCache,
      onSelect: (petition) => {
        selectedPetition = petition;
        actionBar.update();
      }
    });
    actionBar.update();
  }

  newBtn.onclick = () => {
    clearSelection();
    setPanelMessage("Create a new busy block (manual).");
  };

  createBtn.onclick = async () => {
    if (isSubmittingCreateBusyBlock) return;
    const startMs = parseDateTimeLocal(startInput.value);
    const endMs = parseDateTimeLocal(endInput.value);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setPanelMessage("Enter valid start and end times.", true);
      return;
    }
    if (endMs <= startMs) {
      setPanelMessage("End time must be after start time.", true);
      return;
    }

    isSubmittingCreateBusyBlock = true;
    createBtn.disabled = true;

    let succeeded = false;
    try {
      const clientRequestId =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const res = await apiPost("/api/busy-blocks", {
        title: titleInput.value.trim() || "Busy",
        clientRequestId,
        startMs,
        endMs,
        blockingLevel: levelSelect.value
      });

      if (res && res.error) {
        setPanelMessage(res.error, true);
        return;
      }

      await loadCalendarData();
      setPanelMessage("Busy block created.");
      succeeded = true;
    } catch (error) {
      console.error("Failed to create busy block", error);
      setPanelMessage("Failed to create busy block.", true);
    } finally {
      isSubmittingCreateBusyBlock = false;
      if (!succeeded) createBtn.disabled = false;
      else createBtn.disabled = false; // re-enable after UI refresh completes
    }
  };

  saveBtn.onclick = async () => {
    if (!selectedItem || selectedItem.source !== "manual") return;
    const startMs = parseDateTimeLocal(startInput.value);
    const endMs = parseDateTimeLocal(endInput.value);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setPanelMessage("Enter valid start and end times.", true);
      return;
    }
    if (endMs <= startMs) {
      setPanelMessage("End time must be after start time.", true);
      return;
    }

    const res = await apiPost(`/api/busy-blocks/${selectedItem.id}`, {
      title: titleInput.value.trim() || "Busy",
      startMs,
      endMs,
      blockingLevel: levelSelect.value
    });

    if (res && res.error) {
      setPanelMessage(res.error, true);
      return;
    }

    await loadCalendarData();
    setPanelMessage("Busy block updated.");
  };

  deleteBtn.onclick = async () => {
    if (!selectedItem || selectedItem.source !== "manual") return;

    const res = await apiDelete(`/api/busy-blocks/${selectedItem.id}`);
    if (res && res.error) {
      setPanelMessage(res.error, true);
      return;
    }

    await loadCalendarData();
    setPanelMessage("Busy block deleted.");
  };

  savePriorityBtn.onclick = async () => {
    if (!selectedItem || selectedItem.source !== "google") return;

    const res = await apiPost(`/api/events/${selectedItem.id}/priority`, {
      blockingLevel: levelSelect.value
    });

    if (res && res.error) {
      setPanelMessage(res.error, true);
      return;
    }

    await loadCalendarData();
    setPanelMessage("Priority updated.");
  };

  clearSelection();
  await loadCalendarData();
}
