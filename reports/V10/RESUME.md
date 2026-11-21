# V10 — точка возобновления (Транспорт)

Статус: фаза V10-A запущена по «Старт» владельца 2026-11-21. «Деплой» НЕ получен — перезапуск никогда не деплоит. Фазы B–D — только по новому «Старт». Владелец (2026-11-21): при rate limit возобновить работу в 05:00 (+05). Правило для supervisor_zone0 (правит свои заявки и заявки supervisor_zone1) подтверждено владельцем 2026-11-21.

## Карточки и worktree

| Задача | Kanban | Воркер | Worktree / ветка |
|---|---|---|---|
| V10-T1 схема v15, ТС, базы, пул, перенос, журнал | t_6dec04ad | sd_worker_01 | /home/hermes/wt/v10-t1 · v10-t1-schema |
| V10-T2 сьют transport | t_b5a12b80 | sd_worker_02 | /home/hermes/wt/v10-t2 · v10-t2-tests |
| V10-T3 ADR_DB | t_0a20de21 | sd_worker_03 | /home/hermes/wt/v10-t3 · v10-t3-adr |
| V10-T4 SPIKE_MAP | t_b43cd4e8 | sd_worker_04 | /home/hermes/wt/v10-t4 · v10-t4-map |

Спеки: `reports/V10/specs/` (00_COMMON, CONTRACT, T1..T4). Main при старте: 30af063.

## Состояние на 2026-11-21 (фаза A принята, фаза B запущена)

Фаза A принята: T1–T4 + T1b влиты, полный гейт на main PASS (23 сьюта, 89e3171), main запушен. «Старт» на фазу B получен владельцем (условие: после T1b, гейта, push). Деплой НЕ запрошен.

Фаза B (спеки `reports/V10/specs/T5..T8_*.md`, worktree от 89e3171):

| Задача | Kanban | Воркер | Worktree / ветка |
|---|---|---|---|
| V10-T5 API заявок/назначений/предупреждений | t_a8604210 | sd_worker_03 | /home/hermes/wt/v10-t5 · v10-t5-api |
| V10-T6 API доски + журнал (чтение) | t_9ee15e9a | sd_worker_01 | /home/hermes/wt/v10-t6 · v10-t6-board |
| V10-T7 геопрокси + Leaflet | t_6cef1438 | sd_worker_04 | /home/hermes/wt/v10-t7 · v10-t7-geo |
| V10-T8 вкладка/доска UI (после T6, parent) | t_c626702a | sd_worker_02 | /home/hermes/wt/v10-t8 · v10-t8-ui |

Приёмка T5: сьют `transport` зелёный (157) БЕЗ правки api/transport_test.php; координатор переносит `transport` из OPT_SUITES в ALL_SUITES. T8 стартует после принятия T6 (при слиянии T6 — обновить ветку v10-t8-ui: `git -C /home/hermes/wt/v10-t8 merge main`). После приёмки всех четырёх — полный гейт на main, push, ПОЛНАЯ ОСТАНОВКА до «Старт» на фазу C. Открыто для владельца до деплоя: реальный e-mail для User-Agent геопрокси (заглушка OWNER_EMAIL_TO_BE_SET), проверка исходящего HTTP на Hostland (SPIKE_MAP §7).

## Шаги при перезапуске

1. `hermes kanban list | grep V10`, `git -C ~/service-center-app log --oneline -5`, `git worktree list`, для каждого worktree `git -C <wt> status -sb` и `git -C <wt> log --oneline main..HEAD`.
2. Задача здорова (`running` с новыми heartbeat) или уже `done`/`review` — ничего не перезапускать; `done`/`review` принимать по пункту 5.
3. Задача `blocked`/упала по провайдеру (429/402/400, `gave_up`, в конце `hermes kanban log <id>` — ошибка провайдера): сначала инфраструктура (`hermes gateway status`, dispatcher). Затем сверить worktree с недоделанным (`git diff --stat`, без checkout/reset/stash), оставить комментарий на английском: `RESUME: continue from partial work; NO checkout/reset/stash; start by reading git diff; finish remaining AC + gate + report + commit; on provider failure block, never complete.` и `hermes kanban unblock <id> --reason "scheduled resume 05:00"`. Через ~2 мин убедиться, что есть новый `running` run и свежие heartbeat; не докладывать «возобновлено» только по статусу.
4. Не дублировать карточки; не создавать задачи фаз B–D.
5. Приёмка завершённой задачи — только по `git diff` ветки, `bash scripts/verify_all.sh` в её worktree (`GATE: PASS`, таблица целиком) и отчёту. Проверить, что артефакты существуют: T1 — `reports/V10/T1_REPORT.md`, `T1_RED_run_before_fix.txt`; T2 — `T2_REPORT.md`, `T2_RED_run_before_impl.txt`; T3 — `ADR_DB.md`; T4 — `SPIKE_MAP.md`. Ложный `done` после сбоя провайдера (в диффе одни планы) не принимать — доделывающая задача тому же воркеру. Принятые ветки сливать в main `--no-ff` сразу после приёмки (конфликты `BASELINE`/`ALL_SUITES` — механически, сохраняя все сьюты); после слияния T1 прогнать сьют `transport` T2 против реального API T1 и записать расхождения контракта.
6. Когда все четыре приняты: полный гейт на main, `git status --porcelain` чист, `git worktree remove` и удалить ветки, push main (правило проекта: push после принятой фазы), статус владельцу, ПОЛНАЯ ОСТАНОВКА до «Старт».
7. Статус владельцу — одной строкой в Telegram (`timeout 30 hermes send --to telegram "..."`, отдельным вызовом).

## Запрещено

Деплой; push до приёмки фазы; правка воркерами `AGENTS.md`; правка `staff_project/Roadmap доработок (обновлён).xlsx` без одобрения владельца; запись в `data/app.db`; вопросы владельцу в автономном запуске (вместо вопроса — комментарий в карточке и пометка в отчёте).
