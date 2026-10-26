# HF-R1 / HF-R2 — Независимое ревью веток хотфикса

| Задача | Ревьюер | Ревьюирует | Worktree (только чтение) | Отчёт |
|---|---|---|---|---|
| HF-R1 | sd_worker_02 | HF-1 (sd_worker_03) | `/home/hermes/hf-wt/hf1`, ветка `hotfix/hf1-pii-deploy` | `reports/HOTFIX_H0/HF-R1_REVIEW.md` |
| HF-R2 | sd_worker_03 | HF-2 (sd_worker_02) | `/home/hermes/hf-wt/hf2`, ветка `hotfix/hf2-backend` | `reports/HOTFIX_H0/HF-R2_REVIEW.md` |

Workspace задачи: `dir:/home/hermes/service-center-app`. Запись разрешена только в файл своего отчёта. Код в worktree не править, не коммитить, не пушить.

## Что сделать

1. Прочитать спецификацию ревьюируемой задачи: `reports/HOTFIX_H0/specs/HF-1.md` или `HF-2.md`. Затем отчёт исполнителя в worktree: `reports/HOTFIX_H0/HF-1_REPORT.md` или `HF-2_REPORT.md`.
2. `git -C <worktree> diff main...HEAD` — проверить каждое изменение против Scope и шагов спеки. Лишние файлы и изменения вне Scope — это находка.
3. Независимо повторить критерии приёмки командами в worktree, не доверяя отчёту:
   - smoke;
   - `php -l` / `node --check`;
   - `check_no_pii.sh`;
   - curl-проверки на своём порту `php -S`.
   После прогонов вернуть dev-БД в worktree: `git -C <wt> checkout -- data/app.db`.
4. Отдельно для HF-1:
   - не сломан ли рендер после логина;
   - не осталось ли вшитых данных сотрудников в других блоках `index.html`;
   - корректен ли allowlist в `DEPLOY_HOSTLAND.md`: `api/schema.sql` включён, служебные файлы исключены.
5. Отдельно для HF-2:
   - нет ли обхода guard'а (`PHP_SAPI`) или порядка `declare`, ломающего файл;
   - `require_admin` на всех пишущих методах `holidays.php`;
   - аудит reveal не пишет токен;
   - `.htaccess` без `php_flag`.

## Формат отчёта

- Вердикт: **ACCEPT** или **CHANGES REQUIRED**.
- Таблица находок: ID | P0–P3 | `файл:строка` | суть | как воспроизвести.
- Перечень выполненных проверок: команда → результат.
- Ничего не исправлять. Только находки и предложения.

`kanban complete` с вердиктом в `--result`.
