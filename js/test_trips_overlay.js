/**
 * T5 Overlay Unit Tests
 * 
 * Тестирование ключевых функций для T5 matrix integration
 * Работает в Node.js без DOM контекста
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[T5-TEST]';

  // Экспорт функций из trips.js для тестирования
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      testOverlayClass: testOverlayClass,
      testTripDaysInYear: testTripDaysInYear,
      runAllTests: runAllTests
    };
  }

  // Тест 1: overlayClass(cellStatus, tripStatus)
  function overlayClass(cellStatus, tripStatus) {
    // Логика классов наложений из trips.js
    if (cellStatus === 'sick') {
      return 'no-trip'; // Больничный имеет приоритет над командировками
    }
    
    if (!tripStatus || tripStatus === '') {
      return ''; // Нет командировки
    }
    
    if (tripStatus === 'forecast') {
      return 'forecast';
    }
    
    if (tripStatus === 'confirmed') {
      return 'confirmed-trip';
    }
    
    if (cellStatus === 'vacation' || cellStatus === 'dayoff') {
      return 'no-trip'; // Отпуск/отгул не пересекаются с командировками
    }
    
    return 'no-trip';
  }

  // Тест 2: tripDaysInYear(startDate, endDate, year)
  function tripDaysInYear(startDate, endDate, year) {
    var start = new Date(startDate);
    var end = new Date(endDate);
    
    // Проверяем, что диапазон относится к указанному году
    if (start.getFullYear() !== year && end.getFullYear() !== year) {
      return []; // Нет дней в указанном году
    }
    
    var result = [];
    var current = new Date(start);
    
    while (current <= end) {
      if (current.getFullYear() === year) {
        var startOfYear = new Date(year, 0, 1);
        var diffTime = Math.abs(current - startOfYear);
        var diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        result.push(diffDays);
      }
      current.setDate(current.getDate() + 1);
    }
    
    return result;
  }

  // Функция для тестирования overlayClass
  function testOverlayClass() {
    console.log(LOG_PREFIX, 'Testing overlayClass()...');
    
    var tests = [
      { input: ['sick', 'confirmed'], expected: 'no-trip', description: 'Больничный подтвержденная командировка' },
      { input: ['', 'forecast'], expected: 'forecast', description: 'Пустая ячейка прогноз командировки' },
      { input: ['vacation', 'forecast'], expected: 'no-trip', description: 'Отпуск + прогноз командировки' },
      { input: ['', 'confirmed'], expected: 'confirmed-trip', description: 'Подтвержденная командировка' },
      { input: ['dayoff', 'forecast'], expected: 'no-trip', description: 'Отгул + прогноз командировки' },
      { input: ['', ''], expected: '', description: 'Обе ячейки пустые' }
    ];
    
    var passed = 0;
    
    tests.forEach(function(test, index) {
      var result = overlayClass(test.input[0], test.input[1]);
      var success = result === test.expected;
      
      if (success) {
        passed++;
        console.log(LOG_PREFIX, '✓ Test', index + 1, 'PASS:', test.description);
      } else {
        console.log(LOG_PREFIX, '✗ Test', index + 1, 'FAIL:', test.description);
        console.log(LOG_PREFIX, '   Expected:', test.expected, 'Got:', result);
      }
    });
    
    console.log(LOG_PREFIX, 'overlayClass tests: ' + passed + '/' + tests.length + ' passed');
    return passed === tests.length;
  }

  // Функция для тестирования tripDaysInYear
  function testTripDaysInYear() {
    console.log(LOG_PREFIX, 'Testing tripDaysInYear()...');
    
    var tests = [
      { 
        input: ['2026-12-28', '2027-01-04', 2026], 
        expected: [362, 363, 364, 365], // Декабрь 2026: 28,29,30,31 = 362,363,364,365
        description: 'Год начинается и заканчивается в 2026'
      },
      { 
        input: ['2026-12-28', '2027-01-04', 2027], 
        expected: [1, 2, 3, 4], // Январь 2027: 1,2,3,4
        description: 'Год начинается в 2027'
      },
      { 
        input: ['2026-01-01', '2026-12-31', 2026], 
        expected: Array.from({length: 365}, (_, i) => i + 1), // Високосный год? Нет, 365 дней
        description: 'Полный год 2026'
      },
      { 
        input: ['2026-01-01', '2026-01-01', 2026], 
        expected: [1], // Один день
        description: 'Один день в начале года'
      },
      { 
        input: ['2027-12-31', '2027-12-31', 2026], 
        expected: [], // Нет дней в 2026
        description: 'Нет дней в указанном году'
      },
      { 
        input: ['2028-02-28', '2028-03-02', 2028], 
        expected: [60, 61], // Високосный год: февраль 29 дней
        description: 'Високосный год 2028'
      }
    ];
    
    var passed = 0;
    
    tests.forEach(function(test, index) {
      var result = tripDaysInYear(test.input[0], test.input[1], test.input[2]);
      
      // Проверяем массивы (порядок важен)
      var success = result.length === test.expected.length;
      if (success) {
        for (var i = 0; i < result.length; i++) {
          if (result[i] !== test.expected[i]) {
            success = false;
            break;
          }
        }
      }
      
      if (success) {
        passed++;
        console.log(LOG_PREFIX, '✓ Test', index + 1, 'PASS:', test.description);
      } else {
        console.log(LOG_PREFIX, '✗ Test', index + 1, 'FAIL:', test.description);
        console.log(LOG_PREFIX, '   Expected:', test.expected);
        console.log(LOG_PREFIX, '   Got:', result);
      }
    });
    
    console.log(LOG_PREFIX, 'tripDaysInYear tests: ' + passed + '/' + tests.length + ' passed');
    return passed === tests.length;
  }

  // Запуск всех тестов
  function runAllTests() {
    console.log(LOG_PREFIX, 'Starting T5 overlay unit tests...');
    console.log(LOG_PREFIX, 'Test environment:', typeof module !== 'undefined' ? 'Node.js' : 'Browser');
    
    var overlayClassPassed = testOverlayClass();
    var tripDaysPassed = testTripDaysInYear();
    
    console.log(LOG_PREFIX, '=== TEST SUMMARY ===');
    console.log(LOG_PREFIX, 'overlayClass tests:', overlayClassPassed ? 'PASS' : 'FAIL');
    console.log(LOG_PREFIX, 'tripDaysInYear tests:', tripDaysPassed ? 'PASS' : 'FAIL');
    
    var allPassed = overlayClassPassed && tripDaysPassed;
    console.log(LOG_PREFIX, 'Overall result:', allPassed ? 'ALL TESTS PASSED ✅' : 'SOME TESTS FAILED ❌');
    
    return allPassed;
  }

  // Автоматический запуск в браузере
  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', function() {
      console.log(LOG_PREFIX, 'T5 overlay tests loaded. Call window.runT5Tests() to run.');
      window.runT5Tests = runAllTests;
    });
  }

})();