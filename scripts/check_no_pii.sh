#!/usr/bin/env bash
# check_no_pii.sh — guard against personal data (employee names) in tracked sources
# and in built/served artifacts.
#
# Usage:
#   bash scripts/check_no_pii.sh [paths...]   # default: index.html js api
#   curl -s http://host/ | bash scripts/check_no_pii.sh -   # read stdin
#
# Exit codes: 0 = clean, 1 = PII-like patterns found (file:line printed),
#             2 = usage / environment error.
#
# Patterns (PCRE via grep -P, UTF-8 locale; ERE ranges for Cyrillic are not portable):
#   1. Full name with patronymic:   Surname Name Patronymic(-vich/-vna/-ichna)
#   2. "Surname I. O." form
#   3. Placeholder "Сотрудник NN" (a placeholder must never ship in code either)
#
# Matched text is NOT printed, only file:line, so that the report itself
# never copies names into logs.
set -u

# This file contains regexes only, no real names.
PAT_FIO='[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+(вич|вна|ична)'
PAT_INITIALS='[А-ЯЁ][а-яё]+ [А-ЯЁ]\. ?[А-ЯЁ]\.'
PAT_PLACEHOLDER='Сотрудник [0-9]{2}'
PATTERN="(${PAT_FIO})|(${PAT_INITIALS})|(${PAT_PLACEHOLDER})"

cd "$(dirname "$0")/.." || exit 2

export LC_ALL=C.UTF-8

if [ "$#" -eq 0 ]; then
  set -- index.html js api
fi

found=0
tmp=$(mktemp "${TMPDIR:-/tmp}/check_no_pii.XXXXXX") || exit 2
trap 'rm -f "$tmp"' EXIT

for target in "$@"; do
  if [ "$target" = "-" ]; then
    # stdin mode: report line numbers only (long single-line HTML is common)
    grep -nP -o "$PATTERN" - 2>/dev/null | cut -d: -f1 | sort -un | sed 's/^/<stdin>:/' > "$tmp"
  else
    if [ ! -e "$target" ]; then
      echo "check_no_pii: path not found: $target" >&2
      exit 2
    fi
    # skip binary files; -o + cut keeps the output to file:line only
    grep -rIHnP -o "$PATTERN" --exclude='check_no_pii.sh' "$target" 2>/dev/null \
      | cut -d: -f1,2 | sort -u > "$tmp"
  fi
  if [ -s "$tmp" ]; then
    cat "$tmp"
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo "check_no_pii: FAIL — PII-like patterns found (see file:line above)" >&2
  exit 1
fi
echo "check_no_pii: OK (paths: $*)"
exit 0
