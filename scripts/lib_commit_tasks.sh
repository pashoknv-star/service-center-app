#!/usr/bin/env bash
# lib_commit_tasks.sh — общая логика IE-2 для хука commit-msg и check_commit_tasks.sh
# (подключается через `source`, сама ничего не запускает).
#
# Правило: коммит «с кодом» (изменён хотя бы один путь вне документов) обязан нести в сообщении
# id существующей Kanban-задачи вида t_[0-9a-f]{8}. Документы: reports/**, staff_project/**, *.md.
# Переменные: KANBAN_DB (по умолчанию $HOME/.hermes/kanban.db), KANBAN_SQLITE3 (по умолчанию sqlite3;
# нужна только для самотестов сценария «sqlite3 недоступен»). БД открывается строго `-readonly`.

export LC_ALL=C

# ct_is_doc <путь> — 0, если путь — документ.
ct_is_doc() {
  case $1 in
    reports/*|staff_project/*|*.md) return 0 ;;
  esac
  return 1
}

# ct_code_files — читает список путей (NUL-разделитель) со stdin, печатает пути кода (по одному на строку).
ct_code_files() {
  local f
  while IFS= read -r -d '' f; do
    ct_is_doc "$f" || printf '%s\n' "$f"
  done
}

# ct_message_ids — читает сообщение коммита со stdin, печатает уникальные id вида t_[0-9a-f]{8}.
# Не считаются: строки-комментарии (начинаются с «#») и всё после ножниц `# ---- >8 ----` (дифф `commit -v`).
# id — отдельное «слово»: в `at_12345678` или `t_123456789` его нет.
ct_message_ids() {
  sed -e '/^# -* >8 -*$/,$d' -e '/^#/d' \
    | tr -c 'A-Za-z0-9_\n' '\n' \
    | grep -xE 't_[0-9a-f]{8}' | sort -u
}

# ct_init_db — выясняет доступность БД Kanban. CT_DB_OK=1|0, CT_DB_REASON — причина недоступности.
ct_init_db() {
  CT_DB=${KANBAN_DB:-$HOME/.hermes/kanban.db}
  CT_SQLITE=${KANBAN_SQLITE3:-sqlite3}
  CT_DB_OK=0; CT_DB_REASON=''
  if ! command -v "$CT_SQLITE" >/dev/null 2>&1; then CT_DB_REASON="нет команды $CT_SQLITE"
  elif [ ! -f "$CT_DB" ] || [ ! -r "$CT_DB" ]; then CT_DB_REASON="файл БД недоступен: $CT_DB"
  else CT_DB_OK=1; fi
}

# ct_existing_ids <id>... — печатает те из id, что есть в tasks.id. Код 0 — запрос выполнен
# (вывод может быть пустым), код 3 — БД не удалось прочитать (CT_DB_OK обнуляется, причина в CT_DB_REASON).
ct_existing_ids() {
  local list='' id out
  for id in "$@"; do list="$list${list:+,}'$id'"; done   # id уже проверены регэкспом: только t_ + hex
  [ -n "$list" ] || return 0
  if ! out=$("$CT_SQLITE" -readonly -cmd '.timeout 3000' "$CT_DB" "SELECT id FROM tasks WHERE id IN ($list);" 2>&1); then
    CT_DB_OK=0; CT_DB_REASON="ошибка чтения БД $CT_DB: $(printf '%s' "$out" | head -1)"
    return 3
  fi
  printf '%s\n' "$out"
}

# ct_check_message <файл-сообщения|-> — проверяет id по правилу (без учёта «код/не код»).
# Устанавливает CT_VERDICT: ok | noid | missing | unverified; CT_IDS — найденные id.
# unverified: БД недоступна, формат верный, существование не проверено (причина в CT_DB_REASON).
ct_check_message() {
  local src=$1 existing rc
  CT_IDS=$(if [ "$src" = - ]; then ct_message_ids; else ct_message_ids <"$src"; fi)
  if [ -z "$CT_IDS" ]; then CT_VERDICT=noid; return 0; fi
  if [ "${CT_DB_OK:-0}" != 1 ]; then CT_VERDICT=unverified; return 0; fi
  # shellcheck disable=SC2086
  existing=$(ct_existing_ids $CT_IDS); rc=$?
  if [ $rc -ne 0 ]; then CT_VERDICT=unverified; return 0; fi
  if [ -n "$existing" ]; then CT_VERDICT=ok; else CT_VERDICT=missing; fi
}
