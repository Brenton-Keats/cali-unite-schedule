# Cali Unite - Live Event Schedule

A real-time schedule display for the Cali Unite event, reached by QR code.
Attendees see what's on now / next; admins move the schedule along and post
announcements from their phones.

- **Frontend**: static pages on GitHub Pages ([index.html](index.html) public
  display, [admin.html](admin.html) control panel)
- **Backend**: Google Apps Script web app ([apps-script/Code.gs](apps-script/Code.gs))
- **Data**: a Google Sheet you edit like any spreadsheet

No servers, no cost.

## How it works

- The **Schedule** sheet tab holds the running order - one row per item, in
  order. Reordering rows reorders the schedule.
- The **State** sheet tab holds a "current position" pointer per theatre plus
  the announcement text. Admin buttons just move the pointer.
- The public page polls every 7 seconds and highlights the current item,
  with Now / Next / Later cards on top.
- If the Schedule sheet has a `theatre` column with more than one value,
  both pages automatically grow theatre tabs, and each theatre gets its own
  independent position pointer. With one (or no) theatre value, no tabs -
  it degrades gracefully.

### Demo mode

While `API_URL` in [config.js](config.js) is empty, both pages run on
built-in sample data so you can preview and theme them locally - just open
`index.html` in a browser. Admin actions in demo mode only affect that tab.

## Setup

### 1. Create the Google Sheet

1. Create a new Google Sheet, name it e.g. `Cali Unite Schedule`.
2. Rename the first tab to exactly `Schedule`.
3. Put headers in row 1. Recommended:

   | theatre | day | session | time | section | competitor_number | title | withdrawn |
   |---------|-----|---------|------|---------|-------------------|-------|-----------|
   | Main stage | Monday | Subbies and Juniors | 9:30 AM | Junior rods | 1 | Ava Addison | |
   | | | | | | 2 | Bea Bravo | |
   | | | | | Subjunior freearm | 3 | Dani Delta | yes |
   | | | Seniors | 11:00 AM | Senior march | 1 | Lucas Reid | |

   Rules:
   - One row per **item** - a competitor, team, award or presentation.
     `title` is the only required column; rows with a blank title are skipped.
   - Put **real dates** in the `day` column (recommended - format the cells
     as dates). They display as "Wednesday 15 Jul", and each day becomes
     its own view with day tabs that automatically open on today. Plain
     text day names ("Monday") still work; the view then follows the live
     session's day instead.
   - Consecutive rows with the same `session` (within a day) form a
     session; `time` is the session's rough start estimate - only the
     session start time needs to be known, filled on its first row.
   - `section` splits a session into parts (e.g. one per event). Sections
     inside a session don't carry times. An item can also sit directly
     under a session with no section (e.g. a welcome or awards row).
   - The current-position pointer moves item by item; the app works out
     which session and section you're in automatically.
   - `competitor_number` shows as a numbered badge before the name.
   - `withdrawn`: put `yes`/`TRUE` (or use a checkbox, or toggle from the
     admin page) to strike a competitor out and skip them.
   - `theatre`, `day`, `session` and `section` "fill down": leave them
     blank on rows after the first of a block and the value is inherited
     from the row above.
   - All columns except `title` are optional; the app adapts automatically
     (a `section`-only sheet or a completely flat sheet both still work).
     Any extra columns are passed through to the frontend too.
   - Row order is the running order. Drag rows to reorder.

4. You do **not** need to create the `State` tab - the script creates and
   manages it automatically.

### 2. Add the Apps Script backend

1. In the Sheet: **Extensions -> Apps Script**.
2. Delete the placeholder code and paste in all of
   [apps-script/Code.gs](apps-script/Code.gs).
3. Set the admin code: **Project Settings (⚙) -> Script Properties -> Add
   script property**: name `ADMIN_TOKEN`, value = the code admins will type
   (pick something easy to type on a phone but not guessable, e.g.
   `unite-2026-tiger`).
4. **Deploy -> New deployment -> type: Web app**:
   - Description: anything
   - Execute as: **Me**
   - Who has access: **Anyone** *(required - this is what lets the public
     page read the schedule without a Google login. Writes are still
     protected by the admin code.)*
5. Authorise when prompted, then copy the **Web app URL**
   (`https://script.google.com/macros/s/…/exec`).

### 3. Configure and deploy the frontend

1. In [config.js](config.js), paste the Web app URL into `API_URL`.
2. Create a GitHub repo, push these files, then in the repo settings:
   **Pages -> Source: main branch / root**.
3. Your pages will be at:
   - Public: `https://<username>.github.io/<repo>/`
   - Admin: `https://<username>.github.io/<repo>/admin.html`

### 4. QR code & admin devices

- Generate a QR code for the **public** URL (any free generator). Don't
  change the URL during the event.
- On each admin device, open `admin.html` once and enter the admin code.
  It's remembered on that device (localStorage) until they sign out or
  clear browser data - no re-login during the week.
- Share the admin URL privately. Anyone can *open* the page, but nothing
  works without the code.

## Operating during the event

- The hero cards are bound to one **active session** per theatre. Start a
  session explicitly from the **Active session** dropdown, or the **Start
  next session** button that appears once a session finishes - both ask
  for confirmation, so a session can never begin by accident.
- **Next ->** moves the current theatre's schedule forward; **← Back** undoes.
  Both automatically skip withdrawn competitors. Next only works inside
  the active session: after the last competitor it shows **Session
  finished** everywhere and disables until the next session is started.
- As a session nears its end, the public Side stage / Up next cards make
  way for a single "Next session" name card.
- Tap an item under **Jump to item** to skip straight to it (e.g. after
  reordering).
- Tap **WD** next to an item to withdraw a competitor (or **Reinstate** to
  undo). Withdrawn competitors stay visible in the schedule with a
  "Withdrawn" tag but are never presented as current: withdrawing the
  on-stage competitor rolls the display forward to the next one
  immediately, and reinstating them makes them current again. Jumping to
  a withdrawn item is blocked until it's reinstated.
- On the public page each section collapses individually: completed and
  future sections show just their heading with a "Show N" pill beside the
  title. The current section is always expanded, with its completed items
  behind a "Show N done" pill. Items directly under a session (no
  section) get their pill on the session heading.
- The **Announcement banner** shows on every attendee's screen for all
  theatres until cleared.
- Schedule content changes (renames, new rows, reordering) are made directly
  in the Google Sheet and appear on phones within ~7 seconds. Note: the
  pointer is an index, so if you insert/remove rows *before* the current
  item, use **Jump to item** afterwards to re-point it.

## Changing the shape of the data later

Designed-in flexibility:

- **Add a `theatre` column** (e.g. two theatres): tabs appear automatically,
  each with its own pointer. Remove it to go back to one schedule.
- **Add/remove any other column**: the backend passes all columns through.
  `day`, `time`, `subtitle` get special display treatment; anything else is
  available in the data for future UI work.
- **Rename a theatre**: it's treated as a new theatre (fresh pointer), so do
  it between sessions, or Jump to the right item after.

## Updating the backend script

After editing the Apps Script code (or pasting in a newer
[Code.gs](apps-script/Code.gs)), a plain save is not enough - you must ship
a new version: **Deploy -> Manage deployments -> ✏️ (edit) -> Version: New
version -> Deploy**. The URL stays the same, so nothing else changes.

## Changing the token

Update `ADMIN_TOKEN` in Script Properties. All admin devices will be
bounced back to the code screen on their next action and just enter the
new code.
