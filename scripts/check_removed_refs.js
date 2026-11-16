#!/usr/bin/env node
'use strict';
/*
 * check_removed_refs.js — IE-1: удалённые/переименованные функции без оставшихся ссылок.
 *
 * Сравнивает БАЗУ (VERIFY_BASE; по умолчанию `git merge-base HEAD origin/main`) с ТЕКУЩИМ
 * рабочим деревом (включая незакоммиченные и неотслеживаемые правки). Имя, определённое в базе
 * в продакшен-файлах и не определённое там нигде в текущем дереве, считается удалённым
 * (переименование = удаление старого имени). Для каждого удалённого имени ищется целое слово
 * во всех текстовых файлах дерева (кроме reports/, staff_project/, *.md, CODEMAP.md) вне строк-
 * комментариев. Есть ссылки и имени нет в scripts/removed_refs_allow.txt -> FAIL.
 *
 * Не использует CodeGraph/CODEMAP. Зависимости: node, git.
 *
 * Использование:
 *   node scripts/check_removed_refs.js [--root <каталог репозитория>]
 * Переменные окружения: VERIFY_BASE (коммит-база).
 * Код выхода: 0 — PASS, 1 — FAIL (в т.ч. неверная база / формат исключений).
 * Последняя строка stdout всегда: REFS_SUMMARY removed=N withrefs=M allow=K fail=F status=PASS|FAIL
 * (для verify_all.sh).
 *
 * Ограничения (что НЕ ловится) — см. reports/IDX_ENFORCE/IE-1_REPORT.md.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------- аргументы
let ROOT = path.resolve(__dirname, '..');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--root' && process.argv[i + 1]) ROOT = path.resolve(process.argv[++i]);
}
const ALLOW_FILE = path.join(ROOT, 'scripts', 'removed_refs_allow.txt');
const MAX_REFS_PRINTED = 200;       // на одно имя
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
}
function gitTry(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}
function finish(status, removed, withrefs, allow, fail, note) {
  if (note) console.log(note);
  console.log('REFS_SUMMARY removed=' + removed + ' withrefs=' + withrefs + ' allow=' + allow + ' fail=' + fail + ' status=' + status);
  process.exit(status === 'PASS' ? 0 : 1);
}

// ---------------------------------------------------------------- исключения
// Формат строки: `имя  # причина`. Пустые строки и строки, начинающиеся с #, — комментарии.
function readAllow() {
  const entries = new Map(); const errors = [];
  if (!fs.existsSync(ALLOW_FILE)) return { entries, errors };
  fs.readFileSync(ALLOW_FILE, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line[0] === '#') return;
    const m = /^([A-Za-z_$][\w$]*)\s*(?:#(.*))?$/.exec(line);
    if (!m) { errors.push('scripts/removed_refs_allow.txt:' + (i + 1) + ': неверный формат строки «' + line + '» (нужно: имя  # причина)'); return; }
    const reason = (m[2] || '').trim();
    if (!reason) { errors.push('scripts/removed_refs_allow.txt:' + (i + 1) + ': у исключения «' + m[1] + '» нет причины (нужно: имя  # причина)'); return; }
    entries.set(m[1], reason);
  });
  return { entries, errors };
}

// ---------------------------------------------------------------- продакшен-файлы
function isProdFile(p) {
  if (p === 'index.html') return true;
  if (/^js\/[^/]+\.js$/.test(p)) return !/^js\/test_/.test(p);
  if (/^api\/[^/]+\.php$/.test(p)) return !/_test\.php$/.test(p);
  if (/^[^/]+\.php$/.test(p)) return true;
  return false;
}
// Файлы, в которых ищутся ссылки: не reports/, staff_project/, *.md, CODEMAP.md.
function isRefFile(p) {
  if (/^(reports|staff_project)\//.test(p)) return false;
  if (/\.md$/i.test(p) || p === 'CODEMAP.md') return false;
  // сам инструмент (проверка, самотесты, список исключений) называет имена функций в данных — не ссылки на код
  if (/^scripts\/(check_removed_refs\.js|test_removed_refs\.js|removed_refs_allow\.txt)$/.test(p)) return false;
  return true;
}

// ---------------------------------------------------------------- комментарии
// Возвращает массив «очищенных» строк (комментарии заменены пустотой, номера строк сохранены).
// Учитывается: строки целиком `//`, `#` (php/sh/py/yml/txt), `--` (sql), блоки /* */, <!-- --> (html).
// Хвостовые `// ...` после кода НЕ вырезаются (строже: имя там считается ссылкой).
function stripComments(text, file) {
  const ext = path.extname(file).toLowerCase();
  const hashC = ['.php', '.sh', '.py', '.yml', '.yaml', '.txt', '.example', '.htaccess'].includes(ext) || path.basename(file) === '.htaccess' || path.basename(file) === '.gitignore';
  const slashC = ['.js', '.php', '.html', '.htm', '.css', '.mjs', '.cjs'].includes(ext);
  const sqlC = ext === '.sql';
  const blockC = ['.js', '.php', '.html', '.htm', '.css', '.mjs', '.cjs', '.sql'].includes(ext);
  const htmlC = ['.html', '.htm', '.php'].includes(ext);
  const lines = text.split('\n');
  const out = [];
  let inBlock = false, inHtml = false;
  for (let raw of lines) {
    let line = raw;
    if (inBlock) {
      const e = line.indexOf('*/');
      if (e < 0) { out.push(''); continue; }
      line = line.slice(e + 2); inBlock = false;
    }
    if (inHtml) {
      const e = line.indexOf('-->');
      if (e < 0) { out.push(''); continue; }
      line = line.slice(e + 3); inHtml = false;
    }
    // замкнутые блоки на одной строке и открытие блока, переходящего на следующие строки
    if (blockC) {
      for (;;) {
        const m = /(^|[\s;{(,=:>])\/\*/.exec(line);
        if (!m) break;
        const s = m.index + m[1].length;
        const e = line.indexOf('*/', s + 2);
        if (e < 0) { line = line.slice(0, s); inBlock = true; break; }
        line = line.slice(0, s) + ' ' + line.slice(e + 2);
      }
    }
    if (htmlC) {
      for (;;) {
        const s = line.indexOf('<!--');
        if (s < 0) break;
        const e = line.indexOf('-->', s + 4);
        if (e < 0) { line = line.slice(0, s); inHtml = true; break; }
        line = line.slice(0, s) + ' ' + line.slice(e + 3);
      }
    }
    const t = line.trim();
    if (slashC && t.startsWith('//')) line = '';
    else if (hashC && t.startsWith('#')) line = '';
    else if (sqlC && t.startsWith('--')) line = '';
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- определения
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'async', 'foreach', 'elseif', 'use', 'static', 'get', 'set', 'constructor', 'class', 'array', 'list', 'isset', 'empty', 'unset', 'echo', 'print', 'exit', 'die', 'and', 'or', 'catch']);
const ID = '[A-Za-z_$][\\w$]*';
const RX_FUNC = new RegExp('\\bfunction\\s*\\*?\\s*&?\\s*(' + ID + ')\\s*\\(', 'g');                               // function name(  (JS/PHP, методы)
const RX_PROP_FUNC = new RegExp('(' + ID + ')\\s*[:=]\\s*(?:async\\s+)?function\\b', 'g');                        // name: function / name = function
const RX_ARROW = new RegExp('(' + ID + ')\\s*[:=]\\s*(?:async\\s+)?(?:\\([^()]*\\)|' + ID + ')\\s*=>', 'g');       // name = (..) => / name: x =>
const RX_METHOD = new RegExp('^\\s*(?:(?:async|static|get|set)\\s+)*(' + ID + ')\\s*\\([^()]*\\)\\s*\\{\\s*$');     // метод класса/литерала: name(args) {
const JSLIKE = (f) => f === 'index.html' || /\.js$/.test(f);

function definedNames(text, file) {
  const names = new Set();
  const lines = stripComments(text, file);
  for (const line of lines) {
    if (!line) continue;
    let m;
    RX_FUNC.lastIndex = 0; while ((m = RX_FUNC.exec(line))) names.add(m[1]);
    RX_PROP_FUNC.lastIndex = 0; while ((m = RX_PROP_FUNC.exec(line))) names.add(m[1]);
    RX_ARROW.lastIndex = 0; while ((m = RX_ARROW.exec(line))) names.add(m[1]);
    if (JSLIKE(file) && (m = RX_METHOD.exec(line))) names.add(m[1]);
  }
  for (const k of KEYWORDS) names.delete(k);
  return names;
}

// ---------------------------------------------------------------- ввод
function isText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}
function listZ(args) { return git(args).split('\0').filter(Boolean); }
// Содержимое нескольких blob'ов одним процессом `git cat-file --batch`; null — объект не найден.
function gitBatch(specs) {
  if (!specs.length) return [];
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: ROOT, input: specs.join('\n') + '\n', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('git cat-file --batch: ' + r.stderr);
  const buf = r.stdout; const res = []; let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = buf.indexOf(10, pos); const header = buf.toString('utf8', pos, nl); pos = nl + 1;
    const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(header);
    if (!m) { res.push(null); continue; }
    const size = +m[1]; res.push(buf.toString('utf8', pos, pos + size)); pos += size + 1;
  }
  return res;
}

function main() {
  // --- база
  const envBase = process.env.VERIFY_BASE;
  let base;
  if (envBase) {
    const r = gitTry(['rev-parse', '--verify', '--quiet', envBase + '^{commit}']);
    if (!r) return finish('FAIL', 0, 0, 0, 1,
      'FAIL: refs — VERIFY_BASE="' + envBase + '" не найден в репозитории (нет такого коммита).\n' +
      'Что делать: укажите существующий коммит/ветку (например VERIFY_BASE=origin/main) или уберите переменную — тогда база = merge-base HEAD origin/main.');
    base = r.trim();
  } else {
    if (!gitTry(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'])) {
      console.log('refs: ветки origin/main нет и VERIFY_BASE не задан — базы для сравнения нет; удалённых функций: 0.');
      return finish('PASS', 0, 0, readAllow().entries.size, 0);
    }
    const r = gitTry(['merge-base', 'HEAD', 'origin/main']);
    if (!r) return finish('FAIL', 0, 0, 0, 1,
      'FAIL: refs — не удалось определить merge-base HEAD и origin/main (история не связана).\nЧто делать: задайте VERIFY_BASE=<коммит> явно.');
    base = r.trim();
  }

  const allow = readAllow();
  if (allow.errors.length) {
    allow.errors.forEach((e) => console.log('FAIL: refs — ' + e));
    return finish('FAIL', 0, 0, allow.entries.size, allow.errors.length,
      'Что делать: исправьте scripts/removed_refs_allow.txt — формат строки «имя  # причина», причина обязательна.');
  }

  // --- определения в базе (продакшен-файлы)
  const baseFiles = listZ(['ls-tree', '-r', '-z', '--name-only', base]).filter(isProdFile);
  const baseDefs = new Map();     // имя -> первый файл
  const blobs = gitBatch(baseFiles.map((f) => base + ':' + f));
  baseFiles.forEach((f, i) => {
    if (blobs[i] === null) return;
    for (const n of definedNames(blobs[i], f)) if (!baseDefs.has(n)) baseDefs.set(n, f);
  });

  // --- текущее дерево: отслеживаемые + неотслеживаемые (не игнорируемые) файлы, реально существующие
  const cur = Array.from(new Set(listZ(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])))
    .filter((p) => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile());
  const curDefs = new Set();
  const texts = new Map();        // файл -> очищенные строки (только файлы для поиска ссылок)
  for (const f of cur) {
    const prod = isProdFile(f), ref = isRefFile(f);
    if (!prod && !ref) continue;
    const abs = path.join(ROOT, f);
    if (fs.statSync(abs).size > MAX_TEXT_BYTES) continue;
    const buf = fs.readFileSync(abs);
    if (!isText(buf)) continue;
    const txt = buf.toString('utf8');
    if (prod) for (const n of definedNames(txt, f)) curDefs.add(n);
    if (ref) texts.set(f, { clean: stripComments(txt, f), raw: txt.split('\n') });
  }

  const removed = [...baseDefs.keys()].filter((n) => !curDefs.has(n)).sort();
  if (removed.length === 0) {
    console.log('refs: удалённых функций: 0 (база ' + base.slice(0, 8) + ', определений в базе: ' + baseDefs.size + ').');
    if (allow.entries.size) console.log('refs: в removed_refs_allow.txt есть неиспользуемые записи (можно удалить): ' + [...allow.entries.keys()].join(', '));
    return finish('PASS', 0, 0, allow.entries.size, 0);
  }

  // --- ссылки на удалённые имена
  const found = new Map();        // имя -> [{file,line,text}]
  for (const n of removed) {
    const esc = n.replace(/\$/g, '\\$');
    const rx = new RegExp('(?<![\\w$])' + esc + '(?![\\w$])');
    const hits = [];
    for (const [f, t] of texts) {
      for (let i = 0; i < t.clean.length; i++) {
        if (t.clean[i] && rx.test(t.clean[i])) hits.push({ file: f, line: i + 1, text: t.raw[i].trim().slice(0, 160) });
      }
    }
    if (hits.length) found.set(n, hits);
  }

  console.log('refs: база ' + base.slice(0, 8) + ', удалено/переименовано имён функций: ' + removed.length + (removed.length <= 30 ? ' (' + removed.join(', ') + ')' : '') + '.');
  let fail = 0; const applied = [];
  for (const [n, hits] of found) {
    if (allow.entries.has(n)) { applied.push(n); continue; }
    fail++;
    console.log('FAIL: функция «' + n + '» удалена/переименована (определена в ' + baseDefs.get(n) + '), но остались ссылки (' + hits.length + '):');
    hits.slice(0, MAX_REFS_PRINTED).forEach((h) => console.log('  ' + h.file + ':' + h.line + ': ' + h.text));
    if (hits.length > MAX_REFS_PRINTED) console.log('  … и ещё ' + (hits.length - MAX_REFS_PRINTED));
  }
  applied.forEach((n) => console.log('refs: исключение применено — «' + n + '» (' + found.get(n).length + ' ссылок): ' + allow.entries.get(n)));
  const stale = [...allow.entries.keys()].filter((n) => !found.has(n));
  if (stale.length) console.log('refs: в removed_refs_allow.txt есть неиспользуемые записи (можно удалить): ' + stale.join(', '));

  if (fail > 0) {
    return finish('FAIL', removed.length, found.size, allow.entries.size, fail,
      'Что делать: обновите оставшиеся ссылки на старое имя (или верните функцию); если ссылка заведомо безопасна —\n' +
      'внесите имя в scripts/removed_refs_allow.txt строкой «имя  # причина» (причина обязательна).');
  }
  return finish('PASS', removed.length, found.size, allow.entries.size, 0);
}

main();
