// Admin control panel.
//
// Auth flow: the shared admin token is entered once, verified against the
// backend, then kept in localStorage - which persists until browser data
// is cleared, so it comfortably lasts the whole event week.

let state = null;
let currentTheatre = null;
let lastSuccessAt = null;
let pendingActions = 0;
let fetching = false;
let pollTimer = null;

// In-progress markers: the UI keeps showing the server's confirmed state
// and overlays these until each request comes back.
let pendingIndexOp = null; // {theatre, index} - target awaiting confirmation
const pendingWdOps = new Map(); // "theatre::index" -> desired withdrawn bool
let pendingSessionOp = null; // {theatre, key, name} - session switch in flight
let pendingAnnouncements = 0;

// "Show more" toggles for folded sections in the jump list, mirroring the
// public page. Keys are "sec:<theatre>:<day|session|section>".
const expandedGroups = new Set();

const PENDING_STAGE_LABEL = "Sending on stage";

const els = {
  gate: document.getElementById("gate"),
  gateForm: document.getElementById("gate-form"),
  gateToken: document.getElementById("gate-token"),
  gateError: document.getElementById("gate-error"),
  panel: document.getElementById("panel"),
  statusBar: document.getElementById("status-bar"),
  tabs: document.getElementById("theatre-tabs"),
  now: document.getElementById("admin-now"),
  prev: document.getElementById("btn-prev"),
  next: document.getElementById("btn-next"),
  errorBanner: document.getElementById("error-banner"),
  announceInput: document.getElementById("announcement-input"),
  announce: document.getElementById("btn-announce"),
  announceClear: document.getElementById("btn-announce-clear"),
  jumpList: document.getElementById("jump-list"),
  signout: document.getElementById("btn-signout"),
  sessionPicker: document.getElementById("session-picker"),
  sessionSelect: document.getElementById("session-select"),
};

document.getElementById("event-name").textContent = window.CONFIG.EVENT_NAME;
document.title = window.CONFIG.EVENT_NAME + " - Admin";

function getToken() {
  return localStorage.getItem(LS_KEYS.token) || "";
}

// -- Token gate ---------------------------------------------------------

async function init() {
  const token = getToken();
  if (!token) {
    showGate();
    return;
  }
  // Open the panel immediately - with the cached schedule if there is
  // one, behind a spinner if not - and verify the saved code in the
  // background rather than blocking on the ~2s round-trip.
  state = loadCachedState();
  enterPanel();
  try {
    state = await apiPost({ action: "verify", token });
    lastSuccessAt = Date.now();
    if (!currentTheatre) currentTheatre = pickTheatre(state);
    render();
  } catch (err) {
    if (isUnauthorized(err)) {
      localStorage.removeItem(LS_KEYS.token);
      showGate("Saved code no longer valid - please re-enter it.");
    }
    // Other errors: keep the token and let polling recover.
  }
  renderStatus();
}

function isUnauthorized(err) {
  return /unauthorized/i.test(String(err && err.message));
}

function showGate(message) {
  els.gate.hidden = false;
  els.panel.hidden = true;
  els.statusBar.hidden = true;
  els.gateError.textContent = message || "";
}

els.gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = els.gateToken.value.trim();
  if (!token) return;
  els.gateError.textContent = "Checking…";
  try {
    state = await apiPost({ action: "verify", token });
    lastSuccessAt = Date.now();
    localStorage.setItem(LS_KEYS.token, token);
    enterPanel();
  } catch (err) {
    els.gateError.textContent = isUnauthorized(err)
      ? "That code isn't right - check it and try again."
      : "Couldn't reach the server. Check your connection and try again.";
  }
});

function enterPanel() {
  els.gate.hidden = true;
  els.panel.hidden = false;
  els.statusBar.hidden = false;
  if (state && !currentTheatre) currentTheatre = pickTheatre(state);
  if (state) {
    render();
  } else {
    document.getElementById("loading-overlay").hidden = false;
  }
  renderStatus();
  if (!pollTimer) {
    pollTimer = setInterval(refresh, window.CONFIG.POLL_MS);
    setInterval(renderStatus, 1000);
  }
}

// -- Data ---------------------------------------------------------------

// Monotonic adoption: every request takes a sequence number when issued,
// and a response is only adopted if nothing newer has been adopted since.
// An old, slow response can never rewind the display.
let reqSeq = 0;
let lastAdoptedSeq = 0;

// Clears in-progress markers whose change is already visible in the
// adopted server state - so even if an action's own response is lost
// (timeout, dropped connection), the next poll confirms it within
// seconds instead of the marker sticking forever.
function reconcilePending() {
  if (pendingIndexOp) {
    const t = state.theatres.find((x) => x.id === pendingIndexOp.theatre);
    if (t && t.currentIndex === pendingIndexOp.index) pendingIndexOp = null;
  }
  if (pendingSessionOp) {
    const t = state.theatres.find((x) => x.id === pendingSessionOp.theatre);
    if (t && t.activeSession === pendingSessionOp.key) pendingSessionOp = null;
  }
  pendingWdOps.forEach((wanted, key) => {
    const sep = key.lastIndexOf("::");
    const items = itemsForTheatre(state, key.slice(0, sep));
    const item = items[Number(key.slice(sep + 2))];
    if (item && isWithdrawn(item) === wanted) pendingWdOps.delete(key);
  });
}

async function refresh(force) {
  // Single-flight; polls keep running even while actions are pending so
  // reconcilePending() can confirm a change whose response went missing.
  if (fetching && !force) return;
  const seq = ++reqSeq;
  fetching = true;
  renderStatus();
  try {
    const data = await apiGet();
    lastSuccessAt = Date.now();
    if (seq > lastAdoptedSeq) {
      lastAdoptedSeq = seq;
      state = data;
      if (!currentTheatre || !state.theatres.some((t) => t.id === currentTheatre)) {
        currentTheatre = pickTheatre(state);
      }
      reconcilePending();
      render();
    }
  } catch (err) {
    console.error("Refresh failed:", err);
  } finally {
    fetching = false;
  }
  renderStatus();
}

function showErrorBanner(message) {
  els.errorBanner.innerHTML = `${escapeHtml(message)}
    <span class="hint">Tap to dismiss. The schedule below has been re-synced - please try again.</span>`;
  els.errorBanner.hidden = false;
}

function hideErrorBanner() {
  els.errorBanner.hidden = true;
}

els.errorBanner.addEventListener("click", hideErrorBanner);

async function runAction(payload) {
  if (!state) return;
  hideErrorBanner();

  // Build an idempotent request (Next/Back become an absolute setIndex,
  // so retries after a timed-out-but-applied request can never advance
  // twice) and record a pending marker for the in-progress UI.
  let send = payload;
  let wdKey = null;
  let indexMarker = null;
  let sessionMarker = null;
  if (
    payload.action === "advance" ||
    payload.action === "previous" ||
    payload.action === "setIndex"
  ) {
    const items = itemsForTheatre(state, payload.theatre);
    const theatre = state.theatres.find((t) => t.id === payload.theatre);
    // Chain from an in-flight target so double-tapping Next steps twice.
    const base =
      pendingIndexOp && pendingIndexOp.theatre === payload.theatre
        ? pendingIndexOp.index
        : theatre
          ? theatre.currentIndex
          : -1;
    // Session guard: stepping never leaves the active session. Next past
    // the last competitor parks exactly at "session finished" (not on the
    // next session's rows), and Back stops at "session start".
    const activeSes = activeSessionForCurrent(items, effectiveIndex(items, base));
    let target;
    if (payload.action === "setIndex") {
      target = clampIndex(Number(payload.index), items.length);
    } else if (payload.action === "advance") {
      if (activeSes && base < activeSes.firstIndex) {
        // From "not started", Next targets the session's first present
        // competitor (stepIndex would normalise over a withdrawn previous
        // item and overshoot by one).
        target = nextPresentIndex(items, activeSes.firstIndex);
      } else {
        target = stepIndex(items, base, "advance");
      }
      if (activeSes && (target === -1 || target > activeSes.lastIndex)) {
        target = activeSes.lastIndex + 1; // session finished
      }
    } else {
      target = stepIndex(items, base, "previous");
      if (activeSes && target < activeSes.firstIndex) {
        target = activeSes.firstIndex - 1; // session start
      }
    }
    send = { action: "setIndex", theatre: payload.theatre, index: target };
    indexMarker = pendingIndexOp = { theatre: payload.theatre, index: target };
  } else if (payload.action === "setWithdrawn") {
    wdKey = payload.theatre + "::" + payload.index;
    pendingWdOps.set(wdKey, !!payload.withdrawn);
  } else if (payload.action === "setSession") {
    send = {
      action: "setSession",
      theatre: payload.theatre,
      session: payload.session,
      index: payload.index,
    };
    sessionMarker = pendingSessionOp = {
      theatre: payload.theatre,
      key: payload.session,
      name: payload.sessionName || "",
    };
  } else if (payload.action === "setAnnouncement") {
    pendingAnnouncements += 1;
  }

  pendingActions += 1;
  render();
  renderStatus();
  ++reqSeq;
  try {
    const serverState = await apiPostWithRetry({ ...send, token: getToken() });
    lastSuccessAt = Date.now();
    // Adopt the server's state only once no newer action is in flight.
    // A POST response is authoritative (built after the write), so it
    // outranks any poll issued up to now.
    if (pendingActions === 1) {
      lastAdoptedSeq = reqSeq;
      state = serverState;
      reconcilePending();
    }
  } catch (err) {
    if (isUnauthorized(err)) {
      localStorage.removeItem(LS_KEYS.token);
      showGate("Saved code no longer valid - please re-enter it.");
    } else {
      // The response was lost, but the write may still have been applied
      // (timeouts happen after the server processed it). Sync first and
      // only alarm the operator if the change genuinely didn't land.
      await refresh(true);
      const landed =
        (indexMarker !== null && pendingIndexOp !== indexMarker) ||
        (sessionMarker !== null && pendingSessionOp !== sessionMarker) ||
        (wdKey !== null && pendingWdOps.get(wdKey) !== !!payload.withdrawn) ||
        (payload.action === "setAnnouncement" &&
          state &&
          state.announcement === String(payload.text || ""));
      if (!landed) {
        showErrorBanner(
          "Change NOT saved - it failed 3 times. Check your connection."
        );
      }
    }
  } finally {
    pendingActions -= 1;
    if (payload.action === "setAnnouncement") {
      pendingAnnouncements -= 1;
    } else if (wdKey !== null) {
      // Only clear if a newer toggle for the same item hasn't replaced it.
      if (pendingWdOps.get(wdKey) === !!payload.withdrawn) {
        pendingWdOps.delete(wdKey);
      }
    } else if (sessionMarker !== null) {
      if (pendingSessionOp === sessionMarker) pendingSessionOp = null;
    } else if (indexMarker !== null && pendingIndexOp === indexMarker) {
      pendingIndexOp = null;
    }
    render();
    renderStatus();
  }
}

// -- Rendering ----------------------------------------------------------

function currentItems() {
  return state ? itemsForTheatre(state, currentTheatre) : [];
}

function currentIndex() {
  const t = state && state.theatres.find((t) => t.id === currentTheatre);
  return t ? t.currentIndex : -1;
}

function activeKeyForCurrent() {
  const t = state && state.theatres.find((x) => x.id === currentTheatre);
  return (t && t.activeSession) || "";
}

function activeSessionForCurrent(items, effCi) {
  return hasGrouping(items)
    ? resolveActiveSession(items, activeKeyForCurrent(), effCi)
    : null;
}

// Active session + session-aware display position for the current theatre.
function sessionView(items) {
  const raw = currentIndex();
  const active = activeSessionForCurrent(items, effectiveIndex(items, raw));
  return { active, ci: sessionDisplayIndex(items, raw, active) };
}

function render() {
  if (!state) return;
  document.getElementById("loading-overlay").hidden = true;
  renderTabs();
  renderSessionPicker();
  renderNow();
  renderJumpList();
  els.announce.textContent = pendingAnnouncements > 0 ? "Posting…" : "Post";
  els.announce.disabled = pendingAnnouncements > 0;
  els.announceClear.disabled = pendingAnnouncements > 0;
  // Only prefill the announcement box when the user isn't mid-edit.
  if (document.activeElement !== els.announceInput) {
    els.announceInput.value = state.announcement || "";
  }
  const items = currentItems();
  const ci = currentIndex();
  const { active, ci: eff } = sessionView(items);
  // Back stops at the session start; Next stops at session finished (the
  // operator starts the next session explicitly from the picker/button).
  els.prev.disabled = active ? eff < active.firstIndex : ci <= -1;
  els.next.disabled = active ? eff > active.lastIndex : ci >= items.length;
  renderStepButtons(items, eff, active);
}

function itemShortName(item) {
  const n = competitorNumber(item);
  return (n ? n + " " : "") + item.title;
}

// Detail line under Next/Back mirroring the public hero cards: who each
// button would put on stage, or that it ends the session.
function renderStepButtons(items, eff, active) {
  let nextDetail = "";
  if (!els.next.disabled) {
    const from = active && eff < active.firstIndex ? active.firstIndex : eff + 1;
    const n = nextPresentIndex(items, from);
    if (active && (n === -1 || n > active.lastIndex)) {
      nextDetail = "Ends the session";
    } else if (n >= 0) {
      nextDetail = itemShortName(items[n]);
    }
  }
  let backDetail = "";
  if (!els.prev.disabled) {
    const p = prevPresentIndex(items, Math.min(eff, items.length) - 1);
    if (active) {
      backDetail = p >= active.firstIndex ? itemShortName(items[p]) : "Session start";
    } else {
      backDetail = p >= 0 ? itemShortName(items[p]) : "Not started";
    }
  }
  els.next.innerHTML = `<span class="btn-label">Next →</span>${
    nextDetail ? `<span class="btn-detail">${escapeHtml(nextDetail)}</span>` : ""
  }`;
  els.prev.innerHTML = `<span class="btn-label">← Back</span>${
    backDetail ? `<span class="btn-detail">${escapeHtml(backDetail)}</span>` : ""
  }`;
}

let sessionPickerSig = "";

function renderSessionPicker() {
  const items = currentItems();
  const grouped = hasGrouping(items);
  els.sessionPicker.hidden = !grouped;
  if (!grouped) return;
  const eff = effectiveIndex(items, currentIndex());
  const active = resolveActiveSession(items, activeKeyForCurrent(), eff);
  const pendingKey =
    pendingSessionOp && pendingSessionOp.theatre === currentTheatre
      ? pendingSessionOp.key
      : null;
  const selectedKey = pendingKey || (active ? sessionKeyOf(active) : "");
  const byDay = new Map();
  sessionsOf(items).forEach((s) => {
    const day = s.day || "";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  });
  let html = "";
  byDay.forEach((list, day) => {
    const opts = list
      .map((s) => {
        const key = sessionKeyOf(s);
        const label =
          (s.name || "Session") + (s.time ? ` (${s.time})` : "");
        return `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
      })
      .join("");
    html += day ? `<optgroup label="${escapeHtml(day)}">${opts}</optgroup>` : opts;
  });
  // Never touch the select while the operator has it open (2s polls used
  // to rebuild the options mid-pick, cancelling the selection), and skip
  // rebuilds when nothing changed. Selection is synced via .value so it
  // never forces a rebuild.
  if (document.activeElement !== els.sessionSelect) {
    if (html !== sessionPickerSig) {
      sessionPickerSig = html;
      els.sessionSelect.innerHTML = html;
    }
    if (els.sessionSelect.value !== selectedKey) {
      els.sessionSelect.value = selectedKey;
    }
  }
  els.sessionSelect.disabled = !!pendingSessionOp;
}

function renderTabs() {
  const multi = state.theatres.length > 1;
  els.tabs.classList.toggle("visible", multi);
  if (!multi) {
    els.tabs.innerHTML = "";
    return;
  }
  els.tabs.innerHTML = state.theatres
    .map(
      (t) =>
        `<button data-theatre="${escapeHtml(t.id)}" class="${
          t.id === currentTheatre ? "active" : ""
        }">${escapeHtml(t.id)}</button>`
    )
    .join("");
  els.tabs.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTheatre = btn.dataset.theatre;
      localStorage.setItem(LS_KEYS.theatre, currentTheatre);
      render();
    });
  });
}

// Explicit, confirmed session start - the only way to move between
// sessions (Next is disabled once a session finishes).
function confirmStartSession(ses) {
  const label = ses.name || "Session";
  if (
    confirm(
      `Start "${label}"? The stage position moves to the start of this session.`
    )
  ) {
    runAction({
      action: "setSession",
      theatre: currentTheatre,
      session: sessionKeyOf(ses),
      index: ses.firstIndex - 1,
      sessionName: ses.name,
    });
  } else {
    render(); // snap the picker back
  }
}

function renderNow() {
  const items = currentItems();
  // Session-aware position: never a withdrawn competitor, and pinned to
  // "not started" while the pointer sits before the active session.
  const { active, ci } = sessionView(items);
  let title, meta, titleHtml = "", secLine = "", startNext = null;
  if (!items.length) {
    title = "No schedule items yet";
    meta = "";
  } else if (active && ci > active.lastIndex) {
    title = "Session finished";
    secLine = contextLabel({ session: active.name, time: active.time });
    startNext = sessionAfter(items, active);
    meta = startNext ? "" : "That was the last session - all done!";
  } else if (active && ci < active.firstIndex) {
    title = "Not started";
    secLine = contextLabel({ session: active.name, time: active.time });
    const first = nextPresentIndex(items, active.firstIndex);
    meta =
      first >= 0 && first <= active.lastIndex
        ? "Press Next to put the first competitor on stage: " + items[first].title
        : "";
  } else if (ci < 0) {
    title = "Not started";
    meta = "Press Next to start with: " + (items[0] ? items[0].title : "");
  } else if (ci >= items.length) {
    title = "Finished";
    meta = "All items are done. Press Back to reopen the last item.";
  } else {
    const item = items[ci];
    title = item.title;
    titleHtml =
      titleWithNumber(item) +
      (isWithdrawn(item) ? ' <span class="wd-tag">Withdrawn</span>' : "");
    secLine = hasGrouping(items) ? contextLabel(contextInfoFor(items, ci)) : "";
    meta = secLine
      ? String(item.subtitle || "")
      : [item.day, item.time, item.subtitle].filter(Boolean).join(" · ");
  }
  // In-flight operations: announce what is being changed, session-aware -
  // stepping past the session's end reads as ending it, not as sending
  // the next session's competitor on stage.
  let pendingLine = "";
  if (pendingSessionOp && pendingSessionOp.theatre === currentTheatre) {
    pendingLine = `<div class="pending-line">Starting session: ${escapeHtml(pendingSessionOp.name || "Session")}…</div>`;
  } else if (pendingIndexOp && pendingIndexOp.theatre === currentTheatre) {
    const idx = pendingIndexOp.index;
    let text;
    if (active && idx > active.lastIndex) {
      text = `Ending session: ${active.name || "Session"}`;
    } else if (active && idx < active.firstIndex) {
      text = "Returning to session start";
    } else {
      const target = items[idx];
      const targetText = target
        ? target.title
        : idx < 0
          ? "Not started"
          : "Finished";
      text = `${PENDING_STAGE_LABEL}: ${targetText}`;
    }
    pendingLine = `<div class="pending-line">${escapeHtml(text)}…</div>`;
  }
  const startNextBtn = startNext
    ? `<button id="btn-start-next" class="btn primary full start-next"${
        pendingSessionOp ? " disabled" : ""
      }>Start next session: ${escapeHtml(startNext.name || "Session")} →</button>`
    : "";
  els.now.innerHTML = `<div class="label">On now${
    state.theatres.length > 1 ? " - " + escapeHtml(currentTheatre) : ""
  }</div>
    ${secLine ? `<div class="section-line">${escapeHtml(secLine)}</div>` : ""}
    <div class="title">${titleHtml || escapeHtml(title)}</div>
    ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
    ${pendingLine}${startNextBtn}`;
  if (startNext) {
    els.now
      .querySelector("#btn-start-next")
      .addEventListener("click", () => confirmStartSession(startNext));
  }
}

// Each row pairs the jump button with a withdraw/reinstate toggle.
// In-flight operations render as pulsing in-progress markers instead of
// showing the change as already done.
function jumpRow(item, index, ci, withTime, highlightIdx, pendingTagIdx) {
  const wd = isWithdrawn(item);
  const wdKey = currentTheatre + "::" + index;
  const wdPending = pendingWdOps.has(wdKey);
  const isPendingTarget = index === pendingTagIdx;
  const cls = wd
    ? "withdrawn"
    : index < ci
      ? "past"
      : index === highlightIdx
        ? "current"
        : "";
  const wdBtnLabel = wdPending
    ? pendingWdOps.get(wdKey)
      ? "Withdrawing…"
      : "Reinstating…"
    : wd
      ? "Reinstate"
      : "WD";
  return `<div class="jump-row">
    <button class="jump-item ${cls}" data-index="${index}">
      ${withTime && item.time ? `<span class="time">${escapeHtml(item.time)}</span>` : ""}
      <span class="body">
        <span class="title">${titleWithNumber(item)}${wd ? ' <span class="wd-tag">Withdrawn</span>' : ""}${
          isPendingTarget
            ? ` <span class="pending-tag">${escapeHtml(PENDING_STAGE_LABEL)}…</span>`
            : ""
        }</span>
        ${item.subtitle ? ` <span class="subtitle">${escapeHtml(item.subtitle)}</span>` : ""}
      </span>
    </button>
    <button class="wd-btn${wdPending ? " pending" : ""}" data-index="${index}"${
      wdPending ? " disabled" : ""
    }>${escapeHtml(wdBtnLabel)}</button>
  </div>`;
}

// One collapsible block per section, mirroring the public page: past and
// future sections fold to their header, the current section stays open
// with completed rows behind a "Show N done" pill.
function jumpSectionBlock(sec, ci, highlightIdx, pendingTagIdx) {
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
    .map(({ item, index }) =>
      jumpRow(item, index, ci, false, highlightIdx, pendingTagIdx)
    )
    .join("");
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

function renderJumpList() {
  const items = currentItems();
  const { active, ci } = sessionView(items);
  // No row is "current" while the pointer is outside the active session.
  const highlightIdx =
    active && (ci > active.lastIndex || ci < active.firstIndex) ? -1 : ci;
  // The "Sending on stage…" row tag only applies to in-session targets;
  // an out-of-session target means the session is ending, which the
  // On-now card announces instead.
  const pendingTagIdx =
    pendingIndexOp &&
    pendingIndexOp.theatre === currentTheatre &&
    (!active ||
      (pendingIndexOp.index >= active.firstIndex &&
        pendingIndexOp.index <= active.lastIndex))
      ? pendingIndexOp.index
      : -1;
  if (hasGrouping(items)) {
    els.jumpList.innerHTML = groupSchedule(items)
      .map((dayGroup) => {
        const sessions = dayGroup.sessions
          .map((ses) => {
            const lastIndex = ses.firstIndex + ses.count - 1;
            const sesCurrent =
              highlightIdx >= ses.firstIndex && highlightIdx <= lastIndex;
            const headerCls = sesCurrent
              ? " current"
              : ci > lastIndex
                ? " past"
                : "";
            let hoistedBtn = "";
            const sections = ses.sections
              .map((sec) => {
                const block = jumpSectionBlock(sec, ci, highlightIdx, pendingTagIdx);
                if (!sec.name) {
                  // No subheader to host the toggle - hoist it to the
                  // session header line.
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
            return `<div class="session-group">${header}${sections}</div>`;
          })
          .join("");
        const heading = dayGroup.day ? `<h2>${escapeHtml(dayGroup.day)}</h2>` : "";
        return `<div class="day-group">${heading}${sessions}</div>`;
      })
      .join("");
    wireJumpButtons(items);
    return;
  }
  const groups = groupByDay(items);
  els.jumpList.innerHTML = groups
    .map((group) => {
      const rows = group.entries
        .map(({ item, index }) =>
          jumpRow(item, index, ci, true, highlightIdx, pendingTagIdx)
        )
        .join("");
      const heading = group.day ? `<h2>${escapeHtml(group.day)}</h2>` : "";
      return `<div class="day-group">${heading}${rows}</div>`;
    })
    .join("");
  wireJumpButtons(items);
}

function wireJumpButtons(items) {
  els.jumpList.querySelectorAll(".show-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      if (expandedGroups.has(key)) expandedGroups.delete(key);
      else expandedGroups.add(key);
      render();
    });
  });
  els.jumpList.querySelectorAll(".jump-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.index);
      const item = items[index];
      if (!item) return;
      if (isWithdrawn(item)) {
        alert(
          `"${item.title}" is withdrawn and can't be made current. ` +
            "Tap Reinstate first if they're competing after all."
        );
        return;
      }
      if (confirm(`Jump to "${item.title}"?`)) {
        runAction({ action: "setIndex", theatre: currentTheatre, index });
      }
    });
  });
  els.jumpList.querySelectorAll(".wd-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.index);
      const item = items[index];
      if (!item) return;
      const wd = isWithdrawn(item);
      const question = wd
        ? `Reinstate "${item.title}"?`
        : `Withdraw "${item.title}"? They'll be skipped on the day.`;
      if (confirm(question)) {
        runAction({
          action: "setWithdrawn",
          theatre: currentTheatre,
          index,
          withdrawn: !wd,
        });
      }
    });
  });
}

function renderStatus() {
  if (DEMO_MODE) {
    els.statusBar.textContent = "Demo mode - changes only affect this tab";
    els.statusBar.classList.remove("error");
    return;
  }
  if (!lastSuccessAt) {
    els.statusBar.textContent = state ? "Checking for updates…" : "Connecting…";
    els.statusBar.classList.toggle("error", !state);
    return;
  }
  if (pendingActions > 0) {
    els.statusBar.textContent = "Saving…";
    els.statusBar.classList.remove("error");
    return;
  }
  if (fetching) {
    els.statusBar.textContent = "Updating…";
    els.statusBar.classList.remove("error");
    return;
  }
  const age = Math.round((Date.now() - lastSuccessAt) / 1000);
  const stale = age > (window.CONFIG.POLL_MS / 1000) * 3;
  els.statusBar.textContent = stale
    ? `Reconnecting… (last update ${age}s ago)`
    : `Live · updated ${age}s ago`;
  els.statusBar.classList.toggle("error", stale);
}

// -- Wire up controls ---------------------------------------------------

els.next.addEventListener("click", () =>
  runAction({ action: "advance", theatre: currentTheatre })
);
els.prev.addEventListener("click", () =>
  runAction({ action: "previous", theatre: currentTheatre })
);
els.announce.addEventListener("click", () =>
  runAction({ action: "setAnnouncement", text: els.announceInput.value.trim() })
);
els.announceClear.addEventListener("click", () => {
  els.announceInput.value = "";
  runAction({ action: "setAnnouncement", text: "" });
});
els.sessionSelect.addEventListener("change", () => {
  const key = els.sessionSelect.value;
  // Release focus so subsequent renders may sync the selection again.
  els.sessionSelect.blur();
  const ses = sessionsOf(currentItems()).find((s) => sessionKeyOf(s) === key);
  if (ses) confirmStartSession(ses);
  else render();
});
els.signout.addEventListener("click", () => {
  if (confirm("Sign out of admin on this device?")) {
    localStorage.removeItem(LS_KEYS.token);
    showGate();
  }
});

init();
