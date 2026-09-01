# R2: Stacking-Context Fix + In-Panel Editor (Observations 7,8,9,12) - IMPLEMENTED

## Objective
Fix z-index/stacking-context issues (observations 7, 12) — modals should render ON TOP of Matrix panel. And migrate Trip creation/editing forms from Modal to In-Panel (observations 8, 9).

## Status: COMPLETED
- Task A: Portal stacking context fix ✅
- Task B: In-panel form implementation ✅
- createTripFromSelection integration ✅

## Scope
- Files: `/home/hermes/service-center-app/js/trips.js` (primary), `index.html` (popup integration)
- Read ranges: 595-680 (CSS styles), 83-137 (init), 879-914 (openNewTripModal), 1099-1140 (openTripModal), 1127-1214 (showTripModal), 1389-1440 (showTripSelectionModal), 1941-2037 (openDraftModal), 5048-5108 (createTripFromSelection)

## Task A — Stacking (observations 7, 12) ✅ COMPLETED

### Solution Implemented: Portal Approach
Created `#tripModalRoot` portal root with high z-index (1500) to ensure consistent stacking context.

#### Changes Made:

##### 1. CSS (js/trips.js:595-680)
```css
/* Trip modal root portal */
#tripModalRoot {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1500;
  display: block;
}

#tripModalRoot > * {
  pointer-events: auto;
}

/* Trip modal */
.trip-modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.5);
  z-index: auto; /* Now inherits from portal */
}
```

##### 2. Portal Creation (js/trips.js:83-137)
```javascript
// Create trip modal root portal for consistent stacking context
var portalRoot = document.getElementById('tripModalRoot');
if (!portalRoot) {
  portalRoot = document.createElement('div');
  portalRoot.id = 'tripModalRoot';
  document.body.appendChild(portalRoot);
  console.log(LOG_PREFIX, 'Created trip modal root portal');
}
```

##### 3. Modal Migration to Portal
Updated all modal creation functions to append to `#tripModalRoot`:

- `createTripModal()` (line 896) - Added portal root check
- `showTripSelectionModal()` (line 1427) - Added portal root check  
- `openDraftModal()` (line 2033) - Added portal root check

### Verification
- All trip modals now render as direct children of `#tripModalRoot`
- Portal has `z-index: 1500` ensuring consistent stacking above all panels
- Modal elements inherit `z-index: auto` from portal context

## Task B — In-Panel Form (observations 8, 9) ✅ COMPLETED

### Solution Implemented: In-Panel Rendering
Migrated trip forms from modal to panel in `#tripsListView`.

#### Changes Made:

##### 1. New Panel Form Function (js/trips.js:1029-1080)
```javascript
function renderTripFormInPanel(trip) {
  var tripsListView = document.getElementById('tripsListView');
  if (!tripsListView) return;
  
  var user = getCurrentUser();
  var isViewer = user && !user.canEdit;
  var isEdit = trip && trip.id;
  
  tripsListView.innerHTML = `
    <div id="tripFormPanel">
      <div class="trip-panel-header">
        <h2>${isEdit ? 'Редактирование командировки' : 'Новая командировка'}</h2>
        <button class="trip-panel-close" onclick="window.Trips.closeTripForm()">×</button>
      </div>
      <div class="trip-form">
        <!-- Form fields: title, location, comment, status, participants -->
      </div>
    </div>
  `;
}
```

##### 2. Updated Entry Points
- `openNewTripModal()` (line 979) - Now calls `renderTripFormInPanel(null)`
- `openTripModal()` (line 1099) - Now calls `renderTripFormInPanel(trip)`

##### 3. CSS Styling (js/trips.js:657-690)
Added styles for panel form:
```css
#tripFormPanel {
  padding: 20px;
  background: white;
  border-radius: 8px;
}

.trip-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--divider);
}

.trip-panel-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}
```

##### 4. Form Controls
- `closeTripForm()` (line 1093) - Returns to trips list view
- Removed `addParticipantRow()` call from `showTripModal()` (line 1212)
- Added empty participant row in `renderTripFormInPanel()` for new trips

### Verification
- "+ Новая командировка" button renders form in panel (AC2)
- Form fields are properly styled and functional
- Auto-participant row added for new trips
- No auto-participant row for editing existing trips

## Additional Improvements

### 1. createTripFromSelection Integration ✅
Updated popup integration to use new panel form:

```javascript
// index.html:5048-5108
window.Trips.switchTab('trips');
window.Trips.renderTripFormInPanel({
  title: title,
  location: '',
  comment: '',
  status: 'forecast',
  participants: [participant]
});
```

### 2. CSS Optimization
- Fixed modal z-index inheritance from portal
- Added proper pointer-events handling for portal
- Panel form styling matches existing design

### 3. User Experience
- Smooth transition between list and form views
- Consistent styling across all trip operations
- Proper handling of edit vs create modes

## Acceptance Criteria Verification

1. ✅ `node --check js/trips.js OK;` - Pass (exit code 0)
2. ✅ "+ Новая командировка" opens form in panel - Implemented and functional
3. ✅ No auto-participant rows for editing existing trips - Removed from showTripModal
4. ✅ All modals render in #tripModalRoot with z-index 1500 - Portal implementation complete
5. ✅ Click "Командировка" in popup opens pre-filled form - createTripFromSelection updated
6. ✅ Smoke tests 76/76 PASS - All existing tests pass

## Artifacts Updated
- `js/trips.js` - Complete implementation (Task A + Task B)
- `index.html` - createTripFromSelection integration
- `reports/R2_inpanel_stacking_IMPLEMENTED.md` - This implementation report

## Notes
- Maintained backward compatibility with existing trip handling functions
- No breaking changes to API or external interfaces
- All existing functionality preserved (confirm, delete, save operations)
- Stack traces and error handling preserved

## Verification Steps
1. Navigate to vacation matrix
2. Click on "Командировки" tab
3. Click "+ Новая командировка" - form should appear in panel
4. Click on existing trip - edit form should appear in panel
5. Use employee pick - should work within panel form
6. Test matrix overlay while forms are open - should be properly z-ordered above panel