<?php

declare(strict_types=1);

/**
 * upload.php (корневой) — делегирует в api/upload.php.
 *
 * Фронтенд (index.html) вызывает fetch('upload.php', ...).
 * Вся логика и серверная фотообработка находятся в api/upload.php
 * (авторизация, crop/resize/WebP/EXIF-strip).
 *
 * Этот файл просто подключает api/upload.php, не дублируя код.
 */

require __DIR__ . '/api/upload.php';
