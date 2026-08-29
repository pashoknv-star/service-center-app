#!/usr/bin/env node
/* Проверка синтаксиса всех inline <script> блоков в index.html (Фаза 8B) */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || '/home/hermes/service-center-app/index.html';
const html = fs.readFileSync(file, 'utf8');
const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

let m, i = 0, failed = 0, totalBraces = 0, totalParens = 0, totalBrackets = 0;
while ((m = scriptRe.exec(html)) !== null) {
  i++;
  const code = m[1];
  try {
    new vm.Script(code, { filename: `inline-script-${i}.js` });
    console.log(`[OK]   script #${i} (${code.length} chars) — синтаксис валиден`);
  } catch (e) {
    failed++;
    console.log(`[FAIL] script #${i}: ${e.message}`);
    // показать контекст ошибки
    const lm = /(\d+):(\d+)/.exec(e.stack || '');
    if (lm) {
      const line = parseInt(lm[1], 10);
      const lines = code.split('\n');
      for (let ln = Math.max(0, line - 3); ln < Math.min(lines.length, line + 2); ln++) {
        console.log(`   ${ln + 1}${ln + 1 === line ? ' >>' : '   '}| ${lines[ln]}`);
      }
    }
  }
  // грубый баланс скобок (вне строк/комментариев не считаем — только общий подсчёт)
  for (const ch of code) {
    if (ch === '{') totalBraces++;
    if (ch === '}') totalBraces--;
    if (ch === '(') totalParens++;
    if (ch === ')') totalParens--;
    if (ch === '[') totalBrackets++;
    if (ch === ']') totalBrackets--;
  }
}
console.log('---');
console.log(`scripts: ${i}, failed: ${failed}`);
console.log(`raw brace balance (включая строки): { ${totalBraces}, ( ${totalParens}, [ ${totalBrackets}`);
process.exit(failed ? 1 : 0);
