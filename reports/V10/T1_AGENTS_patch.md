# V10-T1 — патч для AGENTS.md (применяет координатор)

1. В «Verification» → абзац про эталон `BASELINE`: добавить `transportdb 112` (V10-T1).
2. В таблицу сьютов добавить строку:

| transportdb (V10-T1) | `bash scripts/verify_all.sh transportdb` (= `php api/transport_db_test.php`; временная копия БД через `SC_APP_DB`, `php -S` на ней, `data/app.db` не трогается) | `RESULTS: 112 passed, 0 failed`, `DB intact: YES`; схема v15 «Транспорт» (9 таблиц, индексы, CHECK шага 15), миграция v14→v15 на копии (повтор — no-op), журнал `transport_journal` append-only (UPDATE/DELETE → ABORT, `audit_cleanup` не трогает), `api/transport_lib.php`, `api/transport_vehicles.php` (базы, ТС, пул водителей, перенос ТС admin/viewer), права admin / supervisor_zone0 / supervisor_zone1 / viewer_test / аноним |

3. «Решения владельца»: перенос ТС между базами доступен admin и viewer (исключение из «viewer только читает»); правка заявок — автор и admin, `supervisor_zone0` — ещё и заявки `supervisor_zone1` (`TRANSPORT_EDIT_DELEGATION`).
