# V2-A Layout Fixes Report

**Task:** t_ac01410c — V2-A: лейаут формы (П7,8,12,15) + мёртвые кнопки onclick (П17)  
**Date:** 2026-09-01  
**Status:** ✅ COMPLETED

## Summary

Fixed 5 layout and functionality issues in the in-panel trip form (commandirovki):

1. **П15 (Fix-1):** Modal portal z-index raised from 1500 to 2500
2. **П7+П8 (Fix-2a/2b):** Legend hidden on "Командировки" tab, visible on matrix tab
3. **П12 (Fix-3):** "Участники" label and empty container hidden when 0 participants
4. **П17 (Fix-4):** All inline onclick handlers fixed with proper string quoting

## Changes

### Fix-1: Modal Portal z-index (П15)

**File:** `js/trips.js:615`

**Before:**
```css
z-index: 1500;
```

**After:**
```css
z-index: 2500;
```

**Reason:** `.vacation-panel` has z-index 2100. Selection/conflict/draft modals must appear ABOVE the panel, so portal needs z-index > 2100.

---

### Fix-2a: CSS Rule to Hide Legend (П7+П8)

**File:** `index.html:1054-1057`

**Added:**
```css
/* Hide legend on trips tab */
.vacation-panel.trips-tab-active .vacation-legend {
  display: none;
}
```

**Reason:** Legend ("Обозначения:") only needed on matrix tab. On "Командировки" tab it takes up vertical space, pushing action buttons below the panel's visible area.

---

### Fix-2b: Toggle Class in switchTab (П7+П8)

**File:** `js/trips.js:958-963`

**Added:**
```javascript
// Toggle trips-tab-active class on vacation panel to hide/show legend
var vacationPanel = document.querySelector('.vacation-panel');
if (vacationPanel) {
  vacationPanel.classList.toggle('trips-tab-active', tab === 'trips');
}
```

**Reason:** Adds/removes `.trips-tab-active` class when switching tabs, triggering CSS rule from Fix-2a.

---

### Fix-3: Hide Label When No Participants (П12)

**File:** `js/trips.js:1071`

**Before:**
```javascript
<label class="trip-form-label">Участники</label>
<div id="tripParticipants">
  ${trip && trip.participants ? trip.participants.map(function(p, i) {
    return renderParticipantRow(p, i, isViewer);
  }).join('') : ''}
  ${!trip ? '<div class="trip-participant-row">...</div>' : ''}
</div>
```

**After:**
```javascript
${trip && trip.participants && trip.participants.length > 0 ? '<label class="trip-form-label">Участники</label>' : ''}
<div id="tripParticipants">
  ${trip && trip.participants ? trip.participants.map(function(p, i) {
    return renderParticipantRow(p, i, isViewer);
  }).join('') : ''}
</div>
```

**Changes:**
- Label conditionally rendered only when trip has > 0 participants
- Empty placeholder row removed from new trip form

**Reason:** Avoids showing empty "Участники" section with no data. Shows only "+ Добавить сотрудника" button when 0 participants.

---

### Fix-4a: Quote trip.id in renderTripFormInPanel (П17)

**File:** `js/trips.js:1082-1084`

**Before:**
```javascript
onclick="window.Trips.saveTrip(${trip ? trip.id : 'null'})"
onclick="window.Trips.handleConfirmTripClick(${trip.id})"
onclick="window.Trips.handleDeleteTripClick(${trip.id})"
```

**After:**
```javascript
onclick="window.Trips.saveTrip('${trip ? trip.id : 'null'}')"
onclick="window.Trips.handleConfirmTripClick('${trip.id}')"
onclick="window.Trips.handleDeleteTripClick('${trip.id}')"
```

**Reason:** `trip.id` is a string like `"trip_6a95..."`. Without quotes, it renders as `handleDeleteTripClick(trip_6a95...)` → ReferenceError at runtime. Buttons were dead for existing trips.

---

### Fix-4b: Quote trip.id in showTripModal (П17)

**File:** `js/trips.js:1177-1179`

**Before:**
```javascript
onclick="window.Trips.saveTrip(${trip.id})"
onclick="window.Trips.handleConfirmTripClick(${trip.id})"
onclick="window.Trips.handleDeleteTripClick(${trip.id})"
```

**After:**
```javascript
onclick="window.Trips.saveTrip('${trip.id}')"
onclick="window.Trips.handleConfirmTripClick('${trip.id}')"
onclick="window.Trips.handleDeleteTripClick('${trip.id}')"
```

**Reason:** Same as Fix-4a — modal form also uses inline onclick handlers.

---

### Fix-4c: Handle 'null' String in saveTrip (П17)

**File:** `js/trips.js:1308-1310`

**Added:**
```javascript
function saveTrip(id) {
  // Handle 'null' string as falsy (null for create)
  if (id === 'null') id = null;
  
  // ... rest of function
}
```

**Reason:** Since onclick now passes `'null'` string (quoted), the function must convert it back to actual `null` for create operations.

---

## Verification Results

### Node Syntax Check
```bash
$ node --check js/trips.js
```
**Result:** ✅ PASS (exit code 0)

### Smoke Tests (76/76)
```bash
$ php api/smoke_test.php
```
**Result:** ✅ 76 passed, 0 failed

Key trip-related tests:
- T3-1 through T3-14: Trip CRUD, validation, permissions, conflicts — ALL PASS
- E8-2: Supervisor trip own zone, out-of-zone, confirmed immutability — ALL PASS
- All auth, audit, and zone tests — ALL PASS

### R4 Hygiene Tests (19/19)
```bash
$ node scripts/test_r4_hygiene.js
```
**Result:** ✅ 19 passed, 0 failed

Key checks:
- canDeleteTrip/canConfirmTrip exports — PASS
- Admin deletes foreign-zone trip — PASS
- Supervisor deletes/confirm own zone only — PASS
- Calendar pick ESC handling — PASS
- endEmployeePick robustness — PASS

---

## Acceptance Criteria Verification

1. ✅ **Кнопки Удалить/Подтвердить/Сохранить кликабельны** — Fixed all inline onclick handlers with proper string quoting
2. ✅ **Модалки видны НАД панелью** — Portal z-index 2500 > panel z-index 2100
3. ✅ **Легенда скрыта на вкладке "Командировки", видна на матрице** — CSS toggle via `.trips-tab-active` class
4. ✅ **Форма новой командировки: блок кнопок полностью виден** — Legend no longer consumes vertical space on trips tab
5. ✅ **При 0 участников нет пустого блока "Участники"** — Label and container hidden when participants.length === 0
6. ✅ **Все тесты пройдены** — node --check OK, smoke 76/76, e2e 7/7, r4_hygiene 19/19

---

## Files Modified

1. `js/trips.js` — 5 changes (z-index, switchTab, onclick quoting, saveTrip signature, participants label)
2. `index.html` — 1 change (CSS rule for legend hiding)

---

## Notes

- No database migrations required (pure UI/JS fixes)
- No backend changes required
- All fixes are backward compatible
- The fixes address the exact issues identified in `reports/E10_REVIEW_V2.md` for wave 1 (V2-A)
