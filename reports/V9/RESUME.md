# V9 — точка возобновления (для перезапуска координатора)

Создано 2026-11-18 22:40 (+05). Живой статус — только `hermes kanban list` (карточки V9-T1 → V9-T2 → V9-T3, цепочка через `--parent`). Спеки: `reports/V9/specs/`. План: `reports/V9/PLAN.md`.

## Состояние владельческих гейтов

- «Старт» на фазу V9: ПОЛУЧЕН 2026-11-18.
- «Деплой»: НЕ получен. Деплой на Hostland — только по явной команде «Деплой» от Pavel (AGENTS.md → Phase & deploy control; skill `coordinator-prod-deploy`). Автоматический перезапуск деплой НЕ выполняет, пока здесь не записано «Деплой: ПОЛУЧЕН <дата>».
- Роадмап (xlsx) — только после явного одобрения владельца.

## Что делать при перезапуске (cron 2026-11-19 01:30 +05)

1. `hermes kanban list`, `git log --oneline -8`, `git status --porcelain`.
2. Все V9-карточки `done`, независимая приёмка T3 принята, ничего не висит — ничего не делать, отправить в TG одну строку статуса.
3. Есть карточки `blocked`/упавшие с причиной провайдера (429 rate limit, 402, «gave_up», «exited without kanban_complete»): действовать по skill `coordinator-kanban-execution` (Step 4 «Resuming a blocked task…» и строки «FALSE done after provider outage», «Worker crash loop»): сначала проверить инфраструктуру (`hermes gateway status`, диспетчер), diff дерева против последней точки, RESUME-комментарий к карточке (английский, без reset/stash), `hermes kanban unblock <id> --reason ...`, подтвердить новый `running` и heartbeat через ~2 мин. «done» во время сбоя провайдера не доверять — сверить дифф с критериями.
4. Цепочка: T2 стартует только после проверенной приёмки T1; T3 — после T2. Приёмку каждого звена делать по `coordinator-quality-gate` (дифф + `bash scripts/verify_all.sh` + тесты; отчёт — не доказательство).
5. После приёмки каждой задачи — коммит в main локально; push в `origin/main` — после принятой фазы (приёмка T3 + мой разбор), по правилам AGENTS.md.
6. Статусы — в Telegram: `hermes send --to telegram "..."` (короткие, по-русски).

## Карточки (id)

V9-T1 `t_f1a7ff61` (sd_worker_01) → V9-T2 `t_eb3af290` (sd_worker_02) → V9-T3 `t_ae231c91` (sd_worker_03). Спеки закоммичены `3d6e7df`. Запуск T1: 2026-11-18 ~22:45 (+05). Перезапуск по rate limits: cron «V9 resume check Thu 01:30» (2026-11-19 01:30, Asia/Yekaterinburg).

## ДЕПЛОЙ ВЫПОЛНЕН (2026-11-19, 07:56–07:59 +05)
- Прод = `1616e8d` (V9), schema_version 14. Отчёт: `reports/V9/V9_DEPLOY.md`. Cron-перезапуск `9793dc73bbe0` больше не нужен.
- Ждёт слова владельца: проверка UI связей на проде (Ctrl+F5), «релиз принят» (закрытие этапа, документация), удаление временных файлов.
- Бэклог: P3-1..P3-5 из `T3_ACCEPTANCE.md`, + закрыть `/api/tasks_links.php` по вебу (FilesMatch).
