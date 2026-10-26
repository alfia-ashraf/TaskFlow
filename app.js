const TASKS_KEY = "taskflow.tasks.v1";
const THEME_KEY = "taskflow.theme.v1";
const DELETED_KEY = "taskflow.deleted.v1";
const validStatuses = new Set(["pending", "in-progress", "completed"]);
const validPriorities = new Set(["low", "medium", "high"]);
const categories = new Set(["Study", "Work", "Personal", "Other"]);
const priorityOrder = { high: 0, medium: 1, low: 2 };
const cloudConfig = window.TASKFLOW_SUPABASE_CONFIG || {};

const $ = (selector, root = document) => root.querySelector(selector);
const taskList = $("#task-list");
const dialog = $("#task-dialog");
const taskForm = $("#task-form");
let tasks = [];
let deletedTasks = [];
let guestTasks = [];
let guestDeletedTasks = [];
let activeTasksKey = TASKS_KEY;
let activeDeletedKey = DELETED_KEY;
let supabaseClient = null;
let cloudSession = null;
let cloudSyncQueue = Promise.resolve();
let sampleTasks = [];
let currentView = "all";
let selectedCategory = "all";
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarSelectedDate = localDateKey(new Date());
let draftSubtasks = [];
let authMode = "sign-in";
let toastTimer;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3000);
}

function setMobileNavigationOpen(isOpen) {
  $("#sidebar").classList.toggle("is-open", isOpen);
  $("#sidebar-backdrop").hidden = !isOpen;
  $("#mobile-menu-toggle").setAttribute("aria-expanded", String(isOpen));
  $("#mobile-menu-toggle").setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
  document.body.classList.toggle("mobile-navigation-open", isOpen);
}

function getAuthRedirectUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith("/index.html")) url.pathname = url.pathname.slice(0, -"index.html".length);
  else if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function getAuthRedirectError() {
  const params = new URLSearchParams(window.location.search);
  new URLSearchParams(window.location.hash.slice(1)).forEach((value, key) => params.set(key, value));
  const description = params.get("error_description");
  if (!description) return null;
  return description;
}

function isValidTask(value) {
  return value && typeof value === "object" &&
    typeof value.id === "string" && value.id.trim() && typeof value.title === "string" && value.title.trim() &&
    categories.has(value.category) && validPriorities.has(value.priority) &&
    validStatuses.has(value.status) && typeof value.description === "string" &&
    isValidDate(value.dueDate) && isValidTimestamp(value.createdAt) &&
    (value.updatedAt === undefined || isValidTimestamp(value.updatedAt)) &&
    (value.deleted === undefined || typeof value.deleted === "boolean") &&
    (value.favorite === undefined || typeof value.favorite === "boolean") &&
    (value.subtasks === undefined || (Array.isArray(value.subtasks) && value.subtasks.every(isValidSubtask))) &&
    (value.sourceId === undefined || typeof value.sourceId === "string");
}

function isValidSubtask(value) {
  return value && typeof value === "object" && typeof value.id === "string" && value.id &&
    typeof value.title === "string" && value.title.trim() && typeof value.completed === "boolean";
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidDate(value) {
  if (value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function loadTaskList(key, kind) {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) throw new Error("Saved task data is not a list.");
    const ids = new Set();
    const valid = parsed.filter(task => {
      if (!isValidTask(task) || ids.has(task.id)) return false;
      ids.add(task.id);
      return true;
    });
    if (valid.length !== parsed.length) {
      $("#storage-notice").textContent = `Some saved ${kind} data could not be read and was skipped.`;
      $("#storage-notice").hidden = false;
    }
    return valid;
  } catch (error) {
    $("#storage-notice").textContent = `Saved ${kind} could not be loaded. Your browser storage may be unavailable or corrupted.`;
    $("#storage-notice").hidden = false;
    console.error(`Unable to load saved ${kind}:`, error);
    return [];
  }
}

function loadTasks() {
  tasks = loadTaskList(activeTasksKey, "tasks");
  deletedTasks = loadTaskList(activeDeletedKey, "deleted task records");
  return tasks;
}

function saveTasks() {
  try {
    localStorage.setItem(activeTasksKey, JSON.stringify(tasks));
    localStorage.setItem(activeDeletedKey, JSON.stringify(deletedTasks));
    if (!cloudSession) {
      guestTasks = tasks.slice();
      guestDeletedTasks = deletedTasks.slice();
    } else {
      queueCloudSync();
    }
    return true;
  } catch (error) {
    $("#storage-notice").textContent = "Your changes are visible now, but could not be saved. Check your browser's storage settings.";
    $("#storage-notice").hidden = false;
    console.error("Unable to save tasks:", error);
    showToast("Could not save changes to local storage.");
    if (cloudSession) queueCloudSync();
    else {
      guestTasks = tasks.slice();
      guestDeletedTasks = deletedTasks.slice();
    }
    return false;
  }
}

function updateCloudStatus(message, state = "neutral") {
  const status = $("#account-status");
  status.textContent = message;
  status.dataset.state = state;
}

function taskStorageKey(base, userId) {
  return `${base}:user:${userId}`;
}

function taskUpdatedAt(task) {
  return task.updatedAt || task.createdAt;
}

function mergeTaskRecords(...collections) {
  const latest = new Map();
  for (const collection of collections) {
    for (const task of collection) {
      const current = latest.get(task.id);
      if (!current || taskUpdatedAt(task) >= taskUpdatedAt(current)) latest.set(task.id, task);
    }
  }
  const records = [...latest.values()];
  tasks = records.filter(task => !task.deleted);
  deletedTasks = records.filter(task => task.deleted);
}

function toCloudRecord(task, userId, deleted = false) {
  return {
    id: task.id,
    user_id: userId,
    title: task.title,
    description: task.description,
    category: task.category,
    priority: task.priority,
    due_date: task.dueDate || null,
    status: task.status,
    favorite: Boolean(task.favorite),
    subtasks: task.subtasks || [],
    created_at: task.createdAt,
    updated_at: taskUpdatedAt(task),
    deleted,
    source_id: task.sourceId || null
  };
}

function fromCloudRecord(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    dueDate: row.due_date || "",
    status: row.status,
    favorite: Boolean(row.favorite),
    subtasks: Array.isArray(row.subtasks) ? row.subtasks : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: row.deleted,
    ...(row.source_id ? { sourceId: row.source_id } : {})
  };
}

function queueCloudSync() {
  if (!supabaseClient || !cloudSession) return;
  const session = cloudSession;
  const records = [
    ...tasks.map(task => toCloudRecord(task, session.user.id)),
    ...deletedTasks.map(task => toCloudRecord(task, session.user.id, true))
  ];
  cloudSyncQueue = cloudSyncQueue.then(async () => {
    if (!records.length) return;
    const { error } = await supabaseClient
      .from("tasks")
      .upsert(records, { onConflict: "user_id,id" });
    if (error) throw error;
    if (cloudSession?.user.id === session.user.id) updateCloudStatus("Synced to your devices.", "success");
  }).catch(error => {
    console.error("Unable to sync tasks with Supabase:", error);
    if (cloudSession?.user.id === session.user.id) updateCloudStatus("Cloud sync failed. Your tasks remain saved on this device.", "error");
  });
}

async function pullCloudTasks(session, includeGuestTasks = false) {
  const { data, error } = await supabaseClient
    .from("tasks")
    .select("id,title,description,category,priority,due_date,status,favorite,subtasks,created_at,updated_at,deleted,source_id")
    .eq("user_id", session.user.id);
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error("Supabase returned an invalid task list.");
  const remote = data.map(fromCloudRecord);
  const cached = [...tasks, ...deletedTasks];
  mergeTaskRecords(remote, cached, ...(includeGuestTasks ? [guestTasks, guestDeletedTasks] : []));
  const savedLocally = saveTasks();
  render();
  updateCloudStatus(savedLocally ? "Cloud tasks refreshed." : "Cloud tasks refreshed, but couldn't cache them on this device.", savedLocally ? "success" : "error");
}

async function activateCloudSession(session, includeGuestTasks = false) {
  cloudSession = session;
  activeTasksKey = taskStorageKey(TASKS_KEY, session.user.id);
  activeDeletedKey = taskStorageKey(DELETED_KEY, session.user.id);
  loadTasks();
  updateAccountControls();
  updateCloudStatus("Syncing your tasks...", "neutral");
  render();
  try {
    await pullCloudTasks(session, includeGuestTasks);
  } catch (error) {
    console.error("Unable to load cloud tasks:", error);
    if (includeGuestTasks) {
      mergeTaskRecords([...tasks, ...deletedTasks], guestTasks, guestDeletedTasks);
      saveTasks();
      render();
    }
    updateCloudStatus("Couldn't reach Supabase. Your local tasks are still available; try Sync now.", "error");
  }
}

function updateAccountControls() {
  const signedIn = Boolean(cloudSession);
  $("#account-button").textContent = signedIn ? "Cloud account" : "Sign in to sync";
  $("#storage-label").textContent = signedIn ? "Cloud sync enabled" : "Your tasks are saved locally";
  $("#signed-out-panel").hidden = signedIn;
  $("#signed-in-panel").hidden = !signedIn;
  $("#signed-in-email").textContent = cloudSession?.user.email || "";
  if (!cloudConfig.url || !cloudConfig.publishableKey) {
    updateCloudStatus("Add your Supabase Project URL and publishable key to supabase-config.js to enable cloud sync.", "error");
  } else if (!supabaseClient) {
    updateCloudStatus("Supabase could not initialize. Check its project settings and your network connection.", "error");
  } else if (!signedIn && !$("#account-status").textContent) {
    updateCloudStatus("Your tasks currently save only in this browser.", "neutral");
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function dateLabel(task) {
  if (!task.dueDate) return `<span class="due-date">◷ No due date</span>`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${task.dueDate}T00:00:00`);
  const diff = Math.round((due - today) / 86400000);
  const type = task.status === "completed" ? "done-date" : diff < 0 ? "overdue" : diff === 0 ? "today" : "";
  const label = task.status === "completed" ? formatDate(task.dueDate) : diff < 0 ? `Overdue · ${formatDate(task.dueDate)}` : diff === 0 ? "Due today" : formatDate(task.dueDate);
  return `<span class="due-date ${type}">◷ ${escapeHTML(label)}</span>`;
}

function taskCard(task) {
  const completed = task.status === "completed";
  const safeId = escapeHTML(task.id);
  const subtasks = task.subtasks || [];
  const finishedSubtasks = subtasks.filter(subtask => subtask.completed).length;
  const statusOptions = [
    ["pending", "To do"], ["in-progress", "In progress"], ["completed", "Completed"]
  ].map(([value, label]) => `<option value="${value}" ${task.status === value ? "selected" : ""}>${label}</option>`).join("");
  return `<article class="task-item ${completed ? "is-completed" : ""}" data-task-id="${safeId}">
    <input class="task-check" type="checkbox" aria-label="Mark ${escapeHTML(task.title)} ${completed ? "not completed" : "completed"}" ${completed ? "checked" : ""} data-action="complete">
    <div class="task-main">
      <div class="task-title-line"><h3 class="task-title">${escapeHTML(task.title)}</h3><button class="favorite-toggle ${task.favorite ? "is-favorite" : ""}" type="button" data-action="favorite" aria-label="${task.favorite ? "Remove from" : "Add to"} favorites" aria-pressed="${Boolean(task.favorite)}" title="${task.favorite ? "Remove from favorites" : "Add to favorites"}">${task.favorite ? "★" : "☆"}</button></div>
      ${task.description ? `<p class="task-description">${escapeHTML(task.description)}</p>` : ""}
      ${subtasks.length ? `<div class="subtasks"><div class="subtasks-progress">${finishedSubtasks}/${subtasks.length} steps</div>${subtasks.map(subtask => `<label class="subtask-row ${subtask.completed ? "is-done" : ""}"><input type="checkbox" data-action="subtask" data-subtask-id="${escapeHTML(subtask.id)}" ${subtask.completed ? "checked" : ""}><span>${escapeHTML(subtask.title)}</span></label>`).join("")}</div>` : ""}
      <div class="task-meta">
        <span class="tag category-tag" data-category="${escapeHTML(task.category)}">${escapeHTML(task.category)}</span>
        <span class="tag priority-tag ${task.priority}">${escapeHTML(task.priority[0].toUpperCase() + task.priority.slice(1))}</span>
        ${dateLabel(task)}
      </div>
    </div>
    <div class="task-actions">
      <label class="visually-hidden" for="status-${safeId}">Update ${escapeHTML(task.title)} status</label>
      <select class="status-select" id="status-${safeId}" data-action="status">${statusOptions}</select>
      <button class="task-action" type="button" data-action="edit" aria-label="Edit ${escapeHTML(task.title)}" title="Edit task">✎</button>
      <button class="task-action delete" type="button" data-action="delete" aria-label="Delete ${escapeHTML(task.title)}" title="Delete task">×</button>
    </div>
  </article>`;
}

function getVisibleTasks() {
  const query = $("#search-input").value.trim().toLocaleLowerCase();
  const priority = $("#priority-filter").value;
  const sort = $("#sort-select").value;
  const visible = tasks.filter(task =>
    (currentView === "all" || currentView === "calendar" || (currentView === "favorites" ? Boolean(task.favorite) : task.status === currentView)) &&
    (selectedCategory === "all" || task.category === selectedCategory) &&
    (priority === "all" || task.priority === priority) &&
    task.title.toLocaleLowerCase().includes(query)
  );
  visible.sort((a, b) => {
    if (sort === "priority") return priorityOrder[a.priority] - priorityOrder[b.priority];
    if (sort === "created") return b.createdAt.localeCompare(a.createdAt);
    const aDate = a.dueDate || (sort === "due-asc" ? "9999-12-31" : "0000-01-01");
    const bDate = b.dueDate || (sort === "due-asc" ? "9999-12-31" : "0000-01-01");
    return sort === "due-asc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
  });
  return visible;
}

function renderFilters() {
  const active = [];
  const viewLabels = { pending: "To do", "in-progress": "In progress", completed: "Completed", favorites: "Favorites", calendar: "Calendar" };
  if (currentView !== "all") active.push(viewLabels[currentView]);
  if (selectedCategory !== "all") active.push(selectedCategory);
  if ($("#priority-filter").value !== "all") active.push(`${$("#priority-filter").value} priority`);
  if ($("#search-input").value.trim()) active.push(`Search: ${$("#search-input").value.trim()}`);
  const container = $("#active-filters");
  container.innerHTML = active.map(filter => `<span class="filter-chip">${escapeHTML(filter)}</span>`).join("");
  container.hidden = active.length === 0;
}

function renderTasks() {
  const visible = getVisibleTasks();
  const calendarMode = currentView === "calendar";
  $("#calendar-view").hidden = !calendarMode;
  taskList.innerHTML = (calendarMode ? visible.filter(task => task.dueDate === calendarSelectedDate) : visible).map(taskCard).join("");
  $("#task-count").textContent = String(calendarMode ? visible.filter(task => task.dueDate === calendarSelectedDate).length : visible.length);
  $("#task-heading").firstChild.textContent = ({
    all: "All tasks ", pending: "To do ", "in-progress": "In progress ", completed: "Completed ",
    favorites: "Favorites ", calendar: "Calendar "
  })[currentView];
  const displayed = calendarMode ? visible.filter(task => task.dueDate === calendarSelectedDate) : visible;
  $("#empty-state").hidden = displayed.length > 0;
  taskList.hidden = displayed.length === 0;
  $("#empty-title").textContent = tasks.length === 0 ? "A clean slate." : "No tasks found.";
  $("#empty-copy").textContent = calendarMode
    ? `No tasks due ${formatDate(calendarSelectedDate)}. Choose another date or add a due date to a task.`
    : tasks.length === 0 ? "Add a task and make your next move." : "Try a different search or adjust your filters.";
  $("#empty-add").hidden = tasks.length > 0 || calendarMode;
  $("#clear-completed").disabled = !tasks.some(task => task.status === "completed");
  if (calendarMode) renderCalendar(visible);
  renderFilters();
}

function renderStats() {
  const completed = tasks.filter(task => task.status === "completed").length;
  const progress = tasks.filter(task => task.status === "in-progress").length;
  const pending = tasks.filter(task => task.status === "pending").length;
  const percent = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  $("#stat-total").textContent = String(tasks.length);
  $("#stat-pending").textContent = String(pending);
  $("#stat-progress").textContent = String(progress);
  $("#stat-completed").textContent = String(completed);
  $("#stat-percent").textContent = `${percent}%`;
  $("#progress-bar").style.width = `${percent}%`;
  $("#nav-pending-count").textContent = String(tasks.filter(task => task.status === "pending").length);
}

function render() {
  renderStats();
  renderTasks();
}

function renderCalendar(visibleTasks = getVisibleTasks()) {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  $("#calendar-month").textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(calendarMonth);
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const previousMonthDays = new Date(year, month, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    let day = index - firstWeekday + 1;
    let date = new Date(year, month, day);
    let outside = false;
    if (day < 1) {
      day = previousMonthDays + day;
      date = new Date(year, month - 1, day);
      outside = true;
    } else if (day > daysInMonth) {
      day -= daysInMonth;
      date = new Date(year, month + 1, day);
      outside = true;
    }
    const dateKey = localDateKey(date);
    const dueTasks = visibleTasks.filter(task => task.dueDate === dateKey);
    const isToday = dateKey === localDateKey(new Date());
    const selected = dateKey === calendarSelectedDate;
    return `<button type="button" class="calendar-day ${outside ? "outside-month" : ""} ${isToday ? "is-today" : ""} ${selected ? "is-selected" : ""} ${dueTasks.length ? "has-tasks" : ""}" data-date="${dateKey}" aria-label="${escapeHTML(new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date))}${dueTasks.length ? `, ${dueTasks.length} task${dueTasks.length === 1 ? "" : "s"}` : ""}" aria-pressed="${selected}"><span>${day}</span>${dueTasks.length ? `<span class="calendar-task-count">${dueTasks.length}</span>` : ""}</button>`;
  });
  $("#calendar-days").innerHTML = cells.join("");
  const selectedDate = new Date(`${calendarSelectedDate}T00:00:00`);
  const dueCount = visibleTasks.filter(task => task.dueDate === calendarSelectedDate).length;
  $("#calendar-selection").textContent = `${new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(selectedDate)} · ${dueCount} task${dueCount === 1 ? "" : "s"} due`;
}

function renderSubtaskDrafts() {
  $("#subtask-draft-list").innerHTML = draftSubtasks.map((subtask, index) =>
    `<li class="subtask-draft ${subtask.completed ? "is-done" : ""}"><label><input type="checkbox" data-draft-action="toggle" data-index="${index}" ${subtask.completed ? "checked" : ""}><span>${escapeHTML(subtask.title)}</span></label><button type="button" data-draft-action="remove" data-index="${index}" aria-label="Remove subtask">×</button></li>`
  ).join("");
}

function addDraftSubtask() {
  const input = $("#subtask-input");
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }
  draftSubtasks.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    completed: false
  });
  input.value = "";
  renderSubtaskDrafts();
  input.focus();
}

function changeCalendarMonth(amount) {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + amount, 1);
  renderTasks();
}

function resetForm() {
  taskForm.reset();
  draftSubtasks = [];
  renderSubtaskDrafts();
  $("#task-id").value = "";
  $("#task-status").value = "pending";
  $("#task-priority").value = "medium";
  $("#dialog-title").textContent = "Create a task";
  $("#dialog-kicker").textContent = "BUILD YOUR MOMENTUM";
  $("#save-task").textContent = "Create task";
}

function openCreateDialog() {
  resetForm();
  dialog.showModal();
  $("#task-title").focus();
}

function openEditDialog(task) {
  resetForm();
  $("#task-id").value = task.id;
  $("#task-title").value = task.title;
  $("#task-description").value = task.description;
  $("#task-category").value = task.category;
  $("#task-priority").value = task.priority;
  $("#task-due-date").value = task.dueDate;
  $("#task-status").value = task.status;
  draftSubtasks = (task.subtasks || []).map(subtask => ({ ...subtask }));
  renderSubtaskDrafts();
  $("#dialog-title").textContent = "Edit task";
  $("#dialog-kicker").textContent = "KEEP YOUR MOMENTUM";
  $("#save-task").textContent = "Save changes";
  dialog.showModal();
  $("#task-title").focus();
}

function handleTaskSubmit(event) {
  event.preventDefault();
  if (!taskForm.reportValidity()) return;
  const id = $("#task-id").value;
  const existing = tasks.find(task => task.id === id);
  const now = new Date().toISOString();
  const task = {
    id: existing ? existing.id : (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    title: $("#task-title").value.trim(),
    description: $("#task-description").value.trim(),
    category: $("#task-category").value,
    priority: $("#task-priority").value,
    dueDate: $("#task-due-date").value,
    status: $("#task-status").value,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    favorite: existing ? Boolean(existing.favorite) : false,
    subtasks: draftSubtasks.map(subtask => ({ ...subtask }))
  };
  if (!task.title) {
    $("#task-title").setCustomValidity("Please enter a task title.");
    $("#task-title").reportValidity();
    $("#task-title").setCustomValidity("");
    return;
  }
  if (existing) tasks = tasks.map(item => item.id === id ? task : item);
  else tasks.unshift(task);
  deletedTasks = deletedTasks.filter(item => item.id !== task.id);
  const saved = saveTasks();
  dialog.close();
  resetForm();
  render();
  if (saved) showToast(existing ? "Task updated." : "Task added to your workspace.");
}

function handleTaskAction(event) {
  const control = event.target.closest("[data-action]");
  const card = event.target.closest("[data-task-id]");
  if (!control || !card) return;
  const action = control.dataset.action;
  if (event.type === "click" && action !== "edit" && action !== "delete" && action !== "favorite") return;
  if (event.type === "change" && action !== "status" && action !== "complete" && action !== "subtask") return;
  const task = tasks.find(item => item.id === card.dataset.taskId);
  if (!task) return;
  if (action === "favorite") task.favorite = !task.favorite;
  if (action === "complete") task.status = control.checked ? "completed" : "pending";
  if (action === "status") task.status = control.value;
  if (action === "edit") return openEditDialog(task);
  if (action === "subtask") {
    task.subtasks = task.subtasks || [];
    const subtask = task.subtasks.find(item => item.id === control.dataset.subtaskId);
    if (!subtask) return;
    subtask.completed = control.checked;
  }
  task.updatedAt = new Date().toISOString();
  if (action === "delete") {
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
    deletedTasks = [...deletedTasks.filter(item => item.id !== task.id), { ...task, deleted: true }];
    tasks = tasks.filter(item => item.id !== task.id);
  }
  const saved = saveTasks();
  render();
  if (saved && action === "delete") showToast("Task deleted.");
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".nav-link[data-view]").forEach(link => link.classList.toggle("active", link.dataset.view === view));
  document.querySelectorAll(".mobile-nav-link[data-mobile-view]").forEach(link => {
    const active = link.dataset.mobileView === view || (view === "in-progress" && link.dataset.mobileView === "pending") ||
      (view === "completed" && link.dataset.mobileView === "pending");
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#mobile-status-filter").value = view;
  renderTasks();
}

async function fetchJSON(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
  return response.json();
}

async function loadQuote() {
  const status = $("#quote-status");
  const button = $("#refresh-quote");
  button.disabled = true;
  status.textContent = "Finding a little inspiration...";
  try {
    const data = await fetchJSON("https://api.adviceslip.com/advice");
    if (!data.slip || typeof data.slip.advice !== "string") throw new Error("The advice response was incomplete.");
    $("#quote-text").textContent = data.slip.advice;
    $("#quote-author").textContent = "— A little advice for today";
    status.textContent = "";
  } catch (error) {
    status.textContent = "Couldn't refresh right now. Your saved inspiration is still here.";
    console.error("Unable to load daily inspiration:", error);
  } finally {
    button.disabled = false;
  }
}

async function loadSamples() {
  const button = $("#load-samples");
  const status = $("#sample-status");
  button.disabled = true;
  status.textContent = "Loading sample tasks...";
  try {
    const data = await fetchJSON("https://dummyjson.com/todos?limit=5");
    if (!Array.isArray(data.todos)) throw new Error("The sample task response was incomplete.");
    sampleTasks = data.todos.map(todo => ({ id: `sample-${todo.id}`, title: todo.todo, completed: todo.completed }));
    renderSamples();
    status.textContent = sampleTasks.length ? "Choose a sample to add it to your tasks." : "No sample tasks are available right now.";
  } catch (error) {
    status.textContent = "Sample tasks couldn't be loaded. Please try again.";
    console.error("Unable to load sample tasks:", error);
  } finally {
    button.disabled = false;
  }
}

async function loadWeather() {
  const button = $("#load-weather");
  const status = $("#weather-status");
  if (!navigator.geolocation) {
    status.textContent = "Location is not available in this browser.";
    return;
  }
  button.disabled = true;
  status.textContent = "Getting your location...";
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
    const params = new URLSearchParams({
      latitude: String(position.coords.latitude),
      longitude: String(position.coords.longitude),
      current: "temperature_2m,weather_code",
      timezone: "auto"
    });
    const data = await fetchJSON(`https://api.open-meteo.com/v1/forecast?${params}`);
    const current = data.current;
    if (!current || typeof current.temperature_2m !== "number" || typeof current.weather_code !== "number") {
      throw new Error("The weather response was incomplete.");
    }
    const weather = describeWeather(current.weather_code);
    $("#weather-icon").textContent = weather.icon;
    $("#weather-heading").textContent = `${Math.round(current.temperature_2m)}${data.current_units?.temperature_2m || "°C"}`;
    $("#weather-reading").textContent = weather.label;
    status.textContent = "Forecast based on your current location.";
  } catch (error) {
    console.error("Unable to load local weather:", error);
    status.textContent = error.code === 1
      ? "Location permission was denied. Allow it in your browser to see local weather."
      : "Couldn't load weather right now. Try again when location and network access are available.";
  } finally {
    button.disabled = false;
  }
}

function describeWeather(code) {
  if (code === 0) return { icon: "☀", label: "Clear skies" };
  if ([1, 2].includes(code)) return { icon: "🌤", label: "Mostly clear" };
  if (code === 3) return { icon: "☁", label: "Overcast" };
  if ([45, 48].includes(code)) return { icon: "🌫", label: "Foggy" };
  if ([51, 53, 55, 56, 57].includes(code)) return { icon: "🌦", label: "Drizzle" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { icon: "🌧", label: "Rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: "❄", label: "Snow" };
  if ([95, 96, 99].includes(code)) return { icon: "⛈", label: "Thunderstorm" };
  return { icon: "☁", label: "Changing conditions" };
}

function renderSamples() {
  $("#sample-list").innerHTML = sampleTasks.map(sample => {
    const added = tasks.some(task => task.sourceId === sample.id);
    return `<div class="sample-item"><span class="sample-title">${escapeHTML(sample.title)}</span><button type="button" class="sample-add" data-sample-id="${escapeHTML(sample.id)}" ${added ? "disabled" : ""}>${added ? "Added" : "+ Add"}</button></div>`;
  }).join("");
}

function addSample(id) {
  const sample = sampleTasks.find(item => item.id === id);
  if (!sample || tasks.some(task => task.sourceId === id)) return;
  const now = new Date().toISOString();
  tasks.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sourceId: sample.id,
    title: sample.title,
    description: "A sample idea from the DummyJSON Todos API.",
    category: "Other",
    priority: "medium",
    dueDate: "",
    status: sample.completed ? "completed" : "pending",
    createdAt: now,
    updatedAt: now
  });
  const saved = saveTasks();
  render();
  renderSamples();
  if (saved) showToast("Sample task added.");
}

function exportTasks() {
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "tasket-tasks.json";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Your tasks have been exported.");
}

async function importTasks(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data) || !data.every(isValidTask)) {
      throw new Error("The file must contain a valid Tasket task list.");
    }
    const existingIds = new Set(tasks.map(task => task.id));
    const imported = data.filter(task => {
      if (existingIds.has(task.id)) return false;
      existingIds.add(task.id);
      return true;
    });
    deletedTasks = deletedTasks.filter(task => !imported.some(item => item.id === task.id));
    tasks = [...imported, ...tasks];
    const saved = saveTasks();
    render();
    if (saved) showToast(imported.length ? `Imported ${imported.length} task${imported.length === 1 ? "" : "s"}.` : "No new tasks found in that file.");
  } catch (error) {
    console.error("Unable to import tasks:", error);
    showToast(error instanceof SyntaxError ? "That file isn't valid JSON." : "Couldn't import the file. Check that it's a valid Tasket export.");
  } finally {
    $("#import-file").value = "";
  }
}

function setTheme(theme) {
  const dark = theme === "dark";
  document.body.classList.toggle("dark-mode", dark);
  $("#theme-label").textContent = dark ? "Light mode" : "Dark mode";
  $("#theme-icon").textContent = dark ? "☼" : "◐";
  $("#theme-topbar-icon").textContent = dark ? "☼" : "◐";
  $("#theme-toggle-topbar").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
  $("#theme-toggle-topbar").setAttribute("title", `Switch to ${dark ? "light" : "dark"} mode`);
}

function toggleTheme() {
  const theme = document.body.classList.contains("dark-mode") ? "light" : "dark";
  setTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    console.error("Unable to save theme preference:", error);
    showToast("Theme changed, but the preference could not be saved.");
  }
}

async function initialize() {
  tasks = loadTasks();
  guestTasks = tasks.slice();
  guestDeletedTasks = deletedTasks.slice();
  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem(THEME_KEY) || "light";
  } catch (error) {
    console.error("Unable to load theme preference:", error);
  }
  setTheme(savedTheme === "dark" ? "dark" : "light");
  const today = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  $("#today-label").textContent = today.toUpperCase();
  $("#open-create").addEventListener("click", openCreateDialog);
  $("#empty-add").addEventListener("click", openCreateDialog);
  $("#close-dialog").addEventListener("click", () => dialog.close());
  $("#cancel-dialog").addEventListener("click", () => dialog.close());
  taskForm.addEventListener("submit", handleTaskSubmit);
  $("#add-subtask").addEventListener("click", addDraftSubtask);
  $("#subtask-input").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      addDraftSubtask();
    }
  });
  $("#subtask-draft-list").addEventListener("click", event => {
    const button = event.target.closest("[data-draft-action]");
    if (!button) return;
    const index = Number(button.dataset.index);
    if (button.dataset.draftAction === "remove") draftSubtasks.splice(index, 1);
    else if (button.dataset.draftAction === "toggle") draftSubtasks[index].completed = button.checked;
    renderSubtaskDrafts();
  });
  taskList.addEventListener("click", handleTaskAction);
  taskList.addEventListener("change", handleTaskAction);
  document.querySelectorAll(".nav-link[data-view]").forEach(link => link.addEventListener("click", () => {
    setView(link.dataset.view);
    setMobileNavigationOpen(false);
  }));
  document.querySelectorAll(".category-link").forEach(link => link.addEventListener("click", () => {
    selectedCategory = selectedCategory === link.dataset.category ? "all" : link.dataset.category;
    $("#mobile-category-filter").value = selectedCategory;
    document.querySelectorAll(".category-link").forEach(item => item.classList.toggle("active", selectedCategory === item.dataset.category));
    renderTasks();
    setMobileNavigationOpen(false);
  }));
  $("#reset-category").addEventListener("click", () => {
    selectedCategory = "all";
    $("#mobile-category-filter").value = "all";
    document.querySelectorAll(".category-link").forEach(item => item.classList.remove("active"));
    renderTasks();
    setMobileNavigationOpen(false);
  });
  $("#mobile-menu-toggle").addEventListener("click", () => {
    setMobileNavigationOpen(!$("#sidebar").classList.contains("is-open"));
  });
  $("#sidebar-backdrop").addEventListener("click", () => setMobileNavigationOpen(false));
  document.querySelectorAll(".mobile-nav-link[data-mobile-view]").forEach(link => {
    link.addEventListener("click", () => {
      setView(link.dataset.mobileView);
      setMobileNavigationOpen(false);
      document.body.classList.remove("mobile-search-open");
      $("#mobile-search-toggle").setAttribute("aria-expanded", "false");
    });
  });
  $("#mobile-add-task").addEventListener("click", openCreateDialog);
  $("#mobile-search-toggle").addEventListener("click", () => {
    const isOpen = document.body.classList.toggle("mobile-search-open");
    $("#mobile-search-toggle").setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      $("#search-input").focus();
      $("#search-input").scrollIntoView({ block: "center", behavior: "smooth" });
    } else $("#search-input").blur();
  });
  $("#mobile-status-filter").addEventListener("change", event => setView(event.target.value));
  $("#mobile-category-filter").addEventListener("change", event => {
    selectedCategory = event.target.value;
    document.querySelectorAll(".category-link").forEach(item => item.classList.toggle("active", selectedCategory === item.dataset.category));
    renderTasks();
  });
  $("#calendar-days").addEventListener("click", event => {
    const day = event.target.closest("[data-date]");
    if (!day) return;
    calendarSelectedDate = day.dataset.date;
    const [year, month] = calendarSelectedDate.split("-").map(Number);
    calendarMonth = new Date(year, month - 1, 1);
    renderTasks();
  });
  $("#calendar-previous").addEventListener("click", () => changeCalendarMonth(-1));
  $("#calendar-next").addEventListener("click", () => changeCalendarMonth(1));
  $("#calendar-today").addEventListener("click", () => {
    const today = new Date();
    calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    calendarSelectedDate = localDateKey(today);
    renderTasks();
  });
  $("#search-input").addEventListener("input", renderTasks);
  $("#priority-filter").addEventListener("change", renderTasks);
  $("#sort-select").addEventListener("change", renderTasks);
  $("#clear-completed").addEventListener("click", () => {
    const completed = tasks.filter(task => task.status === "completed").length;
    if (!completed || !window.confirm(`Clear ${completed} completed task${completed === 1 ? "" : "s"}?`)) return;
    const now = new Date().toISOString();
    deletedTasks = [
      ...deletedTasks,
      ...tasks.filter(task => task.status === "completed").map(task => ({ ...task, updatedAt: now, deleted: true }))
    ];
    tasks = tasks.filter(task => task.status !== "completed");
    const saved = saveTasks();
    render();
    if (saved) showToast("Completed tasks cleared.");
  });
  $("#refresh-quote").addEventListener("click", loadQuote);
  $("#load-samples").addEventListener("click", loadSamples);
  $("#load-weather").addEventListener("click", loadWeather);
  $("#sample-list").addEventListener("click", event => {
    const button = event.target.closest("[data-sample-id]");
    if (button) addSample(button.dataset.sampleId);
  });
  $("#export-button").addEventListener("click", exportTasks);
  $("#import-file").addEventListener("change", event => {
    if (event.target.files[0]) importTasks(event.target.files[0]);
  });
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#theme-toggle-topbar").addEventListener("click", toggleTheme);
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#search-input").focus();
    }
    if (event.key === "Escape") {
      if (dialog.open) dialog.close();
      setMobileNavigationOpen(false);
      document.body.classList.remove("mobile-search-open");
      $("#mobile-search-toggle").setAttribute("aria-expanded", "false");
    }
  });
  $("#account-button").addEventListener("click", () => {
    updateAccountControls();
    $("#account-dialog").showModal();
  });
  $("#close-account-dialog").addEventListener("click", () => $("#account-dialog").close());
  $("#auth-form").addEventListener("submit", handleAuthSubmit);
  $("#resend-confirmation").addEventListener("click", handleResendConfirmation);
  $("#password-visibility-toggle").addEventListener("click", event => {
    const password = $("#auth-password");
    const isVisible = password.type === "text";
    password.type = isVisible ? "password" : "text";
    event.currentTarget.textContent = isVisible ? "Show" : "Hide";
    event.currentTarget.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
    event.currentTarget.setAttribute("aria-pressed", String(!isVisible));
  });
  $("#auth-mode-toggle").addEventListener("click", () => {
    authMode = authMode === "sign-in" ? "sign-up" : "sign-in";
    $("#auth-submit").textContent = authMode === "sign-in" ? "Sign in" : "Create account";
    $("#auth-password").autocomplete = authMode === "sign-in" ? "current-password" : "new-password";
    $("#auth-mode-toggle").textContent = authMode === "sign-in" ? "New here? Create an account" : "Already have an account? Sign in";
    $("#resend-confirmation").hidden = true;
    updateAccountControls();
  });
  $("#sync-now").addEventListener("click", async () => {
    if (!cloudSession) return;
    updateCloudStatus("Refreshing cloud tasks...", "neutral");
    try {
      await pullCloudTasks(cloudSession);
    } catch (error) {
      console.error("Unable to refresh cloud tasks:", error);
      updateCloudStatus("Couldn't refresh from the cloud. Your local tasks are unchanged.", "error");
    }
  });
  $("#sign-out").addEventListener("click", handleSignOut);
  $("#task-title").addEventListener("input", event => event.target.setCustomValidity(""));
  if (cloudConfig.url && cloudConfig.publishableKey) {
    try {
      if (!window.supabase?.createClient) throw new Error("Supabase client library did not load.");
      supabaseClient = window.supabase.createClient(cloudConfig.url, cloudConfig.publishableKey, {
        auth: { detectSessionInUrl: true }
      });
    } catch (error) {
      console.error("Unable to initialize Supabase:", error);
      updateCloudStatus("Supabase setup is invalid or its client library could not load.", "error");
    }
  }
  updateAccountControls();
  render();
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      if (data.session) await activateCloudSession(data.session);
    } catch (error) {
      console.error("Unable to restore Supabase session:", error);
      updateCloudStatus("Could not restore your cloud session. Sign in again.", "error");
    }
  }
  const redirectError = getAuthRedirectError();
  if (redirectError) {
    updateCloudStatus(`The email link could not be completed: ${redirectError}`, "error");
    $("#resend-confirmation").hidden = false;
    $("#account-dialog").showModal();
  }
  loadQuote();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!supabaseClient) {
    updateAccountControls();
    return;
  }
  const button = $("#auth-submit");
  button.disabled = true;
  updateCloudStatus(authMode === "sign-in" ? "Signing in..." : "Creating your account...", "neutral");
  try {
    const credentials = {
      email: $("#auth-email").value.trim(),
      password: $("#auth-password").value
    };
    const result = authMode === "sign-in"
      ? await supabaseClient.auth.signInWithPassword(credentials)
      : await supabaseClient.auth.signUp({
        ...credentials,
        options: { emailRedirectTo: getAuthRedirectUrl() }
      });
    if (result.error) throw result.error;
    if (!result.data.session) {
      updateCloudStatus("Use the link in your email to confirm your account, then return here to sign in.", "success");
      $("#resend-confirmation").hidden = false;
      return;
    }
    await activateCloudSession(result.data.session, true);
    $("#account-dialog").close();
    showToast("Your tasks are now syncing with Supabase.");
  } catch (error) {
    console.error("Supabase authentication failed:", error);
    const message = error.message || "Authentication failed. Please try again.";
    if (/email not confirmed|email_not_confirmed/i.test(message)) {
      $("#resend-confirmation").hidden = false;
      updateCloudStatus("Confirm your email before signing in. You can send a fresh confirmation link below.", "error");
    } else if (/invalid login credentials/i.test(message)) {
      updateCloudStatus("That email and password do not match. If you just registered, confirm your email first; resend the link if it expired.", "error");
    } else if (/redirect|url|allow/i.test(message)) {
      updateCloudStatus(`${message} Add https://alfia-ashraf.github.io/TaskFlow/ to Supabase Authentication → URL Configuration → Redirect URLs.`, "error");
    } else {
      updateCloudStatus(message, "error");
    }
  } finally {
    button.disabled = false;
  }
}

async function handleResendConfirmation() {
  if (!supabaseClient) {
    updateAccountControls();
    return;
  }
  const emailInput = $("#auth-email");
  emailInput.setCustomValidity("");
  if (!emailInput.value.trim() || !emailInput.validity.valid) {
    emailInput.reportValidity();
    return;
  }
  const button = $("#resend-confirmation");
  button.disabled = true;
  updateCloudStatus("Sending a new confirmation email...", "neutral");
  try {
    const { error } = await supabaseClient.auth.resend({
      type: "signup",
      email: emailInput.value.trim(),
      options: { emailRedirectTo: getAuthRedirectUrl() }
    });
    if (error) throw error;
    updateCloudStatus("If this address has an unconfirmed account, a new confirmation email is on its way.", "success");
  } catch (error) {
    console.error("Unable to resend the confirmation email:", error);
    const redirectHint = /redirect|url|allow/i.test(error.message || "")
      ? " Add the deployed Tasket URL to Supabase Authentication → URL Configuration → Redirect URLs."
      : "";
    updateCloudStatus(`${error.message || "Could not resend the confirmation email."}${redirectHint}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function handleSignOut() {
  if (!supabaseClient || !cloudSession) return;
  updateCloudStatus("Finishing pending sync...", "neutral");
  await cloudSyncQueue;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
  } catch (error) {
    console.error("Unable to sign out of Supabase:", error);
    updateCloudStatus("Sign out failed. Please try again.", "error");
    return;
  }
  cloudSession = null;
  activeTasksKey = TASKS_KEY;
  activeDeletedKey = DELETED_KEY;
  tasks = guestTasks.slice();
  deletedTasks = guestDeletedTasks.slice();
  updateAccountControls();
  updateCloudStatus("Signed out. Your guest tasks remain on this device.", "neutral");
  render();
}

initialize();
