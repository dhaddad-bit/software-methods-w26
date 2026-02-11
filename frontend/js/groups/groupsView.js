import { apiGet, apiPost, apiDelete } from "../api/api.js";
import { renderCalendarGrid } from "../calendar/calendarRender.js";
import { renderAvailability } from "../calendar/availabilityRender.js";
import { renderPetitions } from "../calendar/petitionRender.js";

const GRANULARITY_MINUTES = 15;
const BLOCK_MS = GRANULARITY_MINUTES * 60 * 1000;

let currentWeekStart = getStartOfWeek(new Date());
let selectedGroupId = null;
let currentUserId = null;
let currentUserEmail = null;
let windowPointerUpHandler = null;
let availabilityLevel = "MAYBE";

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

async function ensureCurrentUserId() {
  if (currentUserId) return;
  const me = await apiGet("/api/me");
  if (me && me.id) {
    currentUserId = me.id;
    currentUserEmail = typeof me.email === "string" ? me.email : null;
  }
}

function formatRange(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return `${start.toLocaleString()} → ${end.toLocaleTimeString()}`;
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

async function createGroup(groupName) {
  const group = await apiPost("/api/groups", { name: groupName });
  if (group && group.error) {
    throw new Error(group.error);
  }
  return group;
}

async function fetchGroupMembers(groupId) {
  const members = await apiGet(`/api/groups/${groupId}/members`);
  if (members && members.error) {
    throw new Error(members.error);
  }
  if (!Array.isArray(members)) {
    throw new Error("Unexpected members response");
  }
  return members;
}

function parseEmails(rawString) {
  const raw = typeof rawString === "string" ? rawString : "";
  const parts = raw.split(/[\s,;]+/);
  const seen = new Set();
  const out = [];

  parts.forEach((part) => {
    const email = part.trim();
    if (!email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(email);
  });

  return out;
}

function normalizeAddMemberError(message) {
  const raw = typeof message === "string" ? message : "";
  if (!raw) return "Failed to add member";
  if (raw.toLowerCase().includes("must log in first")) return "User must log in first";
  if (raw.toLowerCase().includes("already a member")) return "Already a member";
  if (raw.toLowerCase().includes("cannot add yourself")) return "Cannot add yourself";
  if (raw.toLowerCase().includes("limit reached")) return "Group full (8)";
  return raw;
}

async function addMembersToGroup(groupId, emails, options = {}) {
  const list = Array.isArray(emails) ? emails : [];
  const added = [];
  const failed = [];
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  for (let i = 0; i < list.length; i++) {
    const email = list[i];
    if (onProgress) onProgress({ current: i, total: list.length, email });

    let result;
    try {
      result = await apiPost(`/api/groups/${groupId}/members`, { email });
    } catch (error) {
      failed.push({ email, error: error?.message || "Failed to add member" });
      continue;
    }
    if (result && result.error) {
      failed.push({ email, error: result.error });
    } else {
      added.push(email);
    }
  }

  if (onProgress) onProgress({ current: list.length, total: list.length, email: null });
  return { added, failed };
}

async function fetchGroupAvailability(groupId, weekStart) {
  const { startMs, endMs } = getWeekWindow(weekStart);
  const query = new URLSearchParams({
    start: String(startMs),
    end: String(endMs),
    granularity: String(GRANULARITY_MINUTES),
    level: availabilityLevel
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

async function fetchGroupPetitions(groupId) {
  const petitions = await apiGet(`/api/groups/${groupId}/petitions`);
  if (petitions && petitions.error) {
    throw new Error(petitions.error);
  }
  if (!Array.isArray(petitions)) {
    throw new Error("Unexpected petitions response");
  }
  return petitions;
}

async function createPetition(groupId, payload) {
  const response = await apiPost(`/api/groups/${groupId}/petitions`, payload);
  if (response && response.error) {
    throw new Error(response.error);
  }
  return response;
}

async function respondToPetition(petitionId, response) {
  const result = await apiPost(`/api/petitions/${petitionId}/respond`, { response });
  if (result && result.error) {
    throw new Error(result.error);
  }
  return result;
}

async function deletePetition(petitionId) {
  const result = await apiDelete(`/api/petitions/${petitionId}`);
  if (result && result.error) {
    throw new Error(result.error);
  }
  return result;
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
  await ensureCurrentUserId();

  const container = document.getElementById("groups");
  container.innerHTML = "";

  const title = document.createElement("h2");
  title.textContent = "My Groups";

  const form = document.createElement("form");
  form.className = "groups-toolbar";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Group name (required)";
  nameInput.className = "group-input";

  const membersInput = document.createElement("textarea");
  membersInput.placeholder =
    "Member emails (optional). One per line or comma-separated.\nMembers must have logged in once.";
  membersInput.className = "group-input group-textarea";
  membersInput.rows = 3;

  const createBtn = document.createElement("button");
  createBtn.type = "submit";
  createBtn.id = "create-group-btn";
  createBtn.textContent = "Create Group";

  form.appendChild(nameInput);
  form.appendChild(membersInput);
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

  const titleRow = document.createElement("div");
  titleRow.className = "group-detail-title-row";

  const detailTitle = document.createElement("h3");
  detailTitle.id = "group-detail-title";

  const deleteGroupBtn = document.createElement("button");
  deleteGroupBtn.type = "button";
  deleteGroupBtn.className = "group-delete-btn";
  deleteGroupBtn.textContent = "Delete Group";
  deleteGroupBtn.hidden = true;

  const detailSubtitle = document.createElement("p");
  detailSubtitle.className = "group-detail-subtitle";
  detailSubtitle.textContent =
    "Gray hatch = 0 members available. Darker green = more members available. Conflicts counted: B1 (low) + B2 (med) + B3 (high).";

  const levelRow = document.createElement("div");
  levelRow.className = "availability-level-row";

  const levelLabel = document.createElement("span");
  levelLabel.className = "availability-level-label";
  levelLabel.textContent = "Availability:";

  const levelSelect = document.createElement("select");
  levelSelect.className = "availability-level-select";
  [
    { value: "AVAILABLE", label: "Lenient — only B3 blocks" },
    { value: "FLEXIBLE", label: "Standard — B2+B3 block" },
    { value: "MAYBE", label: "Strict — B1+B2+B3 block" }
  ].forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    levelSelect.appendChild(option);
  });
  levelSelect.value = availabilityLevel;

  levelRow.appendChild(levelLabel);
  levelRow.appendChild(levelSelect);

  titleRow.appendChild(detailTitle);
  titleRow.appendChild(deleteGroupBtn);

  detailHeader.appendChild(titleRow);
  detailHeader.appendChild(detailSubtitle);
  detailHeader.appendChild(levelRow);

  const membersSection = document.createElement("div");
  membersSection.className = "group-members";

  const membersHeader = document.createElement("div");
  membersHeader.className = "group-members-header";

  const membersTitle = document.createElement("h4");
  membersTitle.textContent = "Members";

  const membersCount = document.createElement("span");
  membersCount.className = "group-members-count";
  membersCount.textContent = "";

  membersHeader.appendChild(membersTitle);
  membersHeader.appendChild(membersCount);

  const membersList = document.createElement("div");
  membersList.className = "group-members-list";

  const membersMessage = document.createElement("div");
  membersMessage.className = "group-message group-members-message";

  const addMembersRow = document.createElement("div");
  addMembersRow.className = "group-members-add";

  const addMembersInput = document.createElement("textarea");
  addMembersInput.className = "group-input group-textarea";
  addMembersInput.placeholder = "Add member emails (one per line or comma-separated)";
  addMembersInput.rows = 2;

  const addMembersBtn = document.createElement("button");
  addMembersBtn.type = "button";
  addMembersBtn.textContent = "Add Members";

  addMembersRow.appendChild(addMembersInput);
  addMembersRow.appendChild(addMembersBtn);

  const membersHelp = document.createElement("div");
  membersHelp.className = "group-members-help";
  membersHelp.textContent = "Members must have logged in once.";

  membersSection.appendChild(membersHeader);
  membersSection.appendChild(membersList);
  membersSection.appendChild(membersMessage);
  membersSection.appendChild(addMembersRow);
  membersSection.appendChild(membersHelp);

  detailHeader.appendChild(membersSection);

  const detailStatus = document.createElement("div");
  detailStatus.className = "group-status";

  const petitionMessage = document.createElement("div");
  petitionMessage.className = "petition-message";

  const calendarWrapper = document.createElement("div");
  calendarWrapper.id = "group-calendar";
  calendarWrapper.className = "group-calendar";

  const selectionPanel = document.createElement("div");
  selectionPanel.className = "petition-panel";
  selectionPanel.hidden = true;

  const selectionInfo = document.createElement("div");
  selectionInfo.className = "petition-panel-info";

  const startInput = document.createElement("input");
  startInput.type = "datetime-local";
  startInput.step = String(BLOCK_MS / 1000);
  startInput.className = "petition-input";

  const endInput = document.createElement("input");
  endInput.type = "datetime-local";
  endInput.step = String(BLOCK_MS / 1000);
  endInput.className = "petition-input";

  const applyRangeBtn = document.createElement("button");
  applyRangeBtn.type = "button";
  applyRangeBtn.textContent = "Apply Range";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.placeholder = "Petition title";
  titleInput.className = "petition-input";

  const prioritySelect = document.createElement("select");
  prioritySelect.className = "petition-select";
  const highestOption = document.createElement("option");
  highestOption.value = "HIGHEST";
  highestOption.textContent = "Highest";
  prioritySelect.appendChild(highestOption);
  prioritySelect.value = "HIGHEST";

  const createPetitionBtn = document.createElement("button");
  createPetitionBtn.type = "button";
  createPetitionBtn.textContent = "Create/Finalize Petition/Event";

  const cancelSelectionBtn = document.createElement("button");
  cancelSelectionBtn.type = "button";
  cancelSelectionBtn.textContent = "Cancel";

  selectionPanel.appendChild(selectionInfo);
  selectionPanel.appendChild(startInput);
  selectionPanel.appendChild(endInput);
  selectionPanel.appendChild(applyRangeBtn);
  selectionPanel.appendChild(titleInput);
  selectionPanel.appendChild(prioritySelect);
  selectionPanel.appendChild(createPetitionBtn);
  selectionPanel.appendChild(cancelSelectionBtn);

  const petitionActions = document.createElement("div");
  petitionActions.className = "petition-action-bar";

  detail.appendChild(detailHeader);
  detail.appendChild(detailStatus);
  detail.appendChild(petitionMessage);
  detail.appendChild(calendarWrapper);
  detail.appendChild(selectionPanel);
  detail.appendChild(petitionActions);

  container.appendChild(title);
  container.appendChild(form);
  container.appendChild(message);
  container.appendChild(list);
  container.appendChild(detail);

	  const renderGroupCalendar = async (group) => {
	    selectedGroupId = group.id;
	    const renderGroupId = String(group.id);
	    detail.hidden = false;
	    detailTitle.textContent = group.name;

	    const creatorId = group.created_by_user_id ?? group.createdByUserId ?? null;
	    const canDelete = creatorId !== null && String(creatorId) === String(currentUserId);
	    deleteGroupBtn.hidden = !canDelete;
	    deleteGroupBtn.disabled = false;
	    deleteGroupBtn.onclick = async () => {
	      if (String(selectedGroupId) !== renderGroupId) return;
	      const ok = window.confirm(`Delete "${group.name}"? This cannot be undone.`);
	      if (!ok) return;

	      deleteGroupBtn.disabled = true;
	      setMessage(detailStatus, "Deleting group...");
	      try {
	        const result = await apiDelete(`/api/groups/${group.id}`);
	        if (result && result.error) {
	          setMessage(detailStatus, result.error, true);
	          deleteGroupBtn.disabled = false;
	          return;
	        }

	        selectedGroupId = null;
	        detail.hidden = true;
	        await loadGroups({ preserveMessage: true });
	        setMessage(message, `Deleted group "${group.name}".`);
	      } catch (error) {
	        setMessage(detailStatus, error.message || "Failed to delete group", true);
	        deleteGroupBtn.disabled = false;
	      }
	    };

	    petitionMessage.textContent = "";
	    addMembersInput.value = "";
	    setMessage(membersMessage, "");
	    membersList.innerHTML = "";
	    membersCount.textContent = "";

    calendarWrapper.innerHTML = "";
    petitionActions.innerHTML = "";
    selectionPanel.hidden = true;

    let selection = null;
    let selectableSlots = new Map();
    let isSelecting = false;
    let anchorStartMs = null;
    let anchorEndMs = null;
    let tapAnchorMs = null;
    let didDragSelect = false;
    let petitionsCache = [];

	    const updateSubtitleForLevel = () => {
	      if (availabilityLevel === "AVAILABLE") {
	        detailSubtitle.textContent =
	          "Gray hatch = 0 members available. Darker green = more members available. Conflicts counted: B3 (high) only.";
	      } else if (availabilityLevel === "FLEXIBLE") {
	        detailSubtitle.textContent =
	          "Gray hatch = 0 members available. Darker green = more members available. Conflicts counted: B2 (med) + B3 (high).";
	      } else {
	        detailSubtitle.textContent =
	          "Gray hatch = 0 members available. Darker green = more members available. Conflicts counted: B1 (low) + B2 (med) + B3 (high).";
	      }
	      levelSelect.value = availabilityLevel;
	    };

    updateSubtitleForLevel();
    levelSelect.onchange = async () => {
      availabilityLevel = levelSelect.value;
      updateSubtitleForLevel();
      await refreshData();
    };

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

    const updateSelectionHighlight = (rangeStartMs, rangeEndMs) => {
      gridContainer.querySelectorAll(".availability-slot.selected").forEach((el) => {
        el.classList.remove("selected");
      });

      for (let t = rangeStartMs; t < rangeEndMs; t += BLOCK_MS) {
        const el = selectableSlots.get(t);
        if (el) {
          el.classList.add("selected");
        }
      }
    };

    const clearSelection = () => {
      selection = null;
      tapAnchorMs = null;
      anchorStartMs = null;
      anchorEndMs = null;
      updateSelectionHighlight(0, 0);
      startInput.value = "";
      endInput.value = "";
      updateSelectionPanel();
    };

    const formatDateTimeLocal = (ms) => {
      const date = new Date(ms);
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 16);
    };

    const parseDateTimeLocal = (value) => {
      if (!value) return null;
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    };

    const updateInputsFromSelection = () => {
      if (!selection) return;
      startInput.value = formatDateTimeLocal(selection.startMs);
      endInput.value = formatDateTimeLocal(selection.endMs);
    };

    const updateSelectionPanel = () => {
      selectionPanel.hidden = false;
      if (!selection) {
        selectionInfo.textContent = "Select a contiguous fully-free range or enter start/end.";
        return;
      }
      selectionInfo.textContent = `${formatRange(selection.startMs, selection.endMs)} (${(
        (selection.endMs - selection.startMs) /
        (60 * 1000)
      ).toFixed(0)} mins)`;
      updateInputsFromSelection();
    };

    const validateRange = (rangeStartMs, rangeEndMs) => {
      for (let t = rangeStartMs; t < rangeEndMs; t += BLOCK_MS) {
        if (!selectableSlots.has(t)) {
          return false;
        }
      }
      return true;
    };

    const handlePointerDown = (event) => {
      const slot = event.target.closest(".availability-slot.selectable");
      if (!slot) return;
      event.preventDefault();

      const startMs = Number(slot.dataset.startMs);
      const endMs = Number(slot.dataset.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

      tapAnchorMs = null;
      didDragSelect = false;
      isSelecting = true;
      anchorStartMs = startMs;
      anchorEndMs = endMs;
      selection = { startMs, endMs };
      updateSelectionHighlight(startMs, endMs);
      updateSelectionPanel();
    };

    const handlePointerOver = (event) => {
      if (!isSelecting) return;
      const slot = event.target.closest(".availability-slot.selectable");
      if (!slot) return;

      const startMs = Number(slot.dataset.startMs);
      const endMs = Number(slot.dataset.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

      const rangeStartMs = Math.min(anchorStartMs, startMs);
      const rangeEndMs = Math.max(anchorEndMs, endMs);

      if (!validateRange(rangeStartMs, rangeEndMs)) {
        setMessage(petitionMessage, "Selection must be contiguous fully-free blocks.", true);
        return;
      }

      didDragSelect = true;
      setMessage(petitionMessage, "");
      selection = { startMs: rangeStartMs, endMs: rangeEndMs };
      updateSelectionHighlight(rangeStartMs, rangeEndMs);
      updateSelectionPanel();
    };

    const handlePointerUp = () => {
      if (!isSelecting) return;
      isSelecting = false;
      updateSelectionPanel();
    };

    const handleTapSelect = (event) => {
      if (isSelecting) return;
      if (didDragSelect) {
        didDragSelect = false;
        return;
      }

      const slot = event.target.closest(".availability-slot.selectable");
      if (!slot) return;

      const startMs = Number(slot.dataset.startMs);
      const endMs = Number(slot.dataset.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

      if (tapAnchorMs === null) {
        tapAnchorMs = startMs;
        selection = { startMs, endMs };
        updateSelectionHighlight(startMs, endMs);
        updateSelectionPanel();
        setMessage(petitionMessage, "Tap an end time to finish selection.", false);
        return;
      }

      const anchorEnd = tapAnchorMs + BLOCK_MS;
      const rangeStartMs = Math.min(tapAnchorMs, startMs);
      const rangeEndMs = Math.max(anchorEnd, endMs);

      if (!validateRange(rangeStartMs, rangeEndMs)) {
        setMessage(petitionMessage, "Selection must be contiguous fully-free blocks.", true);
        return;
      }

      setMessage(petitionMessage, "");
      tapAnchorMs = null;
      selection = { startMs: rangeStartMs, endMs: rangeEndMs };
      updateSelectionHighlight(rangeStartMs, rangeEndMs);
      updateSelectionPanel();
    };

    const setupSelectionHandlers = () => {
      selectableSlots = new Map();
      gridContainer.querySelectorAll(".availability-slot.selectable").forEach((el) => {
        const startMs = Number(el.dataset.startMs);
        if (Number.isFinite(startMs)) {
          selectableSlots.set(startMs, el);
        }
      });

      gridContainer.addEventListener("pointerdown", handlePointerDown);
      gridContainer.addEventListener("pointerover", handlePointerOver);
      gridContainer.addEventListener("click", handleTapSelect);

      if (windowPointerUpHandler) {
        window.removeEventListener("pointerup", windowPointerUpHandler);
      }
      windowPointerUpHandler = handlePointerUp;
      window.addEventListener("pointerup", windowPointerUpHandler);
    };

    const updatePetitionActions = (petition) => {
      petitionActions.innerHTML = "";
      if (!petition) return;

      const info = document.createElement("div");
      info.className = "petition-action-info";
      const start = new Date(petition.startMs);
      const end = new Date(petition.endMs);
      info.textContent = `${petition.title} • ${petition.status} • ${start.toLocaleString()} → ${end.toLocaleTimeString()}`;

      const actions = document.createElement("div");
      actions.className = "petition-action-buttons";

      if (petition.status !== "FAILED") {
        const acceptBtn = document.createElement("button");
        acceptBtn.textContent = "Accept";
        acceptBtn.onclick = async () => {
          try {
            await respondToPetition(petition.id, "ACCEPT");
            await refreshData();
            setMessage(petitionMessage, "");
          } catch (error) {
            setMessage(petitionMessage, error.message || "Failed to respond", true);
          }
        };

        const declineBtn = document.createElement("button");
        declineBtn.textContent = "Decline";
        declineBtn.onclick = async () => {
          try {
            await respondToPetition(petition.id, "DECLINE");
            await refreshData();
            setMessage(petitionMessage, "");
          } catch (error) {
            setMessage(petitionMessage, error.message || "Failed to respond", true);
          }
        };

        actions.appendChild(acceptBtn);
        actions.appendChild(declineBtn);
      }

      if (petition.status === "FAILED" && petition.createdByUserId === currentUserId) {
        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "Delete";
        deleteBtn.onclick = async () => {
          try {
            await deletePetition(petition.id);
            await refreshData();
            setMessage(petitionMessage, "");
          } catch (error) {
            setMessage(petitionMessage, error.message || "Failed to delete petition", true);
          }
        };
        actions.appendChild(deleteBtn);
      }

      petitionActions.appendChild(info);
      petitionActions.appendChild(actions);
    };

		    const refreshData = async () => {
		      clearSelection();
		      setMessage(detailStatus, "Loading availability...");
		      try {
	        const [blocks, petitions] = await Promise.all([
	          fetchGroupAvailability(group.id, currentWeekStart),
	          fetchGroupPetitions(group.id)
	        ]);
	        if (String(selectedGroupId) !== renderGroupId) return;

	        petitionsCache = petitions;

	        renderAvailability({
	          root: gridContainer,
          slots: blocks,
          minFraction: 0,
          interactive: true
        });

	        renderPetitions({
	          root: gridContainer,
	          petitions: petitionsCache,
	          onSelect: (petition) => {
	            clearSelection();
	            updatePetitionActions(petition);
	          }
	        });

	        setupSelectionHandlers();
	        updatePetitionActions(null);
		        setMessage(detailStatus, "");
	      } catch (error) {
	        if (String(selectedGroupId) !== renderGroupId) return;
		        setMessage(detailStatus, error.message || "Failed to load availability", true);
		      }
		    };

	    const renderMembers = (members) => {
	      membersList.innerHTML = "";
	      membersCount.textContent = `(${members.length})`;
	      if (members.length === 0) {
	        membersList.innerHTML = "<p>No members found.</p>";
	        return;
	      }

	      members.forEach((member) => {
	        const row = document.createElement("div");
	        row.className = "group-member-row";

	        const label = member.name ? `${member.name} <${member.email}>` : member.email;
	        row.textContent =
	          String(member.id) === String(currentUserId) ? `${label} (you)` : label;
	        membersList.appendChild(row);
	      });
	    };

		    const refreshMembers = async () => {
		      setMessage(membersMessage, "Loading members...");
		      try {
		        const members = await fetchGroupMembers(group.id);
		        if (String(selectedGroupId) !== renderGroupId) return [];
		        renderMembers(members);
		        setMessage(membersMessage, "");
		        return members;
		      } catch (error) {
		        if (String(selectedGroupId) !== renderGroupId) return [];
		        membersList.innerHTML = "";
		        membersCount.textContent = "";
		        setMessage(membersMessage, error.message || "Failed to load members", true);
		        return [];
		      }
		    };

		    addMembersBtn.onclick = async () => {
		      const emails = parseEmails(addMembersInput.value);
		      if (emails.length === 0) {
		        setMessage(membersMessage, "Enter one or more email addresses.", true);
		        return;
		      }

		      if (currentUserEmail) {
		        const selfKey = currentUserEmail.toLowerCase();
		        const includesSelf = emails.some((email) => String(email).toLowerCase() === selfKey);
		        if (includesSelf) {
		          setMessage(
		            membersMessage,
		            "Remove your own email — you're already a member.",
		            true
		          );
		          return;
		        }
		      }

		      addMembersBtn.disabled = true;
		      setMessage(membersMessage, `Adding members (0/${emails.length})...`);

		      try {
		        const result = await addMembersToGroup(group.id, emails, {
		          onProgress: ({ current, total }) => {
		            if (String(selectedGroupId) !== renderGroupId) return;
		            setMessage(membersMessage, `Adding members (${current}/${total})...`);
		          }
		        });
		        if (String(selectedGroupId) !== renderGroupId) return;

		        const addedCount = result.added.length;
		        let summary = `Added ${addedCount}/${emails.length} members.`;

	        if (result.failed.length > 0) {
	          const failedList = result.failed
	            .map((item) => `${item.email} (${normalizeAddMemberError(item.error)})`)
	            .join(", ");
	          summary += ` Couldn’t add: ${failedList}`;
	        }

	        setMessage(membersMessage, summary, result.failed.length > 0);
	        addMembersInput.value = "";

	        await refreshMembers();
	        await refreshData();
	      } catch (error) {
	        setMessage(membersMessage, error.message || "Failed to add members", true);
	      } finally {
	        addMembersBtn.disabled = false;
	      }
	    };

    applyRangeBtn.onclick = () => {
      const startMs = parseDateTimeLocal(startInput.value);
      const endMs = parseDateTimeLocal(endInput.value);

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setMessage(petitionMessage, "Enter valid start and end times.", true);
        return;
      }
      if (endMs <= startMs) {
        setMessage(petitionMessage, "End time must be after start time.", true);
        return;
      }
      if (startMs % BLOCK_MS !== 0 || endMs % BLOCK_MS !== 0) {
        setMessage(petitionMessage, "Times must align to 15-minute blocks.", true);
        return;
      }

      const weekWindow = getWeekWindow(currentWeekStart);
      if (startMs < weekWindow.startMs || endMs > weekWindow.endMs) {
        setMessage(petitionMessage, "Range must be within the visible week.", true);
        return;
      }

      if (!validateRange(startMs, endMs)) {
        setMessage(petitionMessage, "Range must be fully-free contiguous blocks.", true);
        return;
      }

      tapAnchorMs = null;
      selection = { startMs, endMs };
      updateSelectionHighlight(startMs, endMs);
      updateSelectionPanel();
      setMessage(petitionMessage, "");
    };

    createPetitionBtn.onclick = async () => {
      if (!selection) {
        setMessage(petitionMessage, "Select a contiguous fully-free range first.", true);
        return;
      }

      createPetitionBtn.disabled = true;
      setMessage(petitionMessage, "Creating petition...");

      try {
        const payload = {
          title: titleInput.value.trim() || "Petitioned Meeting",
          start: selection.startMs,
          end: selection.endMs,
          priority: prioritySelect.value,
          level: availabilityLevel
        };
        await createPetition(group.id, payload);
        titleInput.value = "";
        clearSelection();
        await refreshData();
        setMessage(petitionMessage, "Petition created.");
      } catch (error) {
        setMessage(petitionMessage, error.message || "Failed to create petition", true);
      } finally {
        createPetitionBtn.disabled = false;
      }
    };

    cancelSelectionBtn.onclick = () => {
      clearSelection();
      setMessage(petitionMessage, "");
    };

    gridContainer.addEventListener("click", () => {
      updatePetitionActions(null);
    });

	    await Promise.all([refreshMembers(), refreshData()]);
	  };

  const loadGroups = async ({ preserveMessage = false } = {}) => {
    list.innerHTML = "";
    if (!preserveMessage) setMessage(message, "");

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
	    const nameValue = nameInput.value.trim();
	    const emails = parseEmails(membersInput.value);

	    if (!nameValue) {
	      setMessage(message, "Group name is required.", true);
	      return;
	    }

	    if (currentUserEmail) {
	      const selfKey = currentUserEmail.toLowerCase();
	      const includesSelf = emails.some((email) => String(email).toLowerCase() === selfKey);
	      if (includesSelf) {
	        setMessage(
	          message,
	          "Remove your own email from the member list — you're already a member.",
	          true
	        );
	        return;
	      }
	    }

	    createBtn.disabled = true;
	    setMessage(message, "Creating group...");

	    try {
	      const group = await createGroup(nameValue);

	      let addResult = { added: [], failed: [] };
	      if (emails.length > 0) {
	        setMessage(message, `Adding members (0/${emails.length})...`);
	        addResult = await addMembersToGroup(group.id, emails, {
	          onProgress: ({ current, total }) => {
	            setMessage(message, `Adding members (${current}/${total})...`);
	          }
	        });
	      }

	      if (emails.length === 0) {
	        setMessage(message, "Group created.", false);
	      } else {
	        let summary = `Group created. Added ${addResult.added.length}/${emails.length} members.`;
	        if (addResult.failed.length > 0) {
	          const failedList = addResult.failed
	            .map((item) => `${item.email} (${normalizeAddMemberError(item.error)})`)
	            .join(", ");
	          summary += ` Couldn’t add: ${failedList}`;
	        }
	        setMessage(message, summary, addResult.failed.length > 0);
	      }

	      nameInput.value = "";
	      membersInput.value = "";

	      currentWeekStart = getStartOfWeek(new Date());
	      await loadGroups({ preserveMessage: true });

	      await renderGroupCalendar(group);
	    } catch (error) {
	      setMessage(message, error.message || "Failed to create group", true);
	    } finally {
	      createBtn.disabled = false;
	    }
	  });

  await loadGroups();
}
