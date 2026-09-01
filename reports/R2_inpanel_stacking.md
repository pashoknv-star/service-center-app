# R2: Stacking-Context Fix + In-Panel Editor (Observations 7,8,9,12)

## Objective
Fix z-index/stacking-context issues (observations 7, 12) — modals should render ON TOP of Matrix panel. And migrate Trip creation/editing forms from Modal to In-Panel (observations 8, 9).

## Scope
- Files: `/home/hermes/service-center-app/js/trips.js` (primary), `index.html` (only micro-injects by coordinate).
- Read only ranges: 595-730 (CSS injectStyles), 821-838 (createTripModal), 915-1030 (openNewTripModal/showTripModal), 1287-1326 (selection modal), 1769-1829 (openDraftModal).

## Task A — Stacking (observations 7, 12)

### Current State
- `.trip-modal { z-index: 1000; position: fixed }`
- `.trip-panel-slided { transform: translateX(...) }` (index.html:1801) creates its own stacking-context.
- Opening a modal from within a panel that is in `slided` state moves the modal UNDER the panel.

### Root Cause (E9_RELEASE_REVIEW.md lines 78-81)
- Panel has `position: relative` + `transform: none` by default.
- `.trip-panel-slided` adds `transform: translateX(-100% + 46px)`.
- When `startEmployeePick` triggers from INSIDE a modal editor, panel slides, and ANY open modal (with `position:fixed` + `z-index: 1000` in body context) ends up UNDER the panel because `fixed` elements render in the nearest positioned ancestor (the sliding panel).

### Solution (choose one, report should state choice)
- **(a) Portal approach (CHOSEN)**: Create a single portal root `#tripModalRoot` on `body` with high z-index (1500+) and render ALL trip modals as direct children. This guarantees consistent stacking context.
- **(b) Remove transform**: Replace `transform: translateX(...)` on `.trip-panel-slided` with `left` animation (no stacking-context creation).
- **(c) Manual z-index boost**: Move modal inside panel and manually boost z-index, but this is fragile and breaks layout.

### Required Changes (portal approach)

#### 1. CSS (js/trips.js:595-730)
```css
.trip-modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.5);
  z-index: auto;  /* was: 1000 */
}

/* Portal root for all trip modals - ensures consistent z-index above all other elements */
#tripModalRoot {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 1500;
  pointer-events: none;
}

/* Modals must be children of the portal root for correct stacking */
#tripModalRoot > * {
  pointer-events: auto;
}
```

#### 2. Modal Creation (js/trips.js:821-838)
```javascript
function createTripModal() {
  if (_dom.tripModal) return _dom.tripModal;

  var modal = document.createElement('div');
  modal.className = 'trip-modal';
  modal.id = 'tripModalRoot';  // NEW: portal root
  modal.innerHTML = `
    <div class="trip-modal-content">
      <div class="trip-modal-header">
        <h2 class="trip-modal-title">Командировка</h2>
        <button class="trip-close" onclick="window.Trips.closeTripModal()">×</button>
      </div>
      <div class="trip-form" id="tripForm"></div>
    </div>
  `;
  document.body.appendChild(modal);
  _dom.tripModal = modal;
  return modal;
}
```

#### 3. Draft Modal (js/trips.js:1838-1898)
- Currently uses `document.body.insertAdjacentHTML('beforeend', modalHtml)` which appends to body OUTSIDE the portal root.
- Change to `document.body.appendChild(modalHtml)` so modal becomes a direct child of `#tripModalRoot`.
- Ensure `.trip-modal-overlay` is REMOVED (not needed with portal approach).

### Acceptance Criteria (Task A)
- Opening ANY trip modal (new, edit, draft, selection) renders VISIBLY ABOVE the Matrix panel.
- Modal overlay appears (backdrop) for all modals (not just draft).
- Modal z-index is consistent and higher than all other UI elements (header, footer, employee picker dock).

---

## Task B — In-Panel Editor (observations 8, 9)

### Current State
- **Observation 8**: «+ Новая командировка» opens modal instead of in-panel form. It re-renders `#tripsListView` in grid mode (fields: Название, Место, Комментарий, Статус, Участники) with Save/Cancel buttons BELOW. The «+ Новая командировка» button disappears/morphs into «Отмена» during editing.

### Root Cause
- Button is hooked to `openNewTripModal()` which creates a modal (outside the panel) instead of showing in-panel form.
- No in-panel editor is wired to the button.
- Modal visibility re-renders the list view in grid mode, hiding panel content.

### Required Changes (Task B-1: Fix «+ Новая командировка»)

#### 1. Create In-Panel Trip Editor Form
In `index.html` (only by coordinate, not rewrite):
- At the coordinate of `#tripsListView` (specify page-line-block where the form should appear), add:
  - Header: «Новая командировка».
  - Fields: Название, Место, Комментарий, Статус, Участники (same structure as current in-dock form).
  - Actions: Сохранить, Отмена (inline).
  - State: Hidden by default (off-canvas or collapsed).

#### 2. Wire Button to In-Panel Editor
In `js/trips.js:915-918` (`openNewTripModal`):
- Instead of calling `createTripModal(); showTripModal(null);`, replace with:
  - `showNewTripInPanel();` (new function, see below).
- Ensure `#tripsListView` is NOT re-rendered during editing (it stays visible/expanded).

#### 3. Implement `showNewTripInPanel()`
```javascript
function showNewTripInPanel() {
  var form = document.getElementById('inPanelTripForm');
  if (!form) {
    // Initialize in-panel form if not exists
    form = createInPanelTripForm();
  }
  form.style.display = 'block';
  form.style.visibility = 'visible';
  
  // Focus first field
  setTimeout(function() {
    var firstInput = form.querySelector('input');
    if (firstInput) firstInput.focus();
  }, 100);
}
```

#### 4. Handle «Отмена» / «Сохранить»
- «Отмена»:
  - Hides in-panel form: `form.style.display = 'none'`.
  - Restores «+ Новая командировка» button visibility.
- «Сохранить»:
  - Collects values from form.
  - Validates required fields (Название обязательно).
  - Calls `createTrip(data)` API.
  - On success: close form, refresh trips list (`renderTripsList()`), show success toast.

### Acceptance Criteria (Task B-1)
- «+ Новая командировка» button toggles in-panel form (show/hide), not a modal.
- In-panel form does NOT re-render `#tripsListView` in grid mode; panel content remains visible.
- Form fields: Название, Место, Комментарий, Статус, Участники (identical structure to dock form).
- «+ Новая командировка» button is visible while editing; disappears/morphs only after Save/Cancel.

---

### Observation 9: Remove Empty Participant Row

### Current State
- `showTripModal(null)` (new trip) calls `addParticipantRow()` after form HTML is injected (line 1028 in current code).
- This adds a completely empty row with no name/date.

### Root Cause
- Unnecessary row; users must explicitly click «+ Добавить сотрудника» to add participants.

### Required Changes (Task B-3)
- Remove `addParticipantRow()` call from `showTripModal(null)` (around line 1028).

### Acceptance Criteria (Task B-3)
- No empty participant row appears on new trip creation.
- Participants added only via «+ Добавить сотрудника» button.

---

### Observation 9 (duplicate): Delete Button for Trip and Participants

### Current State
- Edit trip modal has «Удалить» button (DELETE trip).
- Participant rows have «×» to remove row (via Exported Function from R1).

### Root Cause
- «Удалить» button in edit modal calls `handleDeleteTripClick(id)` (correct).
- Participant delete button calls `removeParticipantRow(index)` (correct).
- No explicit «Удалить» button INSIDE in-panel form for trip or participants.

### Required Changes (Task B-4)
- Add «Удалить» button in in-panel form for trip:
  - Location: below «Сохранить», before «Отмена».
  - Style: danger button (like edit modal).
  - Handler: `handleDeleteTripClick(id)` (same as modal).
- Add «Удалить» button inside each participant row in in-panel form:
  - Location: next to participant name field (or at right edge of row).
  - Style: danger (× icon).
  - Handler: `removeParticipantRow(index)` (same as modal).

### Acceptance Criteria (Task B-4)
- In-panel form has «Удалить» button for the trip (triggers trip deletion via `handleDeleteTripClick`).
- In-panel participant rows have «Удалить» button for each participant (triggers `removeParticipantRow`).
- Delete handlers work identically to modal (R1 Exported Functions).

---

## Summary of Required Changes

| ID | Change | File | Lines | Type |
|----|--------|------|-------|------|
| A-1 | CSS: z-index: auto + #tripModalRoot portal | js/trips.js | 595-620 | CSS |
| A-2 | Modal: add id='tripModalRoot' | js/trips.js | 821-838 | JS |
| A-3 | Draft Modal: use appendChild (not insertAdjacentHTML) | js/trips.js | 1838-1898 | JS |
| B-1 | Create in-panel form + wire «+ Новая командировка» | index.html + js/trips.js | N/A | UI |
| B-3 | Remove empty participant row | js/trips.js | ~1028 | JS |
| B-4 | Add «Удалить» buttons in in-panel form | js/trips.js | in-panel form | JS |

---

## Tests to Run (per acceptance criteria)
- **Task A**:
  - Smoke tests (76/76).
  - E2E: open modal from within panel slide (select employee → employee pick dock → open modal).
  - Screenshots: modal always on top of panel.
- **Task B-1**:
  - E2E: click «+ Новая командировка», verify in-panel form shows (not modal).
  - E2E: verify panel content remains visible (not grid mode).
  - Screenshots: «+ Новая командировка» toggles form.
- **Task B-3**:
  - E2E: create new trip, verify no empty row.
  - Screenshots: participant list empty initially.
- **Task B-4**:
  - E2E: click «Удалить» in in-panel form, verify trip deleted.
  - E2E: click × on participant, verify row removed.
  - Screenshots: delete buttons work identically to modal.

---

## Blocking Items
- R1 Exported Functions must be in place (removeParticipantRow, handleConfirmTripClick, handleDeleteTripClick).

---

## Notes
- R2 depends on R1 for Exported Functions; R1 must be taken first.
- If R1 not yet taken, can work in parallel but integration tests only pass after R1.
