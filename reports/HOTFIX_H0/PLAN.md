# HOTFIX-H0 — План работ (2 воркера)

Статус: **подготовлен, не запущен.** Запуск — только по команде владельца **«Старт»**. Деплой — только по **«Деплой»**.
Основание: аудит `reports/AUDIT_2026-10/AUDIT_REPORT.md` §9, фаза H0, с поправками владельца от 2026-10-26.
Живое состояние задач — Hermes Kanban: этот файл описывает план, а не статусы.

## Состав хотфикса (после решений владельца 2026-10-26)

| S-ID | P | Что | Задача |
|---|---|---|---|
| S-01 | P0 | Убрать вшитые ПДн сотрудников из `index.html` (пререндер, `defaultData`, `DEFAULT_VACATION_DATA`) + guard-скрипт `scripts/check_no_pii.sh` | HF-1 |
| S-06 | P1 | Прод-пакет по allowlist, удаление служебных файлов с прода, матрица проверок после деплоя (документация) | HF-1 |
| S-06 | P1 | Guard `PHP_SAPI` в служебных скриптах, удаление `debug_token.php`, `api/.htaccess` deny (код) | HF-2 |
| S-05 | P1 | `api/holidays.php` — аутентификация (GET auth, запись admin) | HF-2 |
| S-19 | P2 | `display_errors=0`, `X-Powered-By` убрать (helpers.php) | HF-2 |
| S-07 (часть) | P1 | `trip_relay.php?action=reveal` → только admin + аудит; ротация токенов после деплоя | HF-2 + владелец |

**Исключено решением владельца:** S-12 — починка формы командировки. Сущность «Командировки» пока не применяется в бизнесе, поэтому задача перенесена в бэклог **BL-01** (Kanban `t_41d21049`, `reports/BACKLOG.md`).
**Уже выполнено координатором 2026-10-26:** перезапись истории git на GitHub (S-01, часть «git-история»). Подробности — `reports/GIT_REWRITE_2026-10-26.md`.

## Распределение и Kanban

| Задача | Kanban | Исполнитель | Workspace | Ветка | Спека | Старт |
|---|---|---|---|---|---|---|
| HF-1 | `t_bbb5f5e9` | sd_worker_03 | `dir:/home/hermes/hf-wt/hf1` | `hotfix/hf1-pii-deploy` | `specs/HF-1.md` | ⊘ blocked → unblock по «Старт» |
| HF-2 | `t_32a957ab` | sd_worker_02 | `dir:/home/hermes/hf-wt/hf2` | `hotfix/hf2-backend` | `specs/HF-2.md` | ⊘ blocked → unblock по «Старт» |
| HF-R1 | `t_0551a205` | sd_worker_02 | `dir:/home/hermes/service-center-app` | — (ревью hf1) | `specs/HF-R.md` | todo, ждёт HF-1 |
| HF-R2 | `t_72194ca1` | sd_worker_03 | `dir:/home/hermes/service-center-app` | — (ревью hf2) | `specs/HF-R.md` | todo, ждёт HF-2 |
| HF-INT | `t_66f3a7ba` | координатор | `dir:/home/hermes/service-center-app` | main | тело задачи | todo, ждёт HF-R1 + HF-R2 |

```
«Старт» ─┬─ HF-1 (w03) ── HF-R1 (w02) ─┐
         └─ HF-2 (w02) ── HF-R2 (w03) ─┴─ HF-INT (coord) ── push main ── СТОП ── «Деплой» ── выкладка + ротация токенов
```

- HF-1 и HF-2 идут параллельно в отдельных git worktree. Множества файлов не пересекаются (проверено по Scope спек), поэтому merge без конфликтов.
- Ревью перекрёстное: каждый воркер проверяет ветку другого, автор и ревьюер различаются.
- Причина выбора: w03 вёл блоки E+F (index.html, прод-пакет), w02 — C+D (backend, upload, БД). Оба на `anthropic / claude-sonnet-5-5`.

## Процедура по команде «Старт» (координатор)

1. `git -C ~/service-center-app status` — main чистый и совпадает с `origin/main`.
2. Создать worktree, если их нет:
   ```bash
   cd ~/service-center-app
   git worktree add -b hotfix/hf1-pii-deploy /home/hermes/hf-wt/hf1 main
   git worktree add -b hotfix/hf2-backend   /home/hermes/hf-wt/hf2 main
   ```
   Если worktree уже есть, а main ушёл вперёд — `git -C <wt> rebase main`.
3. `hermes kanban unblock t_bbb5f5e9 --reason "Старт от владельца <дата>"`, то же для `t_32a957ab`. Затем `hermes kanban dispatch`.
4. Статус в TG: `hermes send --to telegram "HOTFIX-H0 запущен: HF-1 (w03), HF-2 (w02)"`.
5. Фоновые наблюдатели за `t_bbb5f5e9` и `t_32a957ab` (skill `coordinator-kanban-execution`, канонический watcher).
6. Когда HF-1 или HF-2 завершён, **первым действием** проверить артефакты: diff в worktree, отчёт, `git status`, dev-БД. Ревью-задача стартует сама по DAG. Если работа явно сломана — `kanban block` ревью-задачи до fix.
7. После HF-R1 и HF-R2 — выполнить HF-INT (тело задачи `t_66f3a7ba`): gate → merge → полная проверка → push → удалить worktree → **СТОП**, отчёт владельцу.

## Процедура по команде «Деплой» (после HF-INT)

По `DEPLOY_HOSTLAND.md` в редакции HF-1. SSH-пароль передаёт владелец в чате; после деплоя напомнить сменить его.

1. Бэкап прод-БД (`sqlite3 .backup`, абсолютные пути) и tar текущего кода.
2. Собрать пакет по allowlist. `bash scripts/check_no_pii.sh` должен дать exit 0.
3. Выложить. Удалить с прода: `api/smoke_test.php`, `api/debug_token.php`, `api/init_db.php`, `api/seed_positions.php`, `api/E8_SYNC.md`, `docs/`, тестовые JS (если есть).
4. Матрица анонимных проверок (раздел «Проверка после выкладки» в DEPLOY_HOSTLAND.md):
   - `/` без ФИО, sha1 совпадает с main;
   - `holidays.php` → 401;
   - служебные файлы → 403/404;
   - `schema.sql` → 403;
   - нет `X-Powered-By`.
5. **Ротация токенов** (выполняет владелец; значения не выводить): удалить `meta.rpa_relay_token` (пересоздастся при reveal admin'ом), сгенерировать новый `meta.external_api_token` и передать его внешней системе импорта. Причина: до хотфикса `debug_token.php` раскрывал часть токена импорта, а reveal был доступен supervisor'ам.
6. Отчёт `reports/HOTFIX_H0/DEPLOY_REPORT.md`, push. Роадмап (`staff_project/Roadmap доработок (обновлён).xlsx`) отмечать **только после явного одобрения владельца**.

## Критерии готовности фазы H0

- [ ] HF-1, HF-2 приняты: ревью ACCEPT, координаторский gate пройден.
- [ ] main: `check_no_pii.sh` = 0, smoke 100%, inline JS валиден, push выполнен.
- [ ] (после «Деплой») прод: `/` без ПДн, `holidays.php` 401, служебные файлы недоступны, `display_errors` выключен, токены ротированы.

## Риски и откаты

| Риск | Мера |
|---|---|
| Пустой `defaultData` ломает офлайн-режим и fallback (B-01) | AC HF-1 п. 4–5: рендер до и после логина. Откат — revert merge-коммита HF-1 |
| `api/.htaccess` с `FilesMatch` даёт 500 на Hostland | Проверка в матрице после деплоя. Откат — вернуть старый `api/.htaccess` (одна строка `SetEnvIf`); guard'ы `PHP_SAPI` всё равно защищают |
| `ini_set` в helpers.php не перекрывает Fatal при разборе файла | Приемлемо: служебные скрипты закрыты guard'ом и `.htaccess`. Полный глобальный обработчик — H2 (S-19) |
| Внешняя система импорта сломается после ротации токена | Ротацию делает владелец, согласовав с владельцем внешней системы |

## Следующие фазы (не в хотфиксе)

H1/H2/H3 — по `AUDIT_REPORT.md` §9, за вычетом пунктов, отложенных вместе с командировками (`reports/BACKLOG.md`). Каждая фаза — отдельный запуск по «Старт».
