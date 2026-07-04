// Shared helpers used by both the public display (app.js) and admin panel (admin.js).

const LS_KEYS = {
  token: "caliUnite.adminToken",
  theatre: "caliUnite.theatre",
  lastState: "caliUnite.lastState",
};

const DEFAULT_THEATRE = "main";

// -- Demo mode ----------------------------------------------------------
// When CONFIG.API_URL is empty the app runs entirely in the browser on
// sample data, so the UI can be previewed and themed before the real
// sheet/backend exists. Admin actions work but only affect this tab.

const DEMO_MODE = !window.CONFIG.API_URL;

const DEMO_STATE = {
  schedule: [
    { theatre: "Main Stage", day: "Monday", session: "Morning session", time: "9:00 AM", section: "", title: "Welcome & housekeeping" },
    { theatre: "Main Stage", day: "Monday", session: "", time: "", section: "Junior Rods", competitor_number: "12", title: "Ava Thompson" },
    { theatre: "Main Stage", day: "Monday", session: "", time: "", section: "Junior Rods", competitor_number: "14", title: "Mia Chen" },
    { theatre: "Main Stage", day: "Monday", session: "", time: "", section: "Junior Rods", competitor_number: "17", title: "Ruby Patel", withdrawn: "yes" },
    { theatre: "Main Stage", day: "Monday", session: "", time: "", section: "Senior March", competitor_number: "21", title: "Lucas Reid" },
    { theatre: "Main Stage", day: "Monday", session: "", time: "", section: "Senior March", competitor_number: "23", title: "Emily Zhang" },
    { theatre: "Main Stage", day: "Monday", session: "Afternoon session", time: "1:30 PM", section: "Team Displays", title: "Harbour City Seniors" },
    { theatre: "Main Stage", day: "Monday", session: "", time: "", section: "Team Displays", title: "Northside Demo Team" },
    { theatre: "Main Stage", day: "Monday", session: "", time: "", section: "Awards", title: "Morning awards presentation" },
    { theatre: "Main Stage", day: "Tuesday", session: "Finals", time: "9:30 AM", section: "Champions Rods", competitor_number: "31", title: "Grace Holland" },
    { theatre: "Main Stage", day: "Tuesday", session: "", time: "", section: "Champions Rods", competitor_number: "32", title: "Poppy Irwin" },
    { theatre: "Main Stage", day: "Tuesday", session: "Closing", time: "2:00 PM", section: "", title: "Awards & thank-yous" },
    { theatre: "Studio", day: "Monday", session: "Studio morning", time: "9:30 AM", section: "Subjunior Freearm", competitor_number: "41", title: "Isla Brown" },
    { theatre: "Studio", day: "Monday", session: "", time: "", section: "Subjunior Freearm", competitor_number: "42", title: "Zoe Nguyen" },
    { theatre: "Studio", day: "Tuesday", session: "Open floor", time: "10:00 AM", section: "", title: "Free practice" },
  ],
  stateMap: {
    "currentIndex::Main Stage": 2,
    "currentIndex::Studio": 0,
    announcement: "Demo mode - configure API_URL in config.js to go live.",
    lastUpdated: new Date().toISOString(),
  },
};

function demoBuildState() {
  const schedule = DEMO_STATE.schedule.map((it) => ({ ...it }));
  const ids = [];
  schedule.forEach((it) => {
    const id = it.theatre || DEFAULT_THEATRE;
    if (!ids.includes(id)) ids.push(id);
  });
  // normalizeState applies the same fill-down as live data.
  return normalizeState({
    schedule,
    theatres: ids.map((id) => ({
      id,
      currentIndex: clampIndex(
        Number(DEMO_STATE.stateMap["currentIndex::" + id] ?? -1),
        schedule.filter((it) => (it.theatre || DEFAULT_THEATRE) === id).length
      ),
    })),
    announcement: DEMO_STATE.stateMap.announcement || "",
    lastUpdated: DEMO_STATE.stateMap.lastUpdated || "",
  });
}

function demoApplyAction(body) {
  if (body.action === "verify") return;
  if (body.action === "setAnnouncement") {
    DEMO_STATE.stateMap.announcement = String(body.text || "");
  } else {
    const theatre = body.theatre || DEFAULT_THEATRE;
    const items = DEMO_STATE.schedule.filter(
      (it) => (it.theatre || DEFAULT_THEATRE) === theatre
    );
    if (body.action === "setWithdrawn") {
      const item = items[Number(body.index)];
      if (item) item.withdrawn = body.withdrawn ? "yes" : "";
    } else {
      const key = "currentIndex::" + theatre;
      let idx = Number(DEMO_STATE.stateMap[key] ?? -1);
      // Mirrors the backend: advancing steps over withdrawn competitors,
      // normalising first if the pointer sits on one.
      if (body.action === "advance") {
        while (idx >= 0 && idx < items.length && isWithdrawn(items[idx])) idx += 1;
        idx += 1;
        while (idx < items.length && isWithdrawn(items[idx])) idx += 1;
      } else if (body.action === "previous") {
        idx -= 1;
        while (idx > -1 && isWithdrawn(items[idx])) idx -= 1;
      } else if (body.action === "setIndex") {
        idx = Number(body.index);
      }
      DEMO_STATE.stateMap[key] = clampIndex(idx, items.length);
    }
  }
  DEMO_STATE.stateMap.lastUpdated = new Date().toISOString();
}

// -- API ----------------------------------------------------------------

async function apiGet() {
  if (DEMO_MODE) return demoBuildState();
  const url = window.CONFIG.API_URL + "?t=" + Date.now();
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return cacheState(normalizeState(data));
}

// -- Client-side cache (stale-while-revalidate) -------------------------
// The Apps Script round-trip takes a couple of seconds, so the last good
// state is kept in localStorage and rendered instantly on page load while
// a fresh copy is fetched in the background.

function cacheState(state) {
  try {
    localStorage.setItem(LS_KEYS.lastState, JSON.stringify(state));
  } catch (e) {
    /* storage full/blocked - caching is best-effort */
  }
  return state;
}

function loadCachedState() {
  if (DEMO_MODE) return null;
  try {
    const raw = localStorage.getItem(LS_KEYS.lastState);
    return raw ? normalizeState(JSON.parse(raw)) : null;
  } catch (e) {
    return null;
  }
}

// -- Value normalisation ------------------------------------------------
// Google Sheets stores time-only cells as dates on its 1899-12-30 epoch;
// depending on the backend version they can arrive as strings like
// "Sat Dec 30 1899 09:00:00 GMT+1000 (…)". The wall-clock time is pulled
// out with a regex - never via Date parsing - so a viewer in a different
// timezone can't shift it.

function normalizeState(state) {
  let prev = null;
  (state.schedule || []).forEach((item) => {
    if (item.time != null) item.time = normalizeTime(item.time);
    // Fill-down: organisers typically fill theatre/day/section only on the
    // first row of a block (like merged cells), so blank cells inherit
    // from the row above. Day only carries within the same theatre, and
    // section only within the same theatre + day.
    if (prev) {
      if ("theatre" in item && String(item.theatre ?? "").trim() === "") {
        item.theatre = prev.theatre;
      }
      const sameTheatre =
        String(item.theatre ?? "").trim() === String(prev.theatre ?? "").trim();
      if (sameTheatre && "day" in item && String(item.day ?? "").trim() === "") {
        item.day = prev.day;
      }
      const sameDay =
        String(item.day ?? "").trim() === String(prev.day ?? "").trim();
      if (
        sameTheatre &&
        sameDay &&
        "session" in item &&
        String(item.session ?? "").trim() === ""
      ) {
        item.session = prev.session;
      }
      const sameSession =
        String(item.session ?? "").trim() === String(prev.session ?? "").trim();
      if (
        sameTheatre &&
        sameDay &&
        sameSession &&
        "section" in item &&
        String(item.section ?? "").trim() === ""
      ) {
        item.section = prev.section;
      }
    }
    prev = item;
  });
  // Drop phantom theatres: an older backend derives the theatre list
  // before fill-down, so blank theatre cells can produce a tab that owns
  // no items once the frontend has filled them in.
  if ((state.schedule || []).length && Array.isArray(state.theatres)) {
    state.theatres = state.theatres.filter((t) =>
      state.schedule.some((it) => (it.theatre || DEFAULT_THEATRE) === t.id)
    );
  }
  return state;
}

// -- Competitor numbers ---------------------------------------------------

function competitorNumber(item) {
  return String(item.competitor_number ?? "").trim();
}

// Item title as HTML, with the competitor-number badge when present.
function titleWithNumber(item) {
  const n = competitorNumber(item);
  return (
    (n ? `<span class="comp-num">${escapeHtml(n)}</span> ` : "") +
    escapeHtml(item.title)
  );
}

function normalizeTime(value) {
  const str = String(value).trim();
  // A pre-1930 year followed by an HH:MM:SS marks a time-only cell.
  const m = str.match(/\b(18\d\d|19[0-2]\d)\b.*?\b(\d{1,2}):(\d{2}):\d{2}\b/);
  if (!m) return str;
  let hours = parseInt(m[2], 10);
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return hours + ":" + m[3] + " " + suffix;
}

// Where the pointer lands after a Next/Back step, skipping withdrawn
// competitors (mirrors the backend's advance/previous semantics).
function stepIndex(items, from, action) {
  let idx = from;
  if (action === "advance") {
    while (idx >= 0 && idx < items.length && isWithdrawn(items[idx])) idx += 1;
    idx += 1;
    while (idx < items.length && isWithdrawn(items[idx])) idx += 1;
  } else {
    idx -= 1;
    while (idx > -1 && isWithdrawn(items[idx])) idx -= 1;
  }
  return clampIndex(idx, items.length);
}

// Retries transient failures (network drop, HTTP 5xx/4xx) with backoff.
// Application errors from the backend (e.g. "unauthorized") are not
// retried. Callers must only pass idempotent actions.
async function apiPostWithRetry(payload, attempts = 3) {
  let delay = 600;
  for (let attempt = 1; ; attempt++) {
    try {
      return await apiPost(payload);
    } catch (err) {
      const transient =
        err instanceof TypeError || /^HTTP \d/.test(String(err && err.message));
      if (!transient || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2.5;
    }
  }
}

// POST body is sent as a plain string (no Content-Type header) so the
// browser makes a "simple request" - Apps Script cannot answer CORS
// preflight (OPTIONS) requests, so custom headers must be avoided.
async function apiPost(payload) {
  if (DEMO_MODE) {
    demoApplyAction(payload);
    return demoBuildState();
  }
  const res = await fetch(window.CONFIG.API_URL, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// -- State helpers ------------------------------------------------------

function clampIndex(idx, count) {
  if (!Number.isFinite(idx)) return -1;
  return Math.max(-1, Math.min(idx, count));
}

function itemsForTheatre(state, theatreId) {
  return state.schedule.filter(
    (it) => (it.theatre || DEFAULT_THEATRE) === theatreId
  );
}

function pickTheatre(state) {
  const saved = localStorage.getItem(LS_KEYS.theatre);
  if (saved && state.theatres.some((t) => t.id === saved)) return saved;
  return state.theatres.length ? state.theatres[0].id : DEFAULT_THEATRE;
}

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// -- Sessions & sections --------------------------------------------------
// Hierarchy: day → session (owns the rough start time) → section →
// items. A sheet with only a `section` column still works: each section
// is promoted to its own session (carrying its time) with no
// sub-sections. No session or section columns at all → flat rendering.

function hasGrouping(items) {
  return items.some(
    (it) =>
      String(it.session ?? "").trim() !== "" ||
      String(it.section ?? "").trim() !== ""
  );
}

// Nested running order:
//   [{day, sessions: [{name, time, firstIndex, count, sections:
//     [{name, entries: [{item, index}]}]}]}]
// where index is the theatre-wide pointer index.
function groupSchedule(items) {
  const days = [];
  let curDay = null;
  let curSes = null;
  let curSec = null;
  items.forEach((item, index) => {
    const dayName = String(item.day ?? "").trim();
    let sesName = String(item.session ?? "").trim();
    let secName = String(item.section ?? "").trim();
    if (!sesName && secName) {
      // Section-only sheet: promote the section to a session.
      sesName = secName;
      secName = "";
    }
    if (!curDay || curDay.day !== dayName) {
      curDay = { day: dayName, sessions: [] };
      days.push(curDay);
      curSes = null;
    }
    if (!curSes || curSes.name !== sesName) {
      curSes = { name: sesName, time: "", firstIndex: index, count: 0, sections: [] };
      curDay.sessions.push(curSes);
      curSec = null;
    }
    if (!curSes.time && String(item.time ?? "").trim()) {
      curSes.time = String(item.time).trim();
    }
    if (!curSec || curSec.name !== secName) {
      curSec = { name: secName, entries: [] };
      curSes.sections.push(curSec);
    }
    curSec.entries.push({ item, index });
    curSes.count += 1;
  });
  return days;
}

// Session/section context for the item at `idx`: {session, time, section}.
// Null when idx is out of range.
function contextInfoFor(items, idx) {
  if (idx < 0 || idx >= items.length) return null;
  for (const day of groupSchedule(items)) {
    for (const ses of day.sessions) {
      for (const sec of ses.sections) {
        for (const e of sec.entries) {
          if (e.index === idx) {
            return { session: ses.name, time: ses.time, section: sec.name };
          }
        }
      }
    }
  }
  return null;
}

// "Morning session · 9:00 AM — Junior Rods"
function contextLabel(info) {
  if (!info) return "";
  let label = info.session || "";
  if (info.time) label += (label ? " · " : "") + info.time;
  if (info.section && info.section !== info.session) {
    label += (label ? " — " : "") + info.section;
  }
  return label;
}

// -- Withdrawals ----------------------------------------------------------
// Flagged via the `withdrawn` sheet column (checkbox or text). Withdrawn
// competitors stay in the schedule list but are skipped by the hero cards
// and by the admin Next/Back buttons.

function isWithdrawn(item) {
  return /^(true|yes|y|1|x|wd|withdrawn)$/i.test(
    String(item.withdrawn ?? "").trim()
  );
}

// First non-withdrawn item at or after `from`; -1 if there is none.
function nextPresentIndex(items, from) {
  for (let i = Math.max(from, 0); i < items.length; i++) {
    if (!isWithdrawn(items[i])) return i;
  }
  return -1;
}

// The pointer may legitimately sit on a withdrawn competitor (most
// commonly: the person on stage is withdrawn mid-event). Displays never
// show a withdrawn item as current - they use this *effective* position,
// which rolls forward to the next non-withdrawn item. Reinstating the
// competitor automatically makes them current again.
function effectiveIndex(items, ci) {
  if (ci < 0) return -1;
  if (ci >= items.length) return items.length;
  const idx = nextPresentIndex(items, ci);
  return idx === -1 ? items.length : idx;
}

// Groups a theatre's items by their `day` value, preserving order of
// first appearance. Items without a day all land in one unnamed group.
function groupByDay(items) {
  const groups = [];
  const byKey = new Map();
  items.forEach((item, index) => {
    const day = String(item.day ?? "").trim();
    if (!byKey.has(day)) {
      const group = { day, entries: [] };
      byKey.set(day, group);
      groups.push(group);
    }
    byKey.get(day).entries.push({ item, index });
  });
  return groups;
}
