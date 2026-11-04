# PROGRESS — service-center-app

Короткий файл состояния. Читать **первым** в начале сессии (clock-in), обновлять в конце (clock-out).
Где что лежит (у каждого факта один источник):
- живые статусы задач — Hermes Kanban (`hermes kanban list`);
- выполнение этапов — Роадмап `staff_project/Roadmap доработок (обновлён).xlsx`, только после одобрения владельца;
- контекст и подводные камни — `reports/HANDOFF.md`;
- отложенные работы — `reports/BACKLOG.md`.

## Current State

- Last commit: `c0ce47c` (main = origin/main), 2026-10-27, «HOTFIX-H0: deploy report».
- Прод: HOTFIX-H0 выложен (коммит `4cf6f27`), анонимная матрица OK — `reports/HOTFIX_H0/DEPLOY_REPORT.md`.
- Gate: `bash scripts/verify_all.sh` → `GATE: PASS (8 suites)` на `1eb6810`, 2026-11-04 (smoke 84, e51 23, e52 41, hygiene 19, trips 7, syntax, phplint 29 файлов, pii, clean).
- Test status на `c0ce47c` (прогон 2026-11-02, Hermes):

| Сьют | Команда | Результат |
|---|---|---|
| Backend smoke | `php api/smoke_test.php` | PASS 84/84, DB intact |
| e51 | `node scripts/test_e51_pick_geometry.js` | PASS 23/23 |
| e52 | `node scripts/test_e52_pick_semantics.js` | PASS 41/41 |
| hygiene | `node scripts/test_r4_hygiene.js` | PASS 19/19 |
| trips frontend | `bash scripts/test_trips_frontend.sh` | PASS (ALL TESTS PASSED) |
| Синтаксис inline-JS | `node scripts/check_syntax.js` | OK, failed 0 |
| ПДн | `bash scripts/check_no_pii.sh` | OK |
| E2E | `/tmp/e5_final.js`, `/tmp/e6_final.js` | **НЕ ЗАПУСКАЛСЯ: файлов нет на хосте** |

## In Progress

- Активных задач нет: `hermes kanban list` → no matching tasks (2026-11-02).
- В рабочем дереве есть незакоммиченные правки `reports/BACKLOG.md` и `reports/backlog/` (BL-01, BL-02: карточки Kanban сняты, вместо них файлы). Автор и судьба не зафиксированы — уточнить у владельца.

## Next Steps

1. Фаза H1 (P1) — `reports/AUDIT_2026-10/AUDIT_REPORT.md` §9; заводится в Kanban по команде «Старт».
2. Вернуть E2E-харнесс в репозиторий (`scripts/`): он жил в `/tmp` и потерян.
3. `scripts/test_trips_frontend.sh` при ручном запуске оставляет в корне `test_cookies.jar` (`verify_all.sh` удаляет его сам).

## Blockers / ждёт владельца

- Проверка прода под логином: вход, сохранение, reveal токена, фото (`DEPLOY_REPORT.md`, «Не проверено»).
- Смена токена робота HelpMe и SSH-пароля Hostland (`DEPLOY_REPORT.md`, строка 32) — статус неизвестен.
- Удаление бандлов с ПДн в `~/backups/` (`HANDOFF.md` §6).
