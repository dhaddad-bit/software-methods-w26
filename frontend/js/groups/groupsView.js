import { apiGet, apiPost } from "../api/api.js";
import { renderCalendarGrid } from "../calendar/calendarRender.js";
import { renderAvailability } from "../calendar/availabilityRender.js";

let currentWeekStart = getStartOfWeek(new Date());
let selectedGroupId = null;

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

function formatWeekTitle(weekStart) {
  return weekStart.toLocaleString("default", {
    month: "long",
    year: "numeric"
  });
}

function setMessage(el, message, isError = false) {
  if (!el) return;
  el.textContent = message || "";
  el.dataset.type = isError ? "error" : "info";
}

async function fetchGroups() {
  const groups = await apiGet("/api/groups");
  if (groups && groups.error) {
    throw new Error(groups.error);
  }
  if (!Array.isArray(groups)) {
    throw new Error("Unexpected groups response");
  }
  return groups;
}

async function createGroupWithMember(groupName, email) {
  const group = await apiPost("/api/groups", { name: groupName });
  if (group && group.error) {
    throw new Error(group.error);
  }

  const addMember = await apiPost(`/api/groups/${group.id}/members`, { email });
  if (addMember && addMember.error) {
    return { group, memberAdded: false, error: addMember.error };
  }

  return { group, memberAdded: true };
}

async function fetchGroupAvailability(groupId, weekStart) {
  const { startMs, endMs } = getWeekWindow(weekStart);
  const query = new URLSearchParams({
    start: String(startMs),
    end: String(endMs),
    granularity: "30"
  });

  const blocks = await apiGet(`/api/groups/${groupId}/availability?${query.toString()}`);
  if (blocks && blocks.error) {
    throw new Error(blocks.error);
  }
  if (!Array.isArray(blocks)) {
    throw new Error("Unexpected availability response");
  }
  return blocks;
}

function renderGroupRow(group, onView) {
  const row = document.createElement("div");
  row.className = "group-row";

  const name = document.createElement("span");
  name.textContent = group.name;

  const viewBtn = document.createElement("button");
  viewBtn.textContent = "View";
  viewBtn.onclick = () => onView(group);

  row.appendChild(name);
  row.appendChild(viewBtn);

  return row;
}

export async function renderGroups() {
  const container = document.getElementById("groups");
  container.innerHTML = "";

  const title = document.createElement("h2");
  title.textContent = "My Groups";

  const form = document.createElement("form");
  form.className = "groups-toolbar";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Group name (optional)";
  nameInput.className = "group-input";

  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.placeholder = "Invite Gmail (required)";
  emailInput.className = "group-input";

  const createBtn = document.createElement("button");
  createBtn.type = "submit";
  createBtn.id = "create-group-btn";
  createBtn.textContent = "Create Group";

  form.appendChild(nameInput);
  form.appendChild(emailInput);
  form.appendChild(createBtn);

  const message = document.createElement("div");
  message.id = "group-message";
  message.className = "group-message";

  const list = document.createElement("div");
  list.id = "group-list";
  list.className = "group-list";

  const detail = document.createElement("div");
  detail.id = "group-detail";
  detail.className = "group-detail";
  detail.hidden = true;

  const detailHeader = document.createElement("div");
  detailHeader.className = "group-detail-header";

  const detailTitle = document.createElement("h3");
  detailTitle.id = "group-detail-title";

  const detailSubtitle = document.createElement("p");
  detailSubtitle.className = "group-detail-subtitle";
  detailSubtitle.textContent = "Darker green = more members available.";

  detailHeader.appendChild(detailTitle);
  detailHeader.appendChild(detailSubtitle);

  const detailStatus = document.createElement("div");
  detailStatus.className = "group-status";

  const calendarWrapper = document.createElement("div");
  calendarWrapper.id = "group-calendar";
  calendarWrapper.className = "group-calendar";

  detail.appendChild(detailHeader);
  detail.appendChild(detailStatus);
  detail.appendChild(calendarWrapper);

  container.appendChild(title);
  container.appendChild(form);
  container.appendChild(message);
  container.appendChild(list);
  container.appendChild(detail);

  const renderGroupCalendar = async (group) => {
    selectedGroupId = group.id;
    detail.hidden = false;
    detailTitle.textContent = group.name;

    calendarWrapper.innerHTML = "";

    const header = document.createElement("div");
    header.className = "calendar-header";

    const prev = document.createElement("button");
    prev.textContent = "← Prev";
    prev.onclick = () => {
      currentWeekStart.setDate(currentWeekStart.getDate() - 7);
      renderGroupCalendar(group);
    };

    const next = document.createElement("button");
    next.textContent = "Next →";
    next.onclick = () => {
      currentWeekStart.setDate(currentWeekStart.getDate() + 7);
      renderGroupCalendar(group);
    };

    const headerTitle = document.createElement("h4");
    headerTitle.textContent = formatWeekTitle(currentWeekStart);

    header.append(prev, headerTitle, next);
    calendarWrapper.appendChild(header);

    const gridContainer = document.createElement("div");
    calendarWrapper.appendChild(gridContainer);

    renderCalendarGrid(gridContainer, currentWeekStart, []);

    setMessage(detailStatus, "Loading availability...");

    try {
      const blocks = await fetchGroupAvailability(group.id, currentWeekStart);
      renderAvailability({ root: gridContainer, slots: blocks, minFraction: 0 });
      setMessage(detailStatus, "");
    } catch (error) {
      setMessage(detailStatus, error.message || "Failed to load availability", true);
    }
  };

  const loadGroups = async () => {
    list.innerHTML = "";
    setMessage(message, "");

    try {
      const groups = await fetchGroups();
      if (groups.length === 0) {
        list.innerHTML = "<p>No groups yet. Create one to get started.</p>";
        detail.hidden = true;
        return;
      }

      groups.forEach((group) => {
        const row = renderGroupRow(group, renderGroupCalendar);
        list.appendChild(row);
      });

      if (selectedGroupId) {
        const existing = groups.find((group) => group.id === selectedGroupId);
        if (existing) {
          renderGroupCalendar(existing);
        }
      }
    } catch (error) {
      setMessage(message, error.message || "Failed to load groups", true);
      detail.hidden = true;
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const nameValue = nameInput.value.trim();

    if (!email) {
      setMessage(message, "Please enter a Gmail address.", true);
      return;
    }

    const groupName = nameValue || `Group with ${email}`;

    createBtn.disabled = true;
    setMessage(message, "Creating group...");

    try {
      const result = await createGroupWithMember(groupName, email);
      if (!result.memberAdded && result.error) {
        setMessage(message, result.error, true);
      } else {
        setMessage(message, "Group created!", false);
      }

      nameInput.value = "";
      emailInput.value = "";

      currentWeekStart = getStartOfWeek(new Date());
      await loadGroups();

      if (result.group) {
        await renderGroupCalendar(result.group);
      }
    } catch (error) {
      setMessage(message, error.message || "Failed to create group", true);
    } finally {
      createBtn.disabled = false;
    }
  });

  await loadGroups();
}
