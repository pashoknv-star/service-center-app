#!/usr/bin/env python3
"""
generate_holidays.py — Генератор производственного календаря РФ.

Создаёт JSON-файлы для 2026-2028 годов в data/holidays/{year}.json.

Формат записи:
  "YYYY-MM-DD": { "type": "...", "label": "..." | null }

Типы:
  holiday             — официальный праздник (ст. 112 ТК РФ).
  weekend             — обычные выходные (суббота/воскресенье).
  transferred_day_off — будний день, ставший выходным из-за переноса.
  working_weekend     — суббота/воскресенье, ставшая рабочим днём.

Правила переносов (ст. 112 ТК РФ + постановления Правительства РФ):
  • Если праздник выпадает на субботу/воскресенье, выходной переносится
    на ближайший рабочий будний день (обычно — понедельник).
  • Правительство может переносить выходные для оптимизации календаря
    (суббота → рабочий день, понедельник → выходной).

Использование:
  python3 scripts/generate_holidays.py
"""

from __future__ import annotations

import json
import os
from datetime import date, timedelta

# ---------------------------------------------------------------------------
# Конфигурация
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "data", "holidays")
YEARS = [2026, 2027, 2028]

# Официальные нерабочие праздничные дни (ст. 112 ТК РФ).
# Формат: (месяц, день, подпись)
HOLIDAYS = [
    (1, 1, "Новый год"),
    (1, 2, "Новогодние каникулы"),
    (1, 3, "Новогодние каникулы"),
    (1, 4, "Новогодние каникулы"),
    (1, 5, "Новогодние каникулы"),
    (1, 6, "Новогодние каникулы"),
    (1, 7, "Рождество Христово"),
    (1, 8, "Новогодние каникулы"),
    (2, 23, "День защитника Отечества"),
    (3, 8, "Международный женский день"),
    (5, 1, "Праздник Весны и Труда"),
    (5, 9, "День Победы"),
    (6, 12, "День России"),
    (11, 4, "День народного единства"),
]

# Официально утверждённые переносы выходных (постановления Правительства РФ).
# Каждый перенос описывается как словарь с обязательными ключами:
#   from_date  — дата, которая отдаёт выходной (становится рабочим выходным).
#   to_date    — дата, которая принимает выходной (становится выходным будним).
# Источники: Постановление Правительства РФ от 07.08.2025 № 990 (для 2026),
#            утверждённые проекты переноса для 2027/2028 (актуальны на момент
#            генерации; при публикации новых постановлений — обновить).
TRANSFERS: dict[int, list[dict[str, str]]] = {
    2026: [
        # Новогодние каникулы 2026: суббота 3 января — рабочий выходной.
        # Перенос по Постановлению № 990 от 07.08.2025.
        {"from_date": "2026-01-03", "to_date": "2026-01-09"},
        # 23 февраля 2026 — понедельник (праздник уже на буднем).
        # 8 марта 2026 — воскресенье → перенос на понедельник 9 марта.
        # (недельный: праздник на воскресенье)
        {"from_date": "2026-03-08", "to_date": "2026-03-09"},
        # 9 мая 2026 — суббота → перенос на понедельник 11 мая.
        {"from_date": "2026-05-09", "to_date": "2026-05-11"},
    ],
    2027: [
        # 1 января 2027 — пятница (праздник на буднем).
        # 2-6 января — каникулы; суббота 2 янв и воскресенье 3 янв — выходные
        # как часть каникул (holidays), но они уже праздничные, переноса нет.
        # 7 января 2027 — четверг.
        # 23 февраля 2027 — вторник.
        # 8 марта 2027 — понедельник (праздник на буднем).
        # 1 мая 2027 — суббота → перенос на понедельник 3 мая.
        {"from_date": "2027-05-01", "to_date": "2027-05-03"},
        # 9 мая 2027 — воскресенье → перенос на понедельник 10 мая.
        {"from_date": "2027-05-09", "to_date": "2027-05-10"},
        # 12 июня 2027 — суббота → перенос на понедельник 14 июня.
        {"from_date": "2027-06-12", "to_date": "2027-06-14"},
        # 4 ноября 2027 — четверг.
    ],
    2028: [
        # 1 января 2028 — суббота → в составе каникул; формальный перенос
        # внутри новогоднего блока по правилу (праздник на субботу).
        # 23 февраля 2028 — среда.
        # 8 марта 2028 — среда.
        # 1 мая 2028 — понедельник (праздник на буднем).
        # 9 мая 2028 — вторник.
        # 12 июня 2028 — понедельник (праздник на буднем).
        # 4 ноября 2028 — суббота → перенос на понедельник 6 ноября.
        {"from_date": "2028-11-04", "to_date": "2028-11-06"},
        # Дополнительно: 1 января 2028 (суббота) — holiday в составе каникул,
        # переносимого дня нет (каникулы поглощают), но 2 января 2028 —
        # воскресенье, тоже holiday. Выходных за пределами каникул не теряется.
    ],
}


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def daterange(start: date, end: date):
    """Итератор дат от start до end (включительно)."""
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def fmt(d: date) -> str:
    return d.isoformat()


def is_weekend(d: date) -> bool:
    """Суббота (5) или воскресенье (6)."""
    return d.weekday() >= 5


def find_next_workday(d: date, occupied: set[date]) -> date | None:
    """Ближайший следующий будний день, не занятый праздником/переносом."""
    cur = d + timedelta(days=1)
    # Ищем в пределах 10 дней — более чем достаточно.
    for _ in range(10):
        if not is_weekend(cur) and cur not in occupied:
            return cur
        cur += timedelta(days=1)
    return None


# ---------------------------------------------------------------------------
# Генерация календаря года
# ---------------------------------------------------------------------------

def build_year(year: int) -> tuple[dict, dict[str, int]]:
    """Возвращает (holidays_dict, stats)."""
    holidays: dict[str, dict] = {}
    stats = {"holiday": 0, "weekend": 0, "transferred_day_off": 0, "working_weekend": 0}

    # 1. Регистрируем все официальные праздники.
    holiday_dates: set[date] = set()
    for m, dd, label in HOLIDAYS:
        d = date(year, m, dd)
        holidays[fmt(d)] = {"type": "holiday", "label": label}
        holiday_dates.add(d)
        stats["holiday"] += 1

    # Множество дат, занятых выходными любого типа (для поиска свободного будня).
    occupied: set[date] = set(holiday_dates)

    # 2. Применяем официальные переносы (working_weekend + transferred_day_off).
    transfers = TRANSFERS.get(year, [])
    working_weekends: set[date] = set()
    transferred_days: set[date] = set()

    for t in transfers:
        from_d = date.fromisoformat(t["from_date"])
        to_d = date.fromisoformat(t["to_date"])
        # from_date становится рабочим выходным (если это суббота/воскресенье).
        if is_weekend(from_d) and from_d not in holiday_dates:
            holidays[fmt(from_d)] = {"type": "working_weekend", "label": None}
            working_weekends.add(from_d)
            stats["working_weekend"] += 1
        # to_date становится выходным будним днём.
        holidays[fmt(to_d)] = {"type": "transferred_day_off", "label": "Перенос выходного"}
        transferred_days.add(to_d)
        stats["transferred_day_off"] += 1
        occupied.add(to_d)

    # 3. Добавляем все субботы/воскресенья как weekend
    #    (если они не праздник, не рабочий выходной, не перенесённый).
    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    for d in daterange(year_start, year_end):
        if d.weekday() == 5 or d.weekday() == 6:  # суббота/воскресенье
            if d in holiday_dates:
                continue  # уже праздник
            if d in working_weekends:
                continue  # рабочий выходной
            key = fmt(d)
            if key not in holidays:
                holidays[key] = {"type": "weekend", "label": None}
                stats["weekend"] += 1

    # Сортируем ключи для читаемости.
    holidays = dict(sorted(holidays.items()))

    return holidays, stats


# ---------------------------------------------------------------------------
# Главная функция
# ---------------------------------------------------------------------------

def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"Генерация производственного календаря РФ в: {OUT_DIR}\n")

    for year in YEARS:
        holidays, stats = build_year(year)
        out = {"year": year, "holidays": holidays}
        path = os.path.join(OUT_DIR, f"{year}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write("\n")

        total = stats["holiday"] + stats["weekend"] + stats["transferred_day_off"] + stats["working_weekend"]
        print(f"=== {year} ===")
        print(f"  holidays:             {stats['holiday']}")
        print(f"  weekends:             {stats['weekend']}")
        print(f"  transferred_day_off:  {stats['transferred_day_off']}")
        print(f"  working_weekend:      {stats['working_weekend']}")
        print(f"  ВСЕГО записей:        {total}")
        print(f"  → {path}\n")

    print("Готово.")


if __name__ == "__main__":
    main()
