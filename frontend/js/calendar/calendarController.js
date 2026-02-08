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

  try {
    // check permissions!
      const events = await apiGet('/api/events');

      console.log("Before renderCalendarGrid:", container.innerHTML);
      renderCalendarGrid(container, currentWeekStart, events);
  }
  catch (error) {
      console.error('Error fetching calendar', error);
      container.innerHTML += "<p>No calendar loaded</p>";
  }

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

  container.onclick = () => {
    selectedPetition = null;
    actionBar.update();
  };

  async function loadPetitions() {
    const petitions = await apiGet("/api/petitions");
    petitionsCache = Array.isArray(petitions) ? petitions : [];
    selectedPetition = null;
    renderPetitions({
      root: container,
      petitions: petitionsCache,
      onSelect: (petition) => {
        selectedPetition = petition;
        actionBar.update();
      }
    });
    actionBar.update();
  }

  await loadPetitions();
}
