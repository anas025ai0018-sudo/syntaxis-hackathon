
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const STORAGE_KEY = "medisync-demo-records-v1";
const ACTIVITY_KEY = "medisync-demo-activity-v1";
const ACTIVE_MODE_KEY = "medisync-active-mode-v1";
const ACTIVE_DOCTOR_KEY = "medisync-active-doctor-v1";
const SIGNED_OUT_KEY = "medisync-signed-out-v1";
const MAX_REPORT_IMAGE_SIZE = 1_500_000;
const OFFLINE_DB_NAME = "medisync-offline-v1";
const OFFLINE_DB_VERSION = 2;
const LEGACY_OFFLINE_RECORDS_STORE = "visits";
const OFFLINE_RECORDS_STORE = "visits-by-owner";

function loadData(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

let records = [];
let activities = [];
let appMode = "locked";
let currentDoctor = null;
let currentDoctorId = null;
let toastTimer;
let currentReportImage = "";
let offlineDbPromise;
let recordsReady = Promise.resolve();
let syncInProgress = false;
let apiAvailable = false;
let backendCheckInProgress = false;

const reportImageInput = document.querySelector("#report-image-input");
const reportCameraInput = document.querySelector("#report-camera-input");
const reportImagePreview = document.querySelector("#report-image-preview");
const reportImageThumb = document.querySelector("#report-image-thumb");
const reportImageName = document.querySelector("#report-image-name");
const clearReportImageButton = document.querySelector("#clear-report-image");

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function clearReportImageSelection() {
  currentReportImage = "";
  if (reportImageInput) reportImageInput.value = "";
  if (reportCameraInput) reportCameraInput.value = "";
  if (reportImagePreview) reportImagePreview.hidden = true;
  if (reportImageThumb) reportImageThumb.removeAttribute("src");
  if (reportImageName) {
    reportImageName.textContent = "No image selected. Choose a file or take a photo.";
  }
}

function setReportImagePreview(dataUrl) {
  currentReportImage = dataUrl || "";
  if (!reportImagePreview || !reportImageThumb) return;

  if (!dataUrl) {
    reportImagePreview.hidden = true;
    reportImageThumb.removeAttribute("src");
    return;
  }

  reportImageThumb.src = dataUrl;
  reportImagePreview.hidden = false;
}

function handleReportImageChange(event) {
  const input = event.currentTarget;
  const file = input.files && input.files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    clearReportImageSelection();
    showToast("Please choose an image file.");
    return;
  }

  if (file.size > MAX_REPORT_IMAGE_SIZE) {
    clearReportImageSelection();
    showToast("Image is too large. Please choose a smaller file under 1.5MB.");
    return;
  }

  fileToDataUrl(file)
    .then((dataUrl) => {
      setReportImagePreview(dataUrl);
      if (reportImageName) reportImageName.textContent = file.name;
      if (reportImageInput !== input) reportImageInput.value = "";
      if (reportCameraInput !== input) reportCameraInput.value = "";
    })
    .catch((error) => {
      clearReportImageSelection();
      console.error(error);
      showToast("Could not read the selected image.");
    });
}

function openOfflineDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("This browser does not support offline storage."));
  }
  if (offlineDbPromise) return offlineDbPromise;

  offlineDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OFFLINE_RECORDS_STORE)) {
        database.createObjectStore(OFFLINE_RECORDS_STORE, { keyPath: "storageKey" });
      }
      if (database.objectStoreNames.contains(LEGACY_OFFLINE_RECORDS_STORE)) {
        const transaction = request.transaction;
        const legacyRequest = transaction
          .objectStore(LEGACY_OFFLINE_RECORDS_STORE)
          .getAll();
        legacyRequest.onsuccess = () => {
          const scopedStore = transaction.objectStore(OFFLINE_RECORDS_STORE);
          legacyRequest.result.forEach(record => {
            const ownerId = record.ownerId || null;
            scopedStore.put({
              ...record,
              ownerId,
              storageKey: `${ownerId || "demo"}:${record.id}`
            });
          });
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      offlineDbPromise = null;
      reject(request.error || new Error("Could not open offline storage."));
    };
    request.onblocked = () => {
      offlineDbPromise = null;
      reject(new Error("Offline storage is blocked by another open app tab."));
    };
  });

  return offlineDbPromise;
}

async function readOfflineRecords() {
  const database = await openOfflineDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OFFLINE_RECORDS_STORE, "readonly");
    const request = transaction.objectStore(OFFLINE_RECORDS_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not read offline visits."));
    transaction.onabort = () => reject(transaction.error || new Error("Could not read offline visits."));
  });
}

async function persistRecords() {
  try {
    const database = await openOfflineDatabase();
    const ownerId = currentDoctorId;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_RECORDS_STORE, "readwrite");
      const store = transaction.objectStore(OFFLINE_RECORDS_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        request.result.forEach(record => {
          if ((record.ownerId || null) === ownerId) store.delete(record.storageKey);
        });
        records.forEach(record => store.put({
          ...record,
          ownerId,
          storageKey: `${ownerId || "demo"}:${record.id}`
        }));
      };
      request.onerror = () => reject(request.error || new Error("Could not save visits offline."));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save visits offline."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not save visits offline."));
    });
    return true;
  } catch (error) {
    try {
      localStorage.setItem(recordsStorageKey(), JSON.stringify(records));
      return true;
    } catch (storageError) {
      console.error("Could not persist visits on this device:", error, storageError);
      showToast("Could not save on this device. Free storage space and try again.");
      return false;
    }
  }
}

async function initializeOfflineRecords() {
  try {
    const allStoredRecords = await readOfflineRecords();
    const storedRecords = allStoredRecords.filter(
      record => (record.ownerId || null) === currentDoctorId
    );
    const knownIds = new Set(storedRecords.map(record => record.id));
    const legacyRecords = loadData(recordsStorageKey());
    const migratedRecords = legacyRecords.filter(record => !knownIds.has(record.id));

    records = [...storedRecords, ...migratedRecords].map(record => ({
      ...record,
      ownerId: currentDoctorId
    }));
    if (migratedRecords.length || !storedRecords.length) {
      if (!(await persistRecords())) {
        throw new Error("Could not initialize offline visit storage.");
      }
    }
  } catch (error) {
    console.error("Offline visit storage could not be initialized:", error);
    showToast(error.message || "Offline storage is unavailable.");
    records = loadData(recordsStorageKey()).map(record => ({
      ...record,
      ownerId: currentDoctorId
    }));
  }

  activities = loadData(activityStorageKey());
}

function recordsStorageKey() {
  return currentDoctorId
    ? `medisync-doctor-records-${encodeURIComponent(currentDoctorId)}`
    : STORAGE_KEY;
}

function activityStorageKey() {
  return currentDoctorId
    ? `medisync-doctor-activity-${encodeURIComponent(currentDoctorId)}`
    : ACTIVITY_KEY;
}

function saveActivities() {
  try {
    localStorage.setItem(activityStorageKey(), JSON.stringify(activities.slice(0, 100)));
  } catch {
    // Keep the current page usable if storage is unavailable.
  }
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function logActivity(message, icon = "✓") {
  activities.unshift({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    message,
    icon,
    time: new Date().toISOString()
  });
  activities = activities.slice(0, 100);
  saveActivities();
  renderActivity();
}

function formatDate(date) {
  if (!date) return "—";
  const parsed = new Date(date + "T00:00:00");
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleDateString(undefined, {
        day: "2-digit", month: "short", year: "numeric"
      });
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function statusBadge(record) {
  return record.status === "synced"
    ? '<span class="status-pill synced">✓ Synced</span>'
    : '<span class="status-pill pending">◷ Pending</span>';
}

function uniquePatients() {
  return new Set(records.map(record => record.patientId)).size;
}

function renderDashboard() {
  const pending = records.filter(record => record.status !== "synced").length;
  const synced = records.length - pending;
  const percent = records.length ? Math.round(synced / records.length * 100) : 0;
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  const visitsToday = records.filter(record =>
    String(record.date || "").slice(0, 10) === today
  ).length;

  $("#total-patients").textContent = uniquePatients();
  $("#total-visits").textContent = records.length;
  $("#pending-count").textContent = pending;
  $("#synced-count").textContent = synced;
  $("#today-visits").textContent = visitsToday;
  $("#today-visits-date").textContent =
    `Visits on ${now.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  $("#daily-visits-card").setAttribute(
    "aria-label",
    `View visits by day for the last seven days. ${visitsToday} visits today.`
  );
  $("#sync-percent").textContent = percent + "%";
  $("#sync-progress").style.width = percent + "%";

  const latest = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  $("#recent-table").innerHTML = latest.map(record => `
    <tr>
      <td><div class="patient-name">${escapeHTML(record.name)}</div>
          <div class="patient-id">${escapeHTML(record.patientId)}</div></td>
      <td>${escapeHTML(formatDate(record.date))}</td>
      <td>${statusBadge(record)}</td>
    </tr>`).join("");

  $("#recent-empty").hidden = latest.length > 0;
}

function getDailyVisitCounts() {
  const today = new Date();
  const days = [];

  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");

    days.push({
      key,
      date,
      count: records.filter(record => String(record.date || "").slice(0, 10) === key).length
    });
  }

  return days;
}

function openDailyVisitsChart() {
  const days = getDailyVisitCounts();
  const chartWidth = 720;
  const chartHeight = 300;
  const left = 54;
  const right = 18;
  const top = 28;
  const bottom = 48;
  const plotWidth = chartWidth - left - right;
  const plotHeight = chartHeight - top - bottom;
  const maxCount = Math.max(1, ...days.map(day => day.count));
  const tickStep = Math.max(1, Math.ceil(maxCount / 4));
  const axisMax = Math.max(tickStep, Math.ceil(maxCount / tickStep) * tickStep);
  const slotWidth = plotWidth / days.length;
  const barWidth = Math.min(48, slotWidth * 0.56);
  const gridLines = [];
  const bars = [];
  const labels = [];

  for (let tick = 0; tick <= axisMax; tick += tickStep) {
    const y = top + plotHeight - (tick / axisMax) * plotHeight;
    gridLines.push(`
      <line x1="${left}" y1="${y}" x2="${chartWidth - right}" y2="${y}" class="chart-grid-line" />
      <text x="${left - 12}" y="${y + 4}" text-anchor="end" class="chart-axis-label">${tick}</text>
    `);
  }

  days.forEach((day, index) => {
    const x = left + slotWidth * index + (slotWidth - barWidth) / 2;
    const barHeight = (day.count / axisMax) * plotHeight;
    const y = top + plotHeight - barHeight;
    const label = day.date.toLocaleDateString(undefined, { weekday: "short" });
    const dateLabel = day.date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const barY = day.count ? y : top + plotHeight - 2;
    const visibleHeight = day.count ? barHeight : 2;

    bars.push(`
      <g>
        <title>${escapeHTML(dateLabel)}: ${day.count} visit${day.count === 1 ? "" : "s"}</title>
        <rect x="${x}" y="${barY}" width="${barWidth}" height="${visibleHeight}" rx="6" class="daily-visit-bar" />
        <text x="${x + barWidth / 2}" y="${Math.max(top - 8, y - 9)}" text-anchor="middle" class="chart-value-label">${day.count}</text>
      </g>
    `);
    labels.push(`
      <text x="${left + slotWidth * index + slotWidth / 2}" y="${chartHeight - 22}" text-anchor="middle" class="chart-axis-label">${escapeHTML(label)}</text>
      <text x="${left + slotWidth * index + slotWidth / 2}" y="${chartHeight - 7}" text-anchor="middle" class="chart-date-label">${escapeHTML(dateLabel)}</text>
    `);
  });

  $("#daily-visits-chart").innerHTML = `
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="daily-chart-svg-title daily-chart-svg-description">
      <title id="daily-chart-svg-title">Daily patient visit counts</title>
      <desc id="daily-chart-svg-description">Bar chart showing the number of visits for each of the last seven days.</desc>
      ${gridLines.join("")}
      ${bars.join("")}
      ${labels.join("")}
    </svg>
  `;

  const total = days.reduce((sum, day) => sum + day.count, 0);
  $("#daily-visits-summary").textContent =
    `${total} total visit${total === 1 ? "" : "s"} in the last seven days.`;
  $("#daily-visits-modal").hidden = false;
  $("#close-daily-visits").focus();
}

function closeDailyVisitsChart() {
  const modal = $("#daily-visits-modal");
  if (modal.hidden) return;
  modal.hidden = true;
  $("#daily-visits-card").focus();
}

function renderPatients() {
  const search = ($("#patient-search").value || "").trim().toLowerCase();
  const groupedPatients = new Map();
  const sortedRecords = [...records].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );

  sortedRecords.forEach(record => {
    const patientId = String(record.patientId || "").trim();
    const key = patientId.toLowerCase() || String(record.name || "").trim().toLowerCase();
    if (!key) return;

    if (!groupedPatients.has(key)) {
      groupedPatients.set(key, {
        key,
        patientId,
        name: record.name,
        visits: []
      });
    }

    groupedPatients.get(key).visits.push(record);
  });

  const patients = [...groupedPatients.values()].filter(patient => {
    if (!search) return true;
    return [patient.name, patient.patientId]
      .some(value => String(value || "").toLowerCase().includes(search));
  });

  $("#patients-table").innerHTML = patients.map(patient => {
    const latestVisit = patient.visits[0];
    return `
      <tr>
        <td>${escapeHTML(patient.patientId)}</td>
        <td>
          <button type="button" class="patient-open-button" data-patient-key="${escapeHTML(patient.key)}">
            <span class="patient-name">${escapeHTML(patient.name)}</span>
            <span class="patient-id">Open patient profile</span>
          </button>
        </td>
        <td>${escapeHTML(formatDate(latestVisit.date))}</td>
        <td>${patient.visits.length} visit${patient.visits.length === 1 ? "" : "s"}</td>
        <td>${statusBadge(latestVisit)}</td>
      </tr>`;
  }).join("");

  const emptyState = $("#patients-empty");
  emptyState.hidden = patients.length > 0;
  emptyState.textContent = search
    ? "No patients match your search. Try a different name or patient ID."
    : "No patient records found.";
  $("#patient-subtitle").textContent =
    `${patients.length} patient${patients.length === 1 ? "" : "s"} shown`;
}

let patientDetailsTrigger = null;

function openPatientDetails(patientKey, trigger) {
  const normalizedPatientKey = patientKey.trim().toLowerCase();
  const visits = records
    .filter(record => {
      const id = String(record.patientId || "").trim().toLowerCase();
      const key = id || String(record.name || "").trim().toLowerCase();
      return key === normalizedPatientKey;
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  if (!visits.length) {
    showToast("Patient record could not be found.");
    return;
  }

  const patient = visits[0];
  $("#patient-detail-title").textContent = patient.name || "Patient";
  $("#patient-detail-subtitle").textContent =
    `Patient ID: ${patient.patientId} · ${visits.length} visit${visits.length === 1 ? "" : "s"}`;

  $("#patient-detail-content").innerHTML = `
    <div class="patient-summary-grid">
      <article class="patient-summary-card">
        <span>Patient ID</span><strong>${escapeHTML(patient.patientId)}</strong>
      </article>
      <article class="patient-summary-card">
        <span>Age</span><strong>${escapeHTML(patient.age ?? "Not recorded")}</strong>
      </article>
      <article class="patient-summary-card">
        <span>Gender</span><strong>${escapeHTML(patient.gender || "Not recorded")}</strong>
      </article>
      <article class="patient-summary-card">
        <span>Total visits</span><strong>${visits.length}</strong>
      </article>
      <article class="patient-summary-card">
        <span>Most recent visit</span><strong>${escapeHTML(formatDate(patient.date))}</strong>
      </article>
    </div>
    <div class="patient-history-heading">
      <h3>Visit history and reports</h3>
      <p>Newest visits appear first.</p>
    </div>
    <div class="patient-detail-history">
      ${visits.map((visit, index) => {
        const reportImage = typeof visit.reportImage === "string" &&
          /^data:image\/[a-z0-9.+-]+;base64,/i.test(visit.reportImage)
          ? `<img src="${escapeHTML(visit.reportImage)}" alt="Report image from ${escapeHTML(formatDate(visit.date))}" />`
          : "";

        return `
          <article class="patient-history-card patient-detail-visit">
            <div class="patient-visit-heading">
              <span class="visit-number">Visit ${index + 1}</span>
              <time>${escapeHTML(formatDate(visit.date))}</time>
            </div>
            <h4>${escapeHTML(visit.visitType || "Visit")}</h4>
            <p><strong>Age / Gender:</strong> ${escapeHTML(visit.age ?? "Not recorded")} / ${escapeHTML(visit.gender || "Not recorded")}</p>
            <p><strong>Health issue:</strong> ${escapeHTML(visit.healthIssue || "No health issue recorded.")}</p>
            <p><strong>Prescribed medication:</strong> ${escapeHTML(visit.prescribedMedication || "None recorded.")}</p>
            <p><strong>Tests / Investigations:</strong> ${escapeHTML(visit.testsAndInvestigations || "None recorded.")}</p>
            <p><strong>Suggested health report tests:</strong> ${escapeHTML(visit.suggestedHealthReportTests || "None suggested.")}</p>
            <p><strong>Notes:</strong> ${escapeHTML(visit.notes || "No notes recorded.")}</p>
            <p><strong>Plan / Follow-up:</strong> ${escapeHTML(visit.plan || "No plan recorded.")}</p>
            ${reportImage ? `
              <div class="history-image-wrap">
                <p><strong>Report image</strong></p>
                ${reportImage}
              </div>
            ` : `<p class="no-report-image">No report image attached to this visit.</p>`}
          </article>`;
      }).join("")}
    </div>`;

  patientDetailsTrigger = trigger;
  $("#patient-detail-modal").hidden = false;
  $("#close-patient-details").focus();
}

function closePatientDetails() {
  const modal = $("#patient-detail-modal");
  if (modal.hidden) return;
  modal.hidden = true;
  if (patientDetailsTrigger && patientDetailsTrigger.isConnected) {
    patientDetailsTrigger.focus();
  }
  patientDetailsTrigger = null;
}

function renderSync() {
  const pending = records.filter(record => record.status !== "synced").length;
  $("#sync-pending").textContent = pending;
  $("#sync-done").textContent = records.length - pending;

  const sorted = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#sync-table").innerHTML = sorted.map(record => `
    <tr>
      <td>${escapeHTML(record.id)}</td>
      <td>${escapeHTML(record.name)}</td>
      <td>${escapeHTML(formatTime(record.createdAt))}</td>
      <td>${statusBadge(record)}</td>
    </tr>`).join("");

  $("#sync-empty").hidden = sorted.length > 0;
  updateConnection();
}

function renderActivity() {
  const render = activities.slice(0, 20).map(item => `
    <div class="activity-item">
      <div class="activity-icon">${escapeHTML(item.icon)}</div>
      <div class="activity-copy">
        <p>${escapeHTML(item.message)}</p>
        <small>${escapeHTML(formatTime(item.time))}</small>
      </div>
    </div>`).join("");

  $("#dashboard-activity").innerHTML = render;
  $("#full-activity").innerHTML = render;
  $("#activity-empty").hidden = activities.length > 0;
}

function renderAll() {
  renderDashboard();
  renderPatients();
  renderSync();
  renderActivity();
}

function updateConnection() {
  const browserOnline = navigator.onLine;
  const pending = records.filter(record => record.status !== "synced").length;
  const connected = browserOnline && apiAvailable;
  let title = "Working offline";
  let description = `${pending} visit(s) are saved on this device and will upload when the database is reachable.`;
  let detail = "Visits are saved on this device";
  let pill = "Offline";
  let pillClass = "offline";

  if (connected) {
    title = "Database connected";
    description = pending
      ? "Pending visits are uploading automatically."
      : "New visits are saved on this device and uploaded to the database.";
    detail = pending ? `${pending} visit(s) waiting to upload` : "Visits upload to the database";
    pill = "Connected";
    pillClass = "synced";
  } else if (browserOnline) {
    title = "Waiting for database";
    description = pending
      ? `${pending} visit(s) are safe on this device. Retrying the database connection automatically.`
      : "Your network is available, but the local database server is not responding.";
    detail = pending ? `${pending} visit(s) stored on this device` : "Database connection unavailable";
    pill = "Retrying";
    pillClass = "pending";
  }

  $("#connection-label").textContent = title;
  $("#connection-detail").textContent = detail;
  $("#sync-connection-title").textContent = title;
  $("#sync-connection-description").textContent = description;
  $("#network-pill").textContent = pill;
  $("#network-pill").className = `status-pill ${pillClass}`;
}

function navigate(pageId) {
  const page = document.getElementById(pageId);
  if (!page) return;

  $$(".page").forEach(item => item.classList.toggle("active", item.id === pageId));
  $$(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.page === pageId));

  const activeButton = $(`.nav-link[data-page="${pageId}"]`);
  $("#breadcrumb").textContent = activeButton
    ? activeButton.querySelector("span").textContent
    : "Dashboard";

  $(".sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (pageId === "patients") renderPatients();
  if (pageId === "sync") renderSync();
}

$$("[data-page]").forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();
    navigate(button.dataset.page);
  });
});

$$("[data-go]").forEach(button => {
  button.addEventListener("click", () => navigate(button.dataset.go));
});

$("#menu-toggle").addEventListener("click", () => {
  $(".sidebar").classList.toggle("open");
});

$("#sidebar-collapse-toggle").addEventListener("click", event => {
  const sidebar = $("#sidebar");
  const isCollapsed = sidebar.classList.toggle("collapsed");
  const toggle = event.currentTarget;
  toggle.setAttribute("aria-expanded", String(!isCollapsed));
  toggle.setAttribute("aria-label", isCollapsed ? "Expand navigation" : "Collapse navigation");
  toggle.title = isCollapsed ? "Expand navigation" : "Collapse navigation";
});

$("#patient-search").addEventListener("input", renderPatients);
$("#daily-visits-card").addEventListener("click", openDailyVisitsChart);
$("#daily-visits-card").addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openDailyVisitsChart();
  }
});
$("#close-daily-visits").addEventListener("click", closeDailyVisitsChart);
$("#daily-visits-modal").addEventListener("click", event => {
  if (event.target === event.currentTarget) closeDailyVisitsChart();
});
$("#patients-table").addEventListener("click", event => {
  const button = event.target.closest("[data-patient-key]");
  if (button) openPatientDetails(button.dataset.patientKey, button);
});
$("#close-patient-details").addEventListener("click", closePatientDetails);
$("#patient-detail-modal").addEventListener("click", event => {
  if (event.target === event.currentTarget) closePatientDetails();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closePatientDetails();
    closeDailyVisitsChart();
  }
});

$("#visit-form").elements.date.value = new Date().toLocaleDateString("en-CA");

$("#visit-form").addEventListener("reset", () => {
  clearReportImageSelection();
  patientIdStatus.textContent = "";
});

const patientIdInput = $("#visit-form").elements.patientId;
const patientIdStatus = $("#patient-id-status");
let patientIdAvailabilityRequest = 0;

patientIdInput.addEventListener("input", () => {
  patientIdAvailabilityRequest += 1;
  patientIdStatus.textContent = "";
});

patientIdInput.addEventListener("blur", async () => {
  if ($("#visit-form").dataset.patientMode !== "new") return;
  const patientId = patientIdInput.value.trim();
  if (patientId) await checkNewPatientIdAvailability(patientId);
});

async function checkNewPatientIdAvailability(patientId) {
  const requestId = ++patientIdAvailabilityRequest;
  const normalizedPatientId = patientId.trim().toLowerCase();
  const localDuplicate = records.some(
    record => String(record.patientId || "").trim().toLowerCase() === normalizedPatientId
  );
  if (localDuplicate) {
    if (requestId !== patientIdAvailabilityRequest) return false;
    patientIdStatus.textContent =
      "This Patient ID is already in your records. Use Existing Patient to add a visit.";
    return false;
  }

  if (!navigator.onLine) {
    if (requestId !== patientIdAvailabilityRequest) return false;
    patientIdStatus.textContent =
      "Connect to the database to check this Patient ID before registering the patient.";
    return false;
  }

  patientIdStatus.textContent = "Checking Patient ID in the database...";
  try {
    const route = appMode === "demo" ? "demo/patients" : "patients";
    const response = await fetchWithRetry(
      `${API_URL}/${route}/${encodeURIComponent(patientId.trim())}/availability`,
      {},
      1
    );
    if (requestId !== patientIdAvailabilityRequest) return false;
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const result = await response.json();
    if (requestId !== patientIdAvailabilityRequest) return false;
    if (typeof result.available !== "boolean") {
      throw new Error("The database did not return Patient ID availability.");
    }
    patientIdStatus.textContent = result.available
      ? "Patient ID is available."
      : "This Patient ID already exists in the database. Use Existing Patient to add a visit.";
    return result.available;
  } catch (error) {
    if (requestId !== patientIdAvailabilityRequest) return false;
    patientIdStatus.textContent =
      `Could not check this Patient ID: ${error.message}`;
    return false;
  }
}

$("#upload-report-image").addEventListener("click", () => reportImageInput.click());
$("#capture-report-image").addEventListener("click", () => reportCameraInput.click());
reportImageInput.addEventListener("change", handleReportImageChange);
reportCameraInput.addEventListener("change", handleReportImageChange);

if (clearReportImageButton) {
  clearReportImageButton.addEventListener("click", () => {
    clearReportImageSelection();
  });
}

$("#visit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await recordsReady;

  const form = event.currentTarget;
  const data = new FormData(form);

  const record = {
    id: "VIS-" + (currentDoctorId || "DEMO") + "-" +
      (window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
    name: String(data.get("name") || "").trim(),
    patientId:
      String(data.get("patientId") || "").trim() ||
      "P-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    age: Number(data.get("age")),
    gender: String(data.get("gender") || ""),
    date: String(data.get("date") || ""),
    visitType: String(data.get("visitType") || ""),
    isNewPatient: form.dataset.patientMode === "new",
    healthIssue: String(data.get("healthIssue") || "").trim(),
    prescribedMedication: String(data.get("prescribedMedication") || "").trim(),
    testsAndInvestigations: String(data.get("testsAndInvestigations") || "").trim(),
    suggestedHealthReportTests: String(data.get("suggestedHealthReportTests") || "").trim(),
    notes: String(data.get("notes") || "").trim(),
    plan: String(data.get("plan") || "").trim(),
    reportImage: currentReportImage,
    createdAt: new Date().toISOString()
  };

  const message = $("#form-message");
  if (record.isNewPatient) {
    const patientIdField = form.elements.patientId;
    const typedPatientId = patientIdField.value.trim();
    if (!(await checkNewPatientIdAvailability(record.patientId))) {
      message.textContent = patientIdStatus.textContent ||
        "Patient ID changed while checking. Please check it again before saving.";
      patientIdField.focus();
      return;
    }
    if (!typedPatientId) patientIdField.value = record.patientId;
  }

  message.textContent = "Saving visit securely on this device...";

  const previousIndex = records.findIndex(item => item.id === record.id);
  records = records.filter(item => item.id !== record.id);
  records.unshift({ ...record, status: "pending" });

  if (!(await persistRecords())) {
    records = records.filter(item => item.id !== record.id);
    if (previousIndex >= 0) records.splice(previousIndex, 0, record);
    renderAll();
    message.textContent = "Visit could not be saved on this device. Please try again.";
    return;
  }

  logActivity("Saved visit on this device for " + record.name, "+");
  renderAll();

  form.reset();
  clearReportImageSelection();
  form.elements.date.value = new Date().toLocaleDateString("en-CA");
  navigate("patients");

  if (!navigator.onLine) {
    message.textContent = "Saved on this device. It will upload when you're back online.";
    showToast("Visit saved offline");
    return;
  }

  message.textContent = "Saved on this device. Uploading to the database...";
  await syncPendingRecords();

  const savedRecord = records.find(item => item.id === record.id);
  if (savedRecord && savedRecord.status === "synced") {
    message.textContent = "Visit saved on this device and uploaded to the database.";
    showToast("Visit uploaded successfully");
  } else {
    message.textContent = "Saved on this device. Upload is pending and will retry automatically.";
    showToast("Visit saved; upload pending");
  }
});



$("#sync-button").addEventListener("click", async () => {
  await recordsReady;
  if (navigator.onLine && !apiAvailable) await checkBackend();
  await syncPendingRecords(true);
});

$("#clear-activity").addEventListener("click", () => {
  if (!confirm("Clear the saved activity log? Patient records will remain.")) return;
  activities = [];
  saveActivities();
  renderActivity();
  showToast("Activity log cleared");
});

window.addEventListener("online", () => {
  if (appMode === "locked") return;
  updateConnection();
  recordsReady.then(async () => {
    if (await checkBackend()) {
      await loadVisitsFromServer();
      await syncPendingRecords();
    }
  });
});
window.addEventListener("offline", () => {
  if (appMode === "locked") return;
  updateConnection();
  $("#sync-message").textContent = "Offline. New visits will be stored on this device until connection returns.";
});

$("#today").textContent = new Date().toLocaleDateString(undefined, {
  day: "numeric", month: "short", year: "numeric"
});

const isLocalPage = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_URL = isLocalPage
  ? `${window.location.protocol}//${window.location.hostname}:8000`
  : window.location.origin;

$("#auth-form").addEventListener("submit", submitAuthForm);
$("#auth-mode-toggle").addEventListener("click", () => {
  const nextMode = $("#auth-form").dataset.mode === "signup" ? "login" : "signup";
  setAuthFormMode(nextMode);
});
$("#auth-resend-code").addEventListener("click", requestSignupVerification);
$("#auth-change-email").addEventListener("click", () => {
  $("#auth-verification-code").value = "";
  setAuthFormMode("signup");
});
$("#demo-mode-button").addEventListener("click", async () => {
  localStorage.setItem(ACTIVE_MODE_KEY, "demo");
  localStorage.removeItem(SIGNED_OUT_KEY);
  if (navigator.onLine) {
    try {
      await fetchWithRetry(`${API_URL}/auth/logout`, { method: "POST" }, 1);
    } catch (error) {
      console.warn("Could not end the previous doctor session before entering demo mode:", error);
    }
  }
  await activateProfile("demo");
});
$("#logout-button").addEventListener("click", async () => {
  const previousMode = appMode;
  appMode = "locked";
  localStorage.removeItem(ACTIVE_MODE_KEY);
  localStorage.removeItem(ACTIVE_DOCTOR_KEY);
  localStorage.setItem(SIGNED_OUT_KEY, "true");
  if (navigator.onLine) {
    try {
      await fetchWithRetry(`${API_URL}/auth/logout`, { method: "POST" }, 1);
    } catch (error) {
      console.warn("Could not revoke the server session while signing out:", error);
    }
  }
  apiAvailable = false;
  showAuthScreen();
  setAuthMessage(previousMode === "demo" ? "You have left demo mode." : "You have signed out.", true);
});

async function fetchWithRetry(url, options = {}, attempts = 3, returnServerErrors = false) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(url, {
        ...options,
        credentials: "include",
        signal: controller.signal
      });

      apiAvailable = response.status < 500 && response.status !== 404;
      updateConnection();
      if (response.status === 429) return response;
      if (returnServerErrors && response.status >= 500) return response;
      if (response.status < 500 && response.status !== 429) {
        if (response.status === 401 && currentDoctorId) {
          lockExpiredSession();
        }
        return response;
      }
      lastError = new Error(`Server returned ${response.status}`);
    } catch (error) {
      apiAvailable = false;
      updateConnection();
      lastError = error.name === "AbortError"
        ? new Error("The connection timed out.")
        : error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt + 1 < attempts) {
      await new Promise(resolve => setTimeout(resolve, 800 * (2 ** attempt)));
    }
  }

  throw lastError || new Error("Could not reach the server.");
}

function apiPath(path) {
  return `${API_URL}/${appMode === "demo" ? "demo/" : ""}${path}`;
}

function setAuthMessage(message, success = false) {
  const element = $("#auth-message");
  element.textContent = message;
  element.classList.toggle("is-success", success);
}

function setAuthFormMode(mode) {
  const isSignup = mode === "signup";
  const form = $("#auth-form");
  form.dataset.mode = mode;
  form.dataset.stage = isSignup ? "signup" : "login";
  $("#auth-title").textContent = isSignup ? "Create your doctor account" : "Sign in to MediSync";
  $("#auth-email-label").textContent = isSignup ? "Gmail address" : "Email address";
  $("#auth-name-field").hidden = !isSignup;
  $("#auth-name").required = isSignup;
  $("#auth-password-field").hidden = false;
  $("#auth-password").autocomplete = isSignup ? "new-password" : "current-password";
  $("#auth-email").readOnly = false;
  $("#auth-email-hint").hidden = !isSignup;
  $("#auth-code-field").hidden = true;
  $("#auth-verification-code").required = false;
  $("#auth-verification-actions").hidden = true;
  $("#auth-mode-toggle").hidden = false;
  $("#auth-password-hint").hidden = !isSignup;
  $("#auth-submit").textContent = isSignup ? "Create account" : "Sign in";
  $("#auth-mode-toggle").textContent = isSignup
    ? "Already have an account? Sign in"
    : "Create a doctor account";
  setAuthMessage("");
}

function setAuthVerificationStage() {
  const form = $("#auth-form");
  form.dataset.mode = "signup";
  form.dataset.stage = "verify";
  $("#auth-name-field").hidden = true;
  $("#auth-password-field").hidden = true;
  $("#auth-code-field").hidden = false;
  $("#auth-verification-code").required = true;
  $("#auth-verification-code").value = "";
  $("#auth-email").readOnly = true;
  $("#auth-email-hint").hidden = false;
  $("#auth-verification-hint").textContent =
    `We sent an email to ${$("#auth-email").value.trim()} to verify that you can access this inbox. Your account will only be created after you enter the correct code. Check Spam or Promotions if you do not see it.`;
  $("#auth-verification-actions").hidden = false;
  $("#auth-mode-toggle").hidden = true;
  $("#auth-submit").textContent = "Verify email and create account";
  $("#auth-verification-code").focus();
}

function showAuthScreen(message = "") {
  appMode = "locked";
  currentDoctor = null;
  currentDoctorId = null;
  records = [];
  activities = [];
  $("#app-shell").hidden = true;
  $("#auth-screen").hidden = false;
  setAuthFormMode("login");
  setAuthMessage(message);
}

function lockExpiredSession() {
  if (appMode !== "doctor") return;
  localStorage.removeItem(ACTIVE_DOCTOR_KEY);
  localStorage.setItem(SIGNED_OUT_KEY, "true");
  showAuthScreen("Your session expired. Sign in again to access your records.");
}

async function activateProfile(mode, doctor = null, loadFromServer = true) {
  appMode = mode;
  currentDoctor = mode === "doctor" ? doctor : null;
  currentDoctorId = currentDoctor ? String(currentDoctor.id) : null;
  records = [];
  activities = [];
  localStorage.setItem(ACTIVE_MODE_KEY, mode);
  if (currentDoctor) {
    localStorage.setItem(ACTIVE_DOCTOR_KEY, JSON.stringify(currentDoctor));
    localStorage.removeItem(SIGNED_OUT_KEY);
  } else {
    localStorage.removeItem(ACTIVE_DOCTOR_KEY);
  }

  const displayName = currentDoctor ? currentDoctor.name : "Shared demo";
  $("#profile-name").textContent = displayName;
  $("#profile-email").textContent = currentDoctor ? currentDoctor.email : "Shared demo account";
  $("#profile-avatar").textContent = (displayName.trim()[0] || "D").toUpperCase();
  $("#app-shell").hidden = false;
  $("#auth-screen").hidden = true;

  recordsReady = initializeOfflineRecords().then(async () => {
    renderAll();
    if (!loadFromServer || !navigator.onLine || !(await checkBackend())) return;
    await loadVisitsFromServer();
    await syncPendingRecords();
  });
  await recordsReady;
}

async function readErrorMessage(response) {
  try {
    const body = await response.json();
    return body.detail || `The server returned ${response.status}.`;
  } catch {
    return `The server returned ${response.status}.`;
  }
}

function getAuthConnectionMessage(error) {
  if (error instanceof TypeError || /failed to fetch|networkerror/i.test(error.message || "")) {
    return `Cannot reach the MediSync API at ${API_URL}. Start it with run_app.bat and keep its server window open, then try again.`;
  }
  return error.message || "Could not sign in. Check your connection and try again.";
}

async function submitAuthForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const isSignup = form.dataset.mode === "signup";
  const isVerification = isSignup && form.dataset.stage === "verify";
  const submitButton = $("#auth-submit");
  const payload = {
    email: $("#auth-email").value.trim(),
    password: $("#auth-password").value
  };
  if (isSignup && !isVerification && !isValidGmailAddress(payload.email)) {
    setAuthMessage("Enter a valid Gmail address ending in @gmail.com.");
    return;
  }
  if (isSignup && !isVerification) {
    payload.name = $("#auth-name").value.trim();
  }
  if (isVerification) {
    payload.code = $("#auth-verification-code").value.trim();
  }

  submitButton.disabled = true;
  setAuthMessage(
    isVerification
      ? "Verifying your email..."
      : isSignup
        ? "Sending a verification code..."
        : "Signing in..."
  );
  try {
    const endpoint = isVerification
      ? "signup/verify"
      : isSignup
        ? "signup"
        : "login";
    const response = await fetchWithRetry(`${API_URL}/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, 3, true);
    if (!response.ok) throw new Error(await readErrorMessage(response));
    const result = await response.json();
    if (isSignup && !isVerification) {
      if (!result.message) {
        throw new Error("The server did not confirm that a verification code was sent.");
      }
      setAuthVerificationStage();
      setAuthMessage(result.message, true);
      return;
    }
    if (!result.doctor || !result.doctor.id) {
      throw new Error("The server did not return a valid doctor account.");
    }
    form.reset();
    await activateProfile("doctor", result.doctor);
  } catch (error) {
    setAuthMessage(getAuthConnectionMessage(error));
  } finally {
    submitButton.disabled = false;
  }
}

function isValidGmailAddress(value) {
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  const [localPart, domain] = parts;
  return Boolean(
    parts.length === 2 &&
    domain === "gmail.com" &&
    localPart &&
    localPart.length <= 64 &&
    /^[a-z0-9.+]+$/.test(localPart) &&
    !localPart.startsWith(".") &&
    !localPart.endsWith(".") &&
    !localPart.includes("..") &&
    email.length <= 254
  );
}

async function requestSignupVerification() {
  const email = $("#auth-email").value.trim();
  const name = $("#auth-name").value.trim();
  const password = $("#auth-password").value;
  const resendButton = $("#auth-resend-code");

  if (!isValidGmailAddress(email)) {
    setAuthMessage("Enter a valid Gmail address ending in @gmail.com.");
    return;
  }

  resendButton.disabled = true;
  setAuthMessage("Sending a verification code...");
  try {
    const response = await fetchWithRetry(`${API_URL}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, password })
    }, 3, true);
    if (!response.ok) throw new Error(await readErrorMessage(response));

    const result = await response.json();
    if (!result.message) {
      throw new Error("The server did not confirm that a verification code was sent.");
    }
    setAuthVerificationStage();
    setAuthMessage(result.message, true);
  } catch (error) {
    setAuthMessage(getAuthConnectionMessage(error));
  } finally {
    resendButton.disabled = false;
  }
}

async function startApplication() {
  const savedMode = localStorage.getItem(ACTIVE_MODE_KEY);
  const signedOut = localStorage.getItem(SIGNED_OUT_KEY) === "true";
  if (savedMode === "demo") {
    await activateProfile("demo");
    return;
  }
  if (signedOut) {
    showAuthScreen();
    return;
  }

  let savedDoctor = null;
  try {
    savedDoctor = JSON.parse(localStorage.getItem(ACTIVE_DOCTOR_KEY) || "null");
  } catch {
    localStorage.removeItem(ACTIVE_DOCTOR_KEY);
  }

  if (!navigator.onLine) {
    if (savedDoctor && savedMode === "doctor") {
      await activateProfile("doctor", savedDoctor, false);
    } else {
      showAuthScreen("Connect to the database to sign in, or continue with shared demo data.");
    }
    return;
  }

  try {
    const response = await fetchWithRetry(`${API_URL}/auth/me`, {}, 1);
    if (localStorage.getItem(ACTIVE_MODE_KEY) === "demo") return;
    if (!response.ok) throw new Error(await readErrorMessage(response));
    const result = await response.json();
    if (result.doctor) {
      await activateProfile("doctor", result.doctor);
      return;
    }
    localStorage.removeItem(ACTIVE_DOCTOR_KEY);
    localStorage.removeItem(ACTIVE_MODE_KEY);
    showAuthScreen();
  } catch (error) {
    if (localStorage.getItem(ACTIVE_MODE_KEY) === "demo") return;
    if (savedDoctor && savedMode === "doctor") {
      await activateProfile("doctor", savedDoctor, false);
      showToast("Offline mode: saved visits will sync after sign-in is verified.");
    } else {
      showAuthScreen(
        `Cannot reach the MediSync API at ${API_URL}. Start it with run_app.bat and keep its server window open, or continue with shared demo data.`
      );
    }
  }
}

function updateUploadProgress(completed, total, label, detail, state = "uploading") {
  const panel = $("#sync-progress-panel");
  const track = $("#sync-progress-track");
  const fill = $("#sync-progress-fill");
  const percentLabel = $("#sync-progress-percent");
  const percent = total ? Math.round((completed / total) * 100) : 100;

  panel.hidden = false;
  panel.classList.toggle("is-complete", state === "complete");
  panel.classList.toggle("is-error", state === "error");
  panel.classList.toggle("is-waiting", state === "waiting");
  $("#sync-progress-label").textContent = label;
  percentLabel.textContent = `${percent}%`;
  $("#sync-progress-detail").textContent = detail;
  if (state === "waiting") {
    track.removeAttribute("aria-valuenow");
    track.setAttribute("aria-valuetext", "Waiting for connection");
  } else {
    track.setAttribute("aria-valuenow", String(percent));
    track.removeAttribute("aria-valuetext");
  }
  fill.style.width = `${percent}%`;
}

async function syncPendingRecords(manual = false) {
  if (appMode === "locked") return false;
  if (syncInProgress) return false;

  const pending = records.filter(record => record.status !== "synced");
  if (!pending.length) {
    if (manual) {
      $("#sync-message").textContent = "All visits are already uploaded.";
      updateUploadProgress(0, 0, "Upload complete", "There are no pending visits.", "complete");
    }
    return true;
  }

  if (!navigator.onLine || !apiAvailable) {
    if (manual) {
      updateUploadProgress(
        0,
        pending.length,
        "Waiting for connection",
        "Visits remain saved on this device. The upload will resume when the database is reachable.",
        "waiting"
      );
    }
    $("#sync-message").textContent =
      `${pending.length} visit(s) saved on this device. They will upload when the database connection is available.`;
    updateConnection();
    return false;
  }

  syncInProgress = true;
  const syncButton = $("#sync-button");
  syncButton.disabled = true;
  syncButton.textContent = "Uploading visits...";
  updateUploadProgress(
    0,
    pending.length,
    "Uploading visits",
    `Preparing ${pending.length} pending visit(s) for upload.`
  );
  let uploaded = 0;
  let failure = null;

  try {
    for (const queuedRecord of pending) {
      updateUploadProgress(
        uploaded,
        pending.length,
        `Uploading visit ${uploaded + 1} of ${pending.length}`,
        queuedRecord.name
          ? `Sending the saved visit for ${queuedRecord.name}.`
          : "Sending the saved visit to the database."
      );

      const response = await fetchWithRetry(apiPath("visits"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queuedRecord)
      });

      if (!response.ok) {
        let detail = await response.text();
        if (response.status === 409 && queuedRecord.isNewPatient) {
          try {
            detail = JSON.parse(detail).detail || detail;
          } catch {
            // Keep the server response text when it is not JSON.
          }
        }
        throw new Error(
          response.status === 409 && queuedRecord.isNewPatient
            ? detail || "That Patient ID has already been registered. Use Existing Patient for follow-up visits."
            : `Upload failed (${response.status})${detail ? `: ${detail.slice(0, 250)}` : ""}`
        );
      }

      records = records.map(record =>
        record.id === queuedRecord.id ? { ...record, status: "synced" } : record
      );
      if (!(await persistRecords())) {
        throw new Error("Uploaded visit, but could not update its local sync status.");
      }
      uploaded += 1;
      updateUploadProgress(
        uploaded,
        pending.length,
        uploaded === pending.length ? "Upload complete" : "Upload in progress",
        `${uploaded} of ${pending.length} visit(s) uploaded successfully.`,
        uploaded === pending.length ? "complete" : "uploading"
      );
    }
  } catch (error) {
    failure = error;
    console.warn("Visit upload is pending and will be retried:", error);
    updateUploadProgress(
      uploaded,
      pending.length,
      "Upload paused",
      `${uploaded} of ${pending.length} uploaded. The remaining visit(s) are still saved on this device and will retry.`,
      "error"
    );
  } finally {
    syncInProgress = false;
    syncButton.disabled = false;
    syncButton.textContent = "⇄ Upload pending visits";
    renderAll();
  }

  const remaining = records.filter(record => record.status !== "synced").length;
  if (failure) {
    $("#sync-message").textContent =
      `${uploaded} uploaded; ${remaining} still saved on this device. ${failure.message}`;
    if (manual) showToast("Some visits are still waiting to upload");
    return false;
  }

  $("#sync-message").textContent =
    uploaded ? `${uploaded} visit(s) uploaded to the database.` : "All visits are already uploaded.";
  if (uploaded) {
    logActivity(`Uploaded ${uploaded} saved visit(s) to the database`, "⇄");
    if (manual) showToast("Pending visits uploaded");
  }
  return true;
}


async function loadVisitsFromServer() {
  if (!navigator.onLine || appMode === "locked") return;
  try {
    const response = await fetchWithRetry(apiPath("visits"));

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const serverVisits = await response.json();
    const merged = new Map(serverVisits.map(visit => [
      visit.id,
      { ...visit, status: "synced" }
    ]));

    records.forEach(localRecord => {
      const serverRecord = merged.get(localRecord.id);
      if (!serverRecord || localRecord.status !== "synced") {
        merged.set(localRecord.id, { ...localRecord, status: "pending" });
      }
    });

    records = [...merged.values()].sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
    await persistRecords();
    renderAll();

    console.log("Visits loaded from SQLite:", records.length);
  } catch (error) {
    console.warn("Could not refresh visits from the database:", error);
  }
}


async function checkBackend() {
  if (!navigator.onLine || backendCheckInProgress) return false;

  backendCheckInProgress = true;
  try {
    const response = await fetchWithRetry(`${API_URL}/health`, {}, 1);
    if (!response.ok) throw new Error(`Database health check returned ${response.status}`);

    apiAvailable = true;
    updateConnection();
    console.log("FastAPI connected.");
    return true;
  } catch (error) {
    apiAvailable = false;
    updateConnection();
    console.warn("Database unavailable; saved visits will retry:", error);
    return false;
  } finally {
    backendCheckInProgress = false;
  }
}

startApplication();

window.setInterval(() => {
  if (appMode === "locked") return;
  const hasPendingVisits = records.some(record => record.status !== "synced");
  if (navigator.onLine && (hasPendingVisits || !apiAvailable)) {
    checkBackend().then(available => {
      if (available) syncPendingRecords();
    });
  }
}, 10000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && navigator.onLine && appMode !== "locked") {
    checkBackend().then(available => {
      if (available) syncPendingRecords();
    });
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(error => {
      console.warn("Offline page caching could not be enabled:", error);
    });
  });
}



const voiceButton = document.querySelector("#voice-button");
const voiceLanguage = document.querySelector("#voice-language");
const voiceStatus = document.querySelector("#voice-status");
const notesBox = document.querySelector(
  '#visit-form textarea[name="notes"]'
);

const SpeechRecognition =
  window.SpeechRecognition ||
  window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  voiceButton.disabled = true;
  voiceStatus.textContent =
    "Speech recognition is not supported in this browser.";
} else {
  const recognition = new SpeechRecognition();
  let isListening = false;
  let recognitionError = false;
  let recognizedSpeech = false;
  let finalTranscript = "";

  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  voiceButton.addEventListener("click", () => {
    if (isListening) {
      recognition.stop();
      voiceStatus.textContent = "Finishing speech recognition...";
      return;
    }

    recognition.lang = voiceLanguage.value;
    recognitionError = false;
    recognizedSpeech = false;
    finalTranscript = "";

    try {
      recognition.start();
      isListening = true;
      voiceButton.textContent = "■ Stop speaking";
      voiceLanguage.disabled = true;
      voiceStatus.textContent =
        `Listening in ${voiceLanguage.selectedOptions[0].text}. Speak clearly in short phrases.`;
    } catch (error) {
      voiceStatus.textContent =
        error.name === "InvalidStateError"
          ? "Speech recognition is already starting. Please wait a moment."
          : `Could not start speech recognition: ${error.message}`;
    }
  });

  recognition.onresult = (event) => {
    let interimTranscript = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const spokenText = result[0].transcript.trim();

      if (result.isFinal) {
        finalTranscript += `${spokenText} `;
        recognizedSpeech = true;
      } else {
        interimTranscript += spokenText;
      }
    }

    if (interimTranscript) {
      voiceStatus.textContent = `Hearing: ${interimTranscript}`;
    }

    if (finalTranscript.trim()) {
      const existingNotes = notesBox.value.trim();
      notesBox.value = existingNotes
        ? `${existingNotes} ${finalTranscript.trim()}`
        : finalTranscript.trim();
      notesBox.dispatchEvent(new Event("input", { bubbles: true }));
      voiceStatus.textContent =
        "Speech added to visit notes. Review the text and correct any errors.";
      finalTranscript = "";
    }
  };

  recognition.onerror = (event) => {
    recognitionError = true;
    const messages = {
      "no-speech": "No speech was detected. Try again and speak closer to the microphone.",
      "audio-capture": "No microphone was found. Check that a microphone is connected.",
      "not-allowed": "Microphone access was blocked. Allow microphone access in your browser settings.",
      "service-not-allowed": "Speech recognition is unavailable. Check your browser permissions and connection.",
      network: "Speech recognition needs an internet connection. Check your connection and try again.",
      "language-not-supported": "This speech language is not supported by your browser.",
      aborted: "Speech recognition was stopped."
    };
    voiceStatus.textContent =
      messages[event.error] || `Could not recognize speech: ${event.error}. Please try again.`;
  };

  recognition.onend = () => {
    isListening = false;
    voiceButton.textContent = "🎤 Start speaking";
    voiceLanguage.disabled = false;

    if (!recognitionError && !recognizedSpeech) {
      voiceStatus.textContent = "No speech was recognized. Try again and speak clearly in short phrases.";
    }
  };
}



const newPatientOption = document.querySelector("#new-patient-option");
const existingPatientOption = document.querySelector("#existing-patient-option");

const visitFormPanel = document.querySelector("#visit-form-panel");
const existingPatientPanel = document.querySelector("#existing-patient-panel");
const existingPatientSearchForm = document.querySelector("#existing-patient-search-form");
const existingPatientIdInput = document.querySelector("#existing-patient-id");
const existingPatientMessage = document.querySelector("#existing-patient-message");
const existingPatientDetails = document.querySelector("#existing-patient-details");
const existingPatientName = document.querySelector("#existing-patient-name");
const existingPatientSummary = document.querySelector("#existing-patient-summary");
const existingPatientHistory = document.querySelector("#existing-patient-history");
const startExistingVisitButton = document.querySelector("#start-existing-visit");

let selectedExistingPatient = null;

// Open the new-patient registration form.
newPatientOption.addEventListener("click", () => {
  existingPatientPanel.hidden = true;
  visitFormPanel.hidden = false;

  const form = $("#visit-form");
  form.dataset.patientMode = "new";
  form.reset();
  clearReportImageSelection();

  form.elements.patientId.value = "";
  form.elements.patientId.readOnly = false;
  form.elements.name.readOnly = false;
  form.elements.date.value = new Date().toLocaleDateString("en-CA");

  selectedExistingPatient = null;
  patientIdStatus.textContent = "";
  $("#form-message").textContent = "";
});

// Open the existing-patient search panel.
existingPatientOption.addEventListener("click", () => {
  $("#visit-form").dataset.patientMode = "existing";
  visitFormPanel.hidden = true;
  existingPatientPanel.hidden = false;

  existingPatientSearchForm.reset();
  existingPatientMessage.textContent = "";
  existingPatientDetails.hidden = true;
  selectedExistingPatient = null;
});

// Search the server for the patient's previous visits.
existingPatientSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const patientId = existingPatientIdInput.value.trim();

  if (!patientId) return;

  existingPatientMessage.textContent = "Searching patient history...";
  existingPatientDetails.hidden = true;
  selectedExistingPatient = null;

  try {
    const response = await fetchWithRetry(
      `${API_URL}/${appMode === "demo" ? "demo/" : ""}patients/${encodeURIComponent(patientId)}/visits`,
      {},
      1
    );

    if (!response.ok) {
      throw new Error("Server returned status " + response.status);
    }

    const visits = await response.json();

    if (!visits.length) {
      existingPatientMessage.textContent =
        "No visits found for this Patient ID. Check the ID and try again.";
      return;
    }

    // Keep only records matching the requested ID.
    const matchingVisits = visits.filter(
      visit => String(visit.patientId).trim() === patientId
    );

    if (!matchingVisits.length) {
      existingPatientMessage.textContent =
        "No matching patient was found. Check the Patient ID.";
      return;
    }

    selectedExistingPatient = {
      patientId,
      name: matchingVisits[0].name,
      age: matchingVisits[0].age,
      gender: matchingVisits[0].gender,
      visits: matchingVisits
    };

    existingPatientName.textContent = matchingVisits[0].name;
    existingPatientSummary.textContent =
      `Patient ID: ${patientId} · Age: ${matchingVisits[0].age ?? "Not recorded"} · Gender: ${matchingVisits[0].gender || "Not recorded"} · ${matchingVisits.length} previous visit(s)`;

    existingPatientHistory.innerHTML = matchingVisits.map(visit => `
      <article class="patient-history-card">
        <h4>${escapeHTML(formatDate(visit.date))} — ${escapeHTML(visit.visitType)}</h4>
        <p><strong>Age / Gender:</strong> ${escapeHTML(visit.age ?? "Not recorded")} / ${escapeHTML(visit.gender || "Not recorded")}</p>
        <p><strong>Health issue:</strong> ${escapeHTML(visit.healthIssue || "No health issue recorded.")}</p>
        <p><strong>Prescribed medication:</strong> ${escapeHTML(visit.prescribedMedication || "None recorded.")}</p>
        <p><strong>Tests / Investigations:</strong> ${escapeHTML(visit.testsAndInvestigations || "None recorded.")}</p>
        <p><strong>Suggested health report tests:</strong> ${escapeHTML(visit.suggestedHealthReportTests || "None suggested.")}</p>
        <p><strong>Symptoms / Notes:</strong> ${escapeHTML(visit.notes)}</p>
        <p><strong>Plan:</strong> ${escapeHTML(visit.plan || "No plan recorded")}</p>
        ${visit.reportImage ? `
          <div class="history-image-wrap">
            <img src="${visit.reportImage}" alt="Patient report image for ${escapeHTML(visit.visitType)}" />
          </div>
        ` : ""}
      </article>
    `).join("");

    existingPatientMessage.textContent = "Patient history loaded successfully.";
    existingPatientDetails.hidden = false;

  } catch (error) {
    console.error("Patient history search failed:", error);
    existingPatientMessage.textContent =
      "Could not load history. Check that FastAPI is running and try again.";
  }
});

// Start a new visit for the selected existing patient.
startExistingVisitButton.addEventListener("click", () => {
  if (!selectedExistingPatient) return;

  const form = $("#visit-form");
  form.dataset.patientMode = "existing";

  form.reset();

  form.elements.patientId.value = selectedExistingPatient.patientId;
  form.elements.name.value = selectedExistingPatient.name;
  form.elements.age.value = selectedExistingPatient.age ?? "";
  form.elements.gender.value = selectedExistingPatient.gender || "";

  // Prevent accidentally changing the existing patient's identity.
  form.elements.patientId.readOnly = true;
  form.elements.name.readOnly = true;

  form.elements.date.value = new Date().toLocaleDateString("en-CA");

  // The new visit starts with blank notes and plan.
  form.elements.healthIssue.value = "";
  form.elements.prescribedMedication.value = "";
  form.elements.testsAndInvestigations.value = "";
  form.elements.suggestedHealthReportTests.value = "";
  form.elements.notes.value = "";
  form.elements.plan.value = "";
  patientIdStatus.textContent = "";
  clearReportImageSelection();

  $("#form-message").textContent = "";
  existingPatientPanel.hidden = true;
  visitFormPanel.hidden = false;

  navigate("new-visit");
  form.elements.notes.focus();
});
