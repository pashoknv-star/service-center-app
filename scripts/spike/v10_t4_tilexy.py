# Номер тайла OSM (slippy map) по lat/lon/zoom — для одного контрольного запроса заголовков тайла.
import math, sys
lat, lon, z = float(sys.argv[1]), float(sys.argv[2]), int(sys.argv[3])
n = 2 ** z
x = int((lon + 180.0) / 360.0 * n)
y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
print(z, x, y)
