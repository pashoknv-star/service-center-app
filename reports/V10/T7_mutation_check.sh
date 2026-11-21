#!/usr/bin/env bash
# Мутационная проверка сьюта transportgeo: каждая мутация реализации должна сделать прогон красным.
cd /home/hermes/wt/v10-t7 || exit 2
F=api/transport_geo.php
cp $F $TMPDIR/transport_geo.orig
run() {
  name=$1; shift
  cp $TMPDIR/transport_geo.orig $F
  sed -i "$@" $F
  if cmp -s $F $TMPDIR/transport_geo.orig; then echo "MUTANT $name: НЕ ПРИМЕНИЛСЯ"; return; fi
  timeout 300 php api/transport_geo_test.php > $TMPDIR/mut_$name.txt 2>&1
  echo "MUTANT $name: $(grep -E '^=== RESULTS' $TMPDIR/mut_$name.txt)"
  grep '^FAIL' $TMPDIR/mut_$name.txt | head -3 | cut -c1-160
}
run session 's/^        session_write_close();/        \/\/ session_write_close();/'
run follow 's/CURLOPT_FOLLOWLOCATION => false/CURLOPT_FOLLOWLOCATION => true/'
run nocache 's/^            transport_geo_cache_put(\$pdo, \$key, \$action, \$res\[.data.\]);/            \/\/ no cache/'
run floor 's/return intdiv(\$s + 899, 900) \* 15;/return intdiv($s, 900) * 15;/'
run precision "s/'lat' => sprintf('%.3f', \$args\['lat'\])/'lat' => sprintf('%.6f', \$args['lat'])/"
run nobreaker 's/if (count(\$f) >= \$fails) {/if (count($f) >= 1000000) {/'
run norate 's/if (\$nowMs - \$last < \$minGapMs) {/if (false) {/'
run viewer 's/^        require_edit();.*/        require_auth();/'
run cookie "s/CURLOPT_HTTPGET => true,/CURLOPT_HTTPGET => true, CURLOPT_COOKIE => 'PHPSESSID=' . session_id(),/"
cp $TMPDIR/transport_geo.orig $F
cmp $F $TMPDIR/transport_geo.orig && echo restored
