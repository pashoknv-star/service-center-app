# E10-3 INCDENT RECOVERY — Photos disappeared (2026-09-19)

## Incident
User report: "все фото в карточках исчезли" (19.09). Files in `images/` intact
(user verified). No external logins, no password changes, no manual server access.

## Root cause (proven, audit_log + sync_log)
**Stale-client wipe via full-state autosave**: 2026-09-18 06:43:04 (+03:00),
18 seconds after admin login (06:42:46), a single batch of 44 `employee.update`
rows overwrote employees with OUTDATED values:
- photo_url blanked for 40 employees;
- location blanked for ~43;
- 5 full_names rolled back (emp_7, 10, 11, 14, 45 — e.g. «Сотрудник 26 Вадим
  Константинович» → old «Сотрудник 26»);
- sort_order rolled back for 10 (emp_19, 24, 30, 32, 33, 34, 35, 38, 41, 42);
- emp_42 position_id rolled back to pos_кабельщик.

The payload came from a long-open browser tab holding pre-28.08 state (before
photos/locations were added). Autosave pushed it over live data. No import.run,
no non-admin logins since 2026-09-11. Second incident of the same class
(P16, August).

## Fixes deployed

### 1. Server guard (commit def83fe, deployed 19.09 16:22)
`api/save.php` E10-2:
- ≥3 employees getting BLANK photo_url/location (non-empty in DB) in ONE
  request → suspect rows frozen (server wins), audit `employee.wipe_blocked`;
- ≥3 employees missing from ONE full-state payload → deletions blocked,
  audit `employee.mass_delete_blocked`.
Legit per-click operations (1 blanking / 1 delete per save) unaffected.
Local QA: guard test 7/7, smoke 76/76 (test #76 updated to send realistic
full-state-minus-deleted payload). Deploy: md5 f5aea4a794de6ce5b994922beb5f40d1
byte-identical, DB mtime bookends equal, anon 401/401, front 200.
Backup: ~/backups/save-pre-e102-20260919-1622.php

### 2. Data restore (19.09 16:25)
Source: `pre-e6-20260903.tar.gz` site backup (DB snapshot 03.09 20:19 —
e10/e6 mapping identical). sync_log verified: no intentional employee edits
between 03.09 and the wipe; only legit full-state autosaves + emp_32 photo
upload 04.09 07:47.

Single transaction (backup `~/backups/app-pre-restore-20260919-1625.db` first):
- photo_url: 39 from snapshot + emp_32 = `images/photo_1788497277_850352f0.webp`
  (sole post-snapshot upload, sole unassigned file);
- location: 43 restored (only where live was blank);
- full_name: 5 restored; sort_order: 10 restored (emp_34 caught by final diff);
- position_id: emp_42 restored (pos_старший_специалист_линейных_сооружений).

Verification: photo 0→40, loc 2→43, total 45; final diff vs snapshot =
emp_32 photo only (intentional); every photo_url maps to existing file
(40 referenced / 47 on disk — 7 legacy re-uploads); entries=1458, trips=0
untouched; HTTP 200 on sampled photos, front 200.

## Rollback point
DB: ~/backups/app-pre-restore-20260919-1625.db (pre-restore state)
Code: ~/backups/save-pre-e102-20260919-1622.php (pre-guard save.php)

## Owner follow-ups
- Close all open app tabs on every device (the stale tab may still be alive;
  guard now blocks it server-side anyway).
- SSH password used for deploy — rotate at hoster (recurring reminder).
