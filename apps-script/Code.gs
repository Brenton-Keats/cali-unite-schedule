/**
 * Cali Unite - schedule backend (Google Apps Script).
 *
 * Bound to a Google Sheet with two tabs:
 *
 *   Schedule - header row defines the fields. Any columns work; these have
 *              special meaning (all optional except title):
 *                theatre  - groups items into independent schedules/tabs
 *                day      - groups items under day headings
 *                session  - groups consecutive rows into a timed session
 *                           (e.g. "Morning session")
 *                time     - the session's rough start time (fill it on
 *                           the session's first row)
 *                section  - subgroup within a session (e.g. "Junior rods")
 *                competitor_number - shown as a numbered badge before
 *                           the title
 *                withdrawn - yes/TRUE (or toggle from the admin page) to
 *                           strike the competitor out and skip them
 *                title    - the item: competitor, team, award, etc.
 *                           (required; blank rows are skipped)
 *              theatre/day/session/section may be left blank after the
 *              first row of a block; values fill down automatically.
 *              Extra columns are passed through to the frontend untouched.
 *              Row order IS the running order - just drag rows to reorder.
 *
 *   State    - key/value pairs managed by this script (created
 *              automatically if missing). Don't edit by hand during the
 *              event unless something is stuck.
 *
 * Setup: Project Settings -> Script Properties -> add ADMIN_TOKEN with the
 * admin code, then deploy as Web App (Execute as: Me / Access: Anyone).
 */

var SHEET_SCHEDULE = 'Schedule';
var SHEET_STATE = 'State';
var DEFAULT_THEATRE = 'main';

var STATE_CACHE_KEY = 'stateJson';
var STATE_CACHE_TTL_SECONDS = 10;

// Reads are served from CacheService when possible: cheaper than
// re-reading the spreadsheet on every poll, and safe because any admin
// write below refreshes the cache immediately.
function doGet() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(STATE_CACHE_KEY);
  if (cached) return rawJsonResponse(cached);
  var json = JSON.stringify(buildState());
  cache.put(STATE_CACHE_KEY, json, STATE_CACHE_TTL_SECONDS);
  return rawJsonResponse(json);
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
    if (!token) return jsonResponse({ error: 'ADMIN_TOKEN is not configured in Script Properties' });
    if (String(body.token || '') !== token) return jsonResponse({ error: 'unauthorized' });

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      handleAction(body);
    } finally {
      lock.releaseLock();
    }
    var json = JSON.stringify(buildState());
    CacheService.getScriptCache().put(STATE_CACHE_KEY, json, STATE_CACHE_TTL_SECONDS);
    return rawJsonResponse(json);
  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}

function handleAction(body) {
  var action = String(body.action || '');
  if (action === 'verify') {
    return; // Token already checked; used by the admin page to test a code.
  }
  if (action === 'setAnnouncement') {
    setStateValue('announcement', String(body.text || ''));
  } else if (action === 'setWithdrawn') {
    setWithdrawnFlag(body);
  } else if (action === 'advance' || action === 'previous' || action === 'setIndex') {
    var theatre = String(body.theatre || DEFAULT_THEATRE);
    var items = itemsForTheatre(readSchedule(), theatre);
    var count = items.length;
    var idx = getCurrentIndex(theatre);
    // Next/Back step over withdrawn competitors.
    if (action === 'advance') {
      // If the pointer sits on a withdrawn item the display already shows
      // the next present one - normalise first so Next steps from there.
      while (idx >= 0 && idx < count && isWithdrawnItem(items[idx])) idx += 1;
      idx += 1;
      while (idx < count && isWithdrawnItem(items[idx])) idx += 1;
    } else if (action === 'previous') {
      idx -= 1;
      while (idx > -1 && isWithdrawnItem(items[idx])) idx -= 1;
    } else {
      idx = parseInt(body.index, 10);
    }
    setStateValue('currentIndex::' + theatre, clampIndex(idx, count));
  } else {
    throw new Error('Unknown action: ' + action);
  }
  setStateValue('lastUpdated', new Date().toISOString());
}

// -- State assembly -----------------------------------------------------

function buildState() {
  var schedule = readSchedule();
  var stateMap = readStateMap();

  var theatreIds = [];
  schedule.forEach(function (item) {
    var id = item.theatre || DEFAULT_THEATRE;
    if (theatreIds.indexOf(id) === -1) theatreIds.push(id);
  });
  if (!theatreIds.length) theatreIds.push(DEFAULT_THEATRE);

  var theatres = theatreIds.map(function (id) {
    var raw = parseInt(stateMap['currentIndex::' + id], 10);
    var count = itemsForTheatre(schedule, id).length;
    return { id: id, currentIndex: clampIndex(raw, count) };
  });

  return {
    schedule: schedule,
    theatres: theatres,
    announcement: stateMap['announcement'] || '',
    lastUpdated: stateMap['lastUpdated'] || '',
    serverTime: new Date().toISOString(),
  };
}

function itemsForTheatre(schedule, theatreId) {
  return schedule.filter(function (item) {
    return (item.theatre || DEFAULT_THEATRE) === theatreId;
  });
}

function getCurrentIndex(theatre) {
  var raw = parseInt(readStateMap()['currentIndex::' + theatre], 10);
  return isNaN(raw) ? -1 : raw;
}

function clampIndex(idx, count) {
  if (isNaN(idx)) return -1;
  return Math.max(-1, Math.min(idx, count));
}

// -- Schedule sheet (dynamic columns) -----------------------------------

function readSchedule() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_SCHEDULE);
  if (!sheet) throw new Error('Missing sheet tab: ' + SHEET_SCHEDULE);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var tz = Session.getScriptTimeZone();
  var items = [];
  var prev = null;

  for (var r = 1; r < values.length; r++) {
    var item = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      item[headers[c]] = formatCell(values[r][c], headers[c], tz);
    }
    if (String(item.title || '').trim() === '') continue; // skip blank rows
    item.theatre = String(item.theatre || '').trim();
    // Fill-down (must mirror the frontend so theatre filtering and index
    // maths agree with what attendees see): blank theatre/day/session/
    // section cells inherit from the previous kept row.
    if (prev) {
      if ('theatre' in item && item.theatre === '') item.theatre = prev.theatre;
      var sameTheatre = item.theatre === String(prev.theatre || '');
      if (sameTheatre && 'day' in item && String(item.day || '').trim() === '') {
        item.day = prev.day;
      }
      var sameDay = String(item.day || '').trim() === String(prev.day || '').trim();
      if (sameTheatre && sameDay && 'session' in item && String(item.session || '').trim() === '') {
        item.session = prev.session;
      }
      var sameSession = String(item.session || '').trim() === String(prev.session || '').trim();
      if (sameTheatre && sameDay && sameSession && 'section' in item && String(item.section || '').trim() === '') {
        item.section = prev.section;
      }
    }
    item._row = r + 1; // 1-based sheet row, used by setWithdrawnFlag
    items.push(item);
    prev = item;
  }
  return items;
}

function isWithdrawnItem(item) {
  return /^(true|yes|y|1|x|wd|withdrawn)$/i.test(String(item.withdrawn || '').trim());
}

// Writes the withdrawn flag back into the Schedule sheet so it survives
// reordering and is visible to organisers editing the sheet directly.
function setWithdrawnFlag(body) {
  var theatre = String(body.theatre || DEFAULT_THEATRE);
  var items = itemsForTheatre(readSchedule(), theatre);
  var item = items[parseInt(body.index, 10)];
  if (!item) throw new Error('No schedule item at index ' + body.index);
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_SCHEDULE);
  var headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (h) {
      return String(h).trim().toLowerCase();
    });
  var col = headers.indexOf('withdrawn');
  if (col === -1) {
    throw new Error('Add a "withdrawn" column to the Schedule sheet first');
  }
  // Booleans render as TRUE/FALSE in text cells and drive checkboxes too.
  sheet.getRange(item._row, col + 1).setValue(body.withdrawn ? true : false);
}

// Sheets returns Date objects for time/date-formatted cells; normalise
// them to friendly strings so the frontend can render values as-is.
// Time-only cells come back as dates on the 1899-12-30 Sheets epoch, so
// any pre-1930 date is treated as a bare time no matter the column name.
function formatCell(value, header, tz) {
  if (value instanceof Date) {
    if (header === 'time' || value.getFullYear() < 1930) {
      return Utilities.formatDate(value, tz, 'h:mm a');
    }
    if (header === 'day') return Utilities.formatDate(value, tz, 'EEEE d MMM');
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd HH:mm');
  }
  return String(value).trim();
}

// -- State sheet (key/value) --------------------------------------------

function getStateSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_STATE);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_STATE);
    sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
  }
  return sheet;
}

function readStateMap() {
  var values = getStateSheet().getDataRange().getValues();
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var key = String(values[r][0]).trim();
    if (key) map[key] = String(values[r][1]);
  }
  return map;
}

function setStateValue(key, value) {
  var sheet = getStateSheet();
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]).trim() === key) {
      sheet.getRange(r + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

// -- Response helper ----------------------------------------------------

function jsonResponse(obj) {
  return rawJsonResponse(JSON.stringify(obj));
}

function rawJsonResponse(json) {
  return ContentService.createTextOutput(json).setMimeType(
    ContentService.MimeType.JSON
  );
}
