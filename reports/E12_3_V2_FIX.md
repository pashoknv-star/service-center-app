# E12-3 v2 FIX: Обязательность телефона (единый критерий AC)

**Дата:** 2026-09-29  
**Исполнитель:** sd_worker_03  
**Результат:** ✅ Выполнено

## Цель
Точечный фикс E12-3 v2 — телефон = Обязательное поле формы заявки; пустое = блок отправки с ошибкой.

## Дефекты (D9-остаток)
1) **saveTrip (~строка 1655):** `if (phone && phoneEl.value.replace(/[^\\d]/g,'').length < 10)` — пустой телефон НЕ блокировался.
2) **maskPhoneField (~строки 1477-1481):** пустое значение считалось корректным ("empty phone = not mandatory") — противоречие обязательности.

## Решение (минимальный дифф)
### 1) saveTrip
**Было:**
```javascript
// Phone validation: empty = allowed, else must have 10+ digits
var phoneEl = document.getElementById('tripPhone');
if (phone && phoneEl.value.replace(/[^\\d]/g, '').length < 10) {
  showError('tripPhone', 'Телефон сотрудника: обязательное поле');
  return;
}
```

**Стало:**
```javascript
// Phone validation: empty is not allowed, must have 10+ digits (after +)
var phoneDigits = phoneEl.value.replace(/[^\\d]/g, '').length;
if (phoneDigits < 10) {
  showError('tripPhone', 'Телефон сотрудника: обязательное поле');
  return;
}
```
*Пустое поле даёт 0 цифр -> блокировка; 10+ цифр -> проходит; 11 цифр для +7 — ок.*

### 2) maskPhoneField
**Было:**
```javascript
// E12-3: empty phone = not mandatory (allow empty)
if (value.trim() === '') {
  el.classList.remove('trip-form-error');
  el.setCustomValidity('');
  return;
}
```

**Стало:**
```javascript
// E12-3: empty phone = not allowed (block submission with error)
if (value.trim() === '') {
  el.classList.add('trip-form-error');
  el.setCustomValidity('Телефон сотрудника: обязательное поле');
  return;
}
```
*Очистка сообщения setCustomValidity, но стиль trip-form-error остаётся → блок отправки.*
**Важно:** не мешаем пользователю стирать текст во время ввода — только индикация, не фильтр.

## Проверка
1. **В saveTrip нет условия `phone &&` перед проверкой цифр:** grep маркер — проверка цифр безусловная.
2. **Ввод "+" (0 цифр) блокирует отправку с сообщением:** маска возвращает ошибку → форма не отправляется.
3. **bash scripts/test_trips_frontend.sh 7/7:** ✅ PASS PASS PASS PASS PASS PASS PASS
4. **node --check js/trips.js:** ✅ чисто
5. **git status:** изменён только `js/trips.js`

## Принятые критерии
✅ 1. В saveTrip нет условий `phone &&` перед проверкой цифр (grep-маркер: проверка цифр безусловная).  
✅ 2. Ввод "+" (0 цифр) блокирует отправку с сообщением.  
✅ 3. bash scripts/test_trips_frontend.sh 7/7; node --check чисто.  
✅ 4. git status: только js/trips.js изменён.  
✅ 5. Короткий отчёт reports/E12_3_V2_FIX.md (файл:строка, прогоны).
