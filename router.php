<?php
// Router for PHP built-in server: serve real files, route everything else.
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$file = __DIR__ . $uri;
if ($uri !== '/' && file_exists($file) && !is_dir($file)) {
    return false; // serve static/php file as-is
}
// API fallback: only if the file actually exists under api/
if (preg_match('#^/api/(.+\.php)$#', $uri, $m) && file_exists(__DIR__ . '/api/' . $m[1])) {
    require __DIR__ . '/api/' . $m[1];
    return true;
}
require __DIR__ . '/index.html';
return true;
