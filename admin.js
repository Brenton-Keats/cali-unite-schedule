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
let pendingAnnouncements = 0;

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

async function refresh(force) {
  // Never let a poll clobber optimistic state while actions are in flight.
  if (pendingActions > 0 && !force) return;
  fetching = true;
  renderStatus();
  try {
    state = await apiGet();
    lastSuccessAt = Date.now();
    if (!currentTheatre || !state.theatres.some((t) => t.id === currentTheatre)) {
      currentTheatre = pickTheatre(state);
    }
    render();
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
    const target =
      payload.action === "setIndex"
        ? clampIndex(Number(payload.index), items.length)
        : stepIndex(items, base, payload.action);
    send = { action: "setIndex", theatre: payload.theatre, index: target };
    indexMarker = pendingIndexOp = { theatre: payload.theatre, index: target };
  } else if (payload.action === "setWithdrawn") {
    wdKey = payload.theatre + "::" + payload.index;
    pendingWdOps.set(wdKey, !!payload.withdrawn);
  } else if (payload.action === "setAnnouncement") {
    pendingAnnouncements += 1;
  }

  pendingActions += 1;
  render();
  renderStatus();
  try {
    const serverState = await apiPostWithRetry({ ...send, token: getToken() });
    lastSuccessAt = Date.now();
    // Adopt the server's state only once no newer action is in flight.
    if (pendingActions === 1) state = serverState;
  } catch (err) {
    if (isUnauthorized(err)) {
      localStorage.removeItem(LS_KEYS.token);
      showGate("Saved code no longer valid - please re-enter it.");
    } else {
      showErrorBanner(
        "Change NOT saved - it failed 3 times. Check your connection."
      );
      await refresh(true);
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
    } else if (pendingIndexOp === indexMarker) {
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

function render() {
  if (!state) return;
  document.getElementById("loading-overlay").hidden = true;
  renderTabs();
  renderNow();
  renderJumpList();
  els.prev.textContent = "← Back";
  els.next.textContent = "Next →";
  els.announce.textContent = pendingAnnouncements > 0 ? "Posting…" : "Post";
  els.announce.disabled = pendingAnnouncements > 0;
  els.announceClear.disabled = pendingAnnouncements > 0;
  // Only prefill the announcement box when the user isn't mid-edit.
  if (document.activeElement !== els.announceInput) {
    els.announceInput.value = state.announcement || "";
  }
  const items = currentItems();
  const ci = currentIndex();
  els.prev.disabled = ci <= -1;
  els.next.disabled = ci >= items.length;
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

function renderNow() {
  const items = currentItems();
  // Effective position: never presents a withdrawn competitor as current.
  const ci = effectiveIndex(items, currentIndex());
  let title, meta, titleHtml = "", secLine = "";
  if (!items.length) {
    title = "No schedule items yet";
    meta = "";
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
  // In-flight position change: announce the incoming competitor.
  let pendingLine = "";
  if (pendingIndexOp && pendingIndexOp.theatre === currentTheatre) {
    const target = items[pendingIndexOp.index];
    const targetText = target
      ? target.title
      : pendingIndexOp.index < 0
        ? "Not started"
        : "Finished";
    pendingLine = `<div class="pending-line">${escapeHtml(PENDING_STAGE_LABEL)}: ${escapeHtml(targetText)}…</div>`;
  }
  els.now.innerHTML = `<div class="label">On now${
    state.theatres.length > 1 ? " - " + escapeHtml(currentTheatre) : ""
  }</div>
    ${secLine ? `<div class="section-line">${escapeHtml(secLine)}</div>` : ""}
    <div class="title">${titleHtml || escapeHtml(title)}</div>
    ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
    ${pendingLine}`;
}

// Each row pairs the jump button with a withdraw/reinstate toggle.
// In-flight operations render as pulsing in-progress markers instead of
// showing the change as already done.
function jumpRow(item, index, ci, withTime) {
  const wd = isWithdrawn(item);
  const wdKey = currentTheatre + "::" + index;
  const wdPending = pendingWdOps.has(wdKey);
  const isPendingTarget =
    pendingIndexOp &&
    pendingIndexOp.theatre === currentTheatre &&
    pendingIndexOp.index === index;
  const cls = wd ? "withdrawn" : index < ci ? "past" : index === ci ? "current" : "";
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

function renderJumpList() {
  const items = currentItems();
  const ci = effectiveIndex(items, currentIndex());
  if (hasGrouping(items)) {
    els.jumpList.innerHTML = groupSchedule(items)
      .map((dayGroup) => {
        const sessions = dayGroup.sessions
          .map((ses) => {
            const lastIndex = ses.firstIndex + ses.count - 1;
            const sesCurrent = ci >= ses.firstIndex && ci <= lastIndex;
            const header = `<div class="session-header${sesCurrent ? " current" : ""}">
              <span class="name">${escapeHtml(ses.name || "Session")}</span>
              ${ses.time ? `<span class="time">${escapeHtml(ses.time)}</span>` : ""}
            </div>`;
            const sections = ses.sections
              .map((sec) => {
                const secCurrent = sec.entries.some(({ index }) => index === ci);
                const sub = sec.name
                  ? `<div class="section-subheader${secCurrent ? " current" : ""}">${escapeHtml(sec.name)}</div>`
                  : "";
                const rows = sec.entries
                  .map(({ item, index }) => jumpRow(item, index, ci, false))
                  .join("");
                return sub + rows;
              })
              .join("");
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
        .map(({ item, index }) => jumpRow(item, index, ci, true))
        .join("");
      const heading = group.day ? `<h2>${escapeHtml(group.day)}</h2>` : "";
      return `<div class="day-group">${heading}${rows}</div>`;
    })
    .join("");
  wireJumpButtons(items);
}

function wireJumpButtons(items) {
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
els.signout.addEventListener("click", () => {
  if (confirm("Sign out of admin on this device?")) {
    localStorage.removeItem(LS_KEYS.token);
    showGate();
  }
});

init();
