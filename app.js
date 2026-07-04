// Public schedule display.

let state = null;
let currentTheatre = null;
let lastSuccessAt = null;
let lastScrollKey = "";
let fetching = false;
// "Show more" toggles for folded sections; keys are
// "sec:<theatre>:<day|session|section>". Per-pageload only.
const expandedGroups = new Set();
// null = follow the live day automatically; a key = user's explicit pick.
let selectedDayKey = null;

document.getElementById("event-name").textContent = window.CONFIG.EVENT_NAME;
document.title = window.CONFIG.EVENT_NAME + " - Schedule";

// While waiting for the first response with nothing cached, a blurred
// placeholder schedule sits behind the spinner so the page already looks
// like a schedule rather than a blank screen.
function skeletonItems() {
  const items = [];
  for (let d = 1; d <= 2; d++) {
    for (let i = 0; i < 4; i++) {
      items.push({
        day: "Day " + d,
        time: "0:00 AM",
        title: "Loading schedule item",
        subtitle: i % 2 ? "Loading details" : "",
      });
    }
  }
  return items;
}

function showLoading() {
  const items = skeletonItems();
  renderHero(items, 1);
  renderSchedule(items, 1);
  document.querySelector(".container").classList.add("blurred");
  document.getElementById("loading-overlay").hidden = false;
}

function hideLoading() {
  document.querySelector(".container").classList.remove("blurred");
  document.getElementById("loading-overlay").hidden = true;
}

async function refresh() {
  // Single-flight: with a ~2s round-trip and a 2s poll interval, polls
  // overlap and out-of-order responses briefly rewind the UI (sections
  // flashing open then shut). Never start a poll while one is in flight.
  if (fetching) return;
  fetching = true;
  renderStatus();
  try {
    state = await apiGet();
    lastSuccessAt = Date.now();
    if (!currentTheatre) currentTheatre = pickTheatre(state);
    if (!state.theatres.some((t) => t.id === currentTheatre)) {
      currentTheatre = pickTheatre(state);
    }
    render();
  } catch (err) {
    console.error("Failed to fetch schedule:", err);
  } finally {
    fetching = false;
  }
  renderStatus();
}

function selectTheatre(id) {
  currentTheatre = id;
  localStorage.setItem(LS_KEYS.theatre, id);
  render();
}

function render() {
  if (!state) return;
  hideLoading();
  renderAnnouncement();
  renderTabs();
  const items = itemsForTheatre(state, currentTheatre);
  const theatre = state.theatres.find((t) => t.id === currentTheatre);
  const rawCi = theatre ? theatre.currentIndex : -1;
  // All rendering works from the effective position, so a withdrawn
  // competitor is never presented as current anywhere.
  const eff = effectiveIndex(items, rawCi);
  const activeKey = (theatre && theatre.activeSession) || "";
  const active = hasGrouping(items)
    ? resolveActiveSession(items, activeKey, eff)
    : null;
  // Pinned to "not started" while the raw pointer sits before the active
  // session, so a freshly started session opens on "Starting soon".
  const ci = sessionDisplayIndex(items, rawCi, active);
  // Nothing is "current" while the pointer sits outside the active
  // session (session finished, or just started and not yet begun) - the
  // list must not highlight an item the hero isn't showing.
  const highlightIdx =
    active && (ci > active.lastIndex || ci < active.firstIndex) ? -1 : ci;
  let dayKey = "";
  if (hasGrouping(items)) {
    const days = groupSchedule(items);
    const live = liveDayKey(days, active);
    dayKey = resolveDayKey(days, selectedDayKey, live);
    renderDayTabs(days, dayKey, live);
  } else {
    renderDayTabs([], "", "");
  }
  renderHero(items, ci, active);
  renderSchedule(items, ci, highlightIdx, dayKey);
  autoScroll(highlightIdx);
}

function renderAnnouncement() {
  const el = document.getElementById("announcement");
  const text = (state.announcement || "").trim();
  el.textContent = text;
  el.classList.toggle("visible", !!text);
}

function renderTabs() {
  const nav = document.getElementById("theatre-tabs");
  const multi = state.theatres.length > 1;
  nav.classList.toggle("visible", multi);
  if (!multi) {
    nav.innerHTML = "";
    return;
  }
  nav.innerHTML = state.theatres
    .map(
      (t) =>
        `<button data-theatre="${escapeHtml(t.id)}" class="${
          t.id === currentTheatre ? "active" : ""
        }">${escapeHtml(t.id)}</button>`
    )
    .join("");
  nav.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => selectTheatre(btn.dataset.theatre));
  });
}

function itemMeta(item) {
  const parts = [];
  if (item.day) parts.push(item.day);
  if (item.time) parts.push(item.time);
  if (item.subtitle) parts.push(item.subtitle);
  return parts.join(" · ");
}

// opts.context ({session, time, section}) renders two stacked lines -
// "Session · time" then the section - and is only passed for the NOW
// card. opts.meta is the flat-mode day/time line.
function heroCard(label, item, extraClass, fallbackTitle, opts = {}) {
  const title = item ? item.title : fallbackTitle;
  const titleHtml = item ? titleWithNumber(item) : escapeHtml(title);
  const ctx = opts.context;
  let ctxHtml = "";
  if (ctx) {
    let sessionLine = ctx.session || "";
    if (ctx.time) sessionLine += (sessionLine ? " · " : "") + ctx.time;
    const sectionLine =
      ctx.section && ctx.section !== ctx.session ? ctx.section : "";
    if (sessionLine) {
      ctxHtml += `<div class="section-line">${escapeHtml(sessionLine)}</div>`;
    }
    if (sectionLine) {
      // "sub" styling only applies when stacked under a session line.
      ctxHtml += `<div class="section-line${sessionLine ? " sub" : ""}">${escapeHtml(sectionLine)}</div>`;
    }
  }
  return `<div class="hero-card ${extraClass}">
    <div class="label">${escapeHtml(label)}</div>
    ${ctxHtml}
    <div class="title">${titleHtml}</div>
    ${opts.meta ? `<div class="meta">${escapeHtml(opts.meta)}</div>` : ""}
  </div>`;
}

// Hero cards are bound to the active session: On stage / Side stage / Up
// next only ever show that session's competitors. As the session runs
// dry the first empty slot becomes a "Next session" name card and any
// further slot is dropped. `active` is null in flat (ungrouped) mode.
function renderHero(items, ci, active) {
  const hero = document.getElementById("hero");
  if (!items.length) {
    hero.innerHTML = heroCard("Schedule", null, "", "Schedule coming soon");
    return;
  }

  if (!active) {
    renderFlatHero(items, ci);
    return;
  }

  const sectionOnlyCtx = (i) => {
    const ctx = contextInfoFor(items, i);
    const section = ctx && (ctx.section || ctx.session);
    return section ? { section } : null;
  };
  const inSession = (i) => i >= active.firstIndex && i <= active.lastIndex;
  const sessionCtx = { session: active.name, time: active.time };
  const finished = ci > active.lastIndex;

  let html;
  const upcoming = [];
  if (finished) {
    html = heroCard("On stage", null, "now", "Session finished", {
      context: sessionCtx,
    });
  } else {
    let firstUpcomingFrom;
    if (ci < active.firstIndex) {
      html = heroCard("On stage", null, "now", "Starting soon", {
        context: sessionCtx,
      });
      firstUpcomingFrom = active.firstIndex;
    } else {
      html = heroCard("On stage", items[ci], "now", "", {
        context: contextInfoFor(items, ci),
      });
      firstUpcomingFrom = ci + 1;
    }
    const n1 = nextPresentIndex(items, firstUpcomingFrom);
    if (n1 >= 0 && inSession(n1)) {
      upcoming.push(n1);
      const n2 = nextPresentIndex(items, n1 + 1);
      if (n2 >= 0 && inSession(n2)) upcoming.push(n2);
    }
  }

  const labels = ["Side stage", "Up next"];
  const subCards = upcoming.map((idx, slot) =>
    heroCard(labels[slot], items[idx], "", "", { context: sectionOnlyCtx(idx) })
  );
  // First empty slot announces the next session; further slots are dropped.
  const nextSession = sessionAfter(items, active);
  if (subCards.length < 2 && nextSession) {
    const meta = [
      nextSession.day !== active.day ? nextSession.day : "",
      nextSession.time,
    ]
      .filter(Boolean)
      .join(" · ");
    subCards.push(`<div class="hero-card">
      <div class="label">Next session</div>
      <div class="title">${escapeHtml(nextSession.name || "Session")}</div>
      ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
    </div>`);
  }
  if (subCards.length) {
    html += `<div class="hero-sub${subCards.length === 1 ? " single" : ""}">${subCards.join("")}</div>`;
  }
  hero.innerHTML = html;
}

// Original behaviour for sheets with no session/section grouping.
function renderFlatHero(items, ci) {
  const hero = document.getElementById("hero");
  const finished = ci >= items.length;
  const nowIdx = ci >= 0 && !finished ? ci : -1;
  const nextFrom = finished ? items.length : nowIdx >= 0 ? nowIdx + 1 : 0;
  const nextIdx = nextPresentIndex(items, nextFrom);
  const laterIdx = nextIdx >= 0 ? nextPresentIndex(items, nextIdx + 1) : -1;

  let html;
  if (finished) {
    html = heroCard("On stage", null, "now", "That's a wrap - thanks for coming!");
  } else if (nowIdx === -1) {
    html = heroCard("On stage", null, "now", "Starting soon");
  } else {
    html = heroCard("On stage", items[nowIdx], "now", "", {
      meta: itemMeta(items[nowIdx]),
    });
  }

  const subCards = [];
  if (nextIdx >= 0) {
    subCards.push(
      heroCard("Side stage", items[nextIdx], "", "", { meta: itemMeta(items[nextIdx]) })
    );
  }
  if (laterIdx >= 0) {
    subCards.push(
      heroCard("Up next", items[laterIdx], "", "", { meta: itemMeta(items[laterIdx]) })
    );
  }
  if (subCards.length) {
    html += `<div class="hero-sub${subCards.length === 1 ? " single" : ""}">${subCards.join("")}</div>`;
  }
  hero.innerHTML = html;
}

// One view per day: tabs shown when the schedule spans multiple days.
// Tapping the live day returns to auto-follow, so the view moves along
// with the event again.
function renderDayTabs(days, currentKey, live) {
  const nav = document.getElementById("day-tabs");
  const multi = days.length > 1;
  nav.classList.toggle("visible", multi);
  if (!multi) {
    nav.innerHTML = "";
    return;
  }
  nav.innerHTML = days
    .map(
      (d) =>
        `<button data-day="${escapeHtml(d.key)}" class="${
          d.key === currentKey ? "active" : ""
        }">${escapeHtml(d.day || d.date || "Day")}</button>`
    )
    .join("");
  nav.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedDayKey = btn.dataset.day === live ? null : btn.dataset.day;
      render();
    });
  });
}

function renderSchedule(items, ci, highlightIdx, dayKey) {
  const container = document.getElementById("schedule");
  if (hasGrouping(items)) {
    container.innerHTML = renderGroupedList(items, ci, highlightIdx, dayKey);
  } else {
    container.innerHTML = renderFlatList(items, ci, highlightIdx);
  }
  container.querySelectorAll(".show-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      if (expandedGroups.has(key)) expandedGroups.delete(key);
      else expandedGroups.add(key);
      render();
    });
  });
}

function scheduleRow(item, index, ci, withTime, highlightIdx) {
  const wd = isWithdrawn(item);
  const cls = wd
    ? "withdrawn"
    : index < ci
      ? "past"
      : index === highlightIdx
        ? "current"
        : "upcoming";
  return `<div class="schedule-item ${cls}" data-index="${index}">
    ${withTime && item.time ? `<div class="time">${escapeHtml(item.time)}</div>` : ""}
    <div class="body">
      <div class="title">${titleWithNumber(item)}${wd ? '<span class="wd-tag">Withdrawn</span>' : ""}</div>
      ${item.subtitle ? `<div class="subtitle">${escapeHtml(item.subtitle)}</div>` : ""}
    </div>
  </div>`;
}

function renderFlatList(items, ci, highlightIdx) {
  return groupByDay(items)
    .map((group) => {
      const rows = group.entries
        .map(({ item, index }) => scheduleRow(item, index, ci, true, highlightIdx))
        .join("");
      const heading = group.day ? `<h2>${escapeHtml(group.day)}</h2>` : "";
      return `<div class="day-group">${heading}${rows}</div>`;
    })
    .join("");
}

// Day heading → session header (name + estimated time) → section
// subheadings → one row per item. Past and future sessions collapse
// behind "Show more" buttons; the current session is always expanded,
// with its completed items tucked behind their own toggle.
function renderGroupedList(items, ci, highlightIdx, dayKey) {
  const days = groupSchedule(items);
  // Day views: render only the selected day; the tabs already name it,
  // so the in-list day heading is dropped. Single-day schedules keep the
  // old all-in-one rendering.
  const filtered =
    dayKey && days.length > 1 ? days.filter((d) => d.key === dayKey) : days;
  const showHeading = filtered.length === days.length;
  return filtered
    .map((dayGroup) => {
      const sessions = dayGroup.sessions
        .map((ses) => renderSession(ses, ci, highlightIdx))
        .join("");
      const heading =
        showHeading && dayGroup.day ? `<h2>${escapeHtml(dayGroup.day)}</h2>` : "";
      return `<div class="day-group">${heading}${sessions}</div>`;
    })
    .join("");
}

// One collapsible block per section. Past and future sections collapse to
// their header row; the current section stays open with its completed
// rows behind the toggle. The toggle is returned separately from the
// header so an unnamed section can lend it to the session header line.
function sectionBlock(sec, ci, highlightIdx) {
  const first = sec.entries[0].index;
  const last = sec.entries[sec.entries.length - 1].index;
  const isCurrent = ci >= first && ci <= last;
  const isPast = ci > last;
  const key = `sec:${currentTheatre}:${sectionStableKey(sec)}`;
  const expanded = expandedGroups.has(key);

  let btn = "";
  let visible;
  if (isCurrent) {
    const doneCount = sec.entries.filter(({ index }) => index < ci).length;
    if (doneCount > 0) {
      btn = toggleBtn(key, expanded ? "Hide done" : `Show ${doneCount} done`);
    }
    visible = ({ index }) => expanded || index >= ci;
  } else {
    btn = toggleBtn(key, expanded ? "Hide" : `Show ${sec.entries.length}`);
    visible = () => expanded;
  }

  const rows = sec.entries
    .filter(visible)
    .map(({ item, index }) => scheduleRow(item, index, ci, false, highlightIdx))
    .join("");
  // Pink "live" styling follows the highlight, which is suppressed once
  // the active session has finished.
  const isLive = highlightIdx >= first && highlightIdx <= last;
  const cls = isLive ? " current" : isPast ? " past" : "";
  const header = sec.name
    ? `<div class="section-subheader${cls}">
        <span class="name">${escapeHtml(sec.name)}</span>
        ${btn}
      </div>`
    : "";
  return { header, btn, rows };
}

function renderSession(ses, ci, highlightIdx) {
  const lastIndex = ses.firstIndex + ses.count - 1;
  const headerCls =
    highlightIdx >= ses.firstIndex && highlightIdx <= lastIndex
      ? " current"
      : ci > lastIndex
        ? " past"
        : "";

  let hoistedBtn = "";
  const body = ses.sections
    .map((sec) => {
      const block = sectionBlock(sec, ci, highlightIdx);
      if (!sec.name) {
        // No subheader to host the toggle - hoist it to the session header.
        hoistedBtn = block.btn || hoistedBtn;
        return block.rows;
      }
      return block.header + block.rows;
    })
    .join("");

  const header = `<div class="session-header${headerCls}">
    <span class="name">${escapeHtml(ses.name || "Session")}</span>
    ${ses.time ? `<span class="time">${escapeHtml(ses.time)}</span>` : ""}
    ${hoistedBtn}
  </div>`;
  return `<div class="session-group">${header}${body}</div>`;
}

// Scroll the current item into view, but only when the position actually
// changes so we never fight the user's own scrolling.
function autoScroll(ci) {
  const key = currentTheatre + ":" + ci;
  if (key === lastScrollKey) return;
  lastScrollKey = key;
  const el = document.querySelector('.schedule-item.current');
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderStatus() {
  const bar = document.getElementById("status-bar");
  if (DEMO_MODE) {
    bar.textContent = "Demo mode - sample data";
    bar.classList.remove("error");
    return;
  }
  if (!lastSuccessAt) {
    // Cached content is on screen while the first fetch is in flight -
    // informational, not an error.
    bar.textContent = state ? "Checking for updates…" : "Connecting…";
    bar.classList.toggle("error", !state);
    return;
  }
  // Purely response-age based: "Live" while responses are fresh (<3s),
  // the age once they aren't - in-flight requests don't change the text.
  const age = Math.round((Date.now() - lastSuccessAt) / 1000);
  const stale = age > (window.CONFIG.POLL_MS / 1000) * 3;
  bar.textContent = stale
    ? `Reconnecting… (last update ${age}s ago)`
    : age < 3
      ? "Live"
      : `Last updated ${age}s ago`;
  bar.classList.toggle("error", stale);
}

state = loadCachedState();
if (state) {
  currentTheatre = pickTheatre(state);
  render();
} else {
  showLoading();
}
refresh();
setInterval(refresh, window.CONFIG.POLL_MS);
setInterval(renderStatus, 1000);
