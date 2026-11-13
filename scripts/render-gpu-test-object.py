"""Image d'entrée de l'essai 3D (reuse-worker/gpu-test-object.png), faite maison pour n'avoir aucune licence tierce : une tasse
en céramique rouge sur fond blanc, lancer de rayons sur champ de distance, Python pur.
Usage : python3 scripts/render-gpu-test-object.py reuse-worker/gpu-test-object.png [taille, 512]"""
import math, struct, sys, zlib

N = int(sys.argv[2]) if len(sys.argv) > 2 else 512
def v(x, y, z): return (x, y, z)
def add(a, b): return (a[0]+b[0], a[1]+b[1], a[2]+b[2])
def sub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def mul(a, s): return (a[0]*s, a[1]*s, a[2]*s)
def dot(a, b): return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
def norm(a):
    l = math.sqrt(dot(a, a)) or 1.0
    return (a[0]/l, a[1]/l, a[2]/l)

R, H, WALL = 0.62, 0.8, 0.07          # rayon, demi-hauteur, épaisseur de la tasse
def cyl(p, r, h):                       # cylindre plein d'axe y, centré
    dx = math.hypot(p[0], p[2]) - r
    dy = abs(p[1]) - h
    return min(max(dx, dy), 0.0) + math.hypot(max(dx, 0.0), max(dy, 0.0))
def torus(p, R1, r1):                   # anse : tore dans le plan xy, à droite de la tasse
    q = (p[0] - R - 0.05, p[1])
    return math.hypot(math.hypot(q[0], q[1]) - R1, p[2]) - r1
def sdf(p):
    outer = cyl(p, R, H)
    inner = cyl(sub(p, (0, 0.12, 0)), R - WALL, H)
    body = max(outer, -inner)
    handle = max(torus(p, 0.33, 0.075), -(p[0] - R + 0.02))
    return min(body, handle)
def normal(p):
    e = 1e-3
    return norm((sdf(add(p, (e, 0, 0))) - sdf(sub(p, (e, 0, 0))), sdf(add(p, (0, e, 0))) - sdf(sub(p, (0, e, 0))),
                 sdf(add(p, (0, 0, e))) - sdf(sub(p, (0, 0, e)))))

cam = v(0.0, 1.35, 3.6)
look = norm(sub(v(0.1, -0.05, 0), cam))
right = norm((look[2], 0, -look[0]))
up = mul((right[1]*look[2]-right[2]*look[1], right[2]*look[0]-right[0]*look[2], right[0]*look[1]-right[1]*look[0]), -1)
light = norm(v(-0.6, 1.0, 0.8))
rows = bytearray()
for j in range(N):
    rows.append(0)
    for i in range(N):
        x, y = (i + 0.5) / N * 2 - 1, 1 - (j + 0.5) / N * 2
        d = norm(add(add(mul(right, x * 0.46), mul(up, y * 0.46)), look))
        # sphère englobante : les rayons qui la manquent sont du fond
        oc = cam
        b = dot(oc, d); c = dot(oc, oc) - 1.35 ** 2
        col = (250, 250, 250)
        if b * b - c > 0:
            t = -b - math.sqrt(b * b - c)
            for _ in range(80):
                p = add(cam, mul(d, t))
                s = sdf(p)
                if s < 1e-3:
                    n = normal(p)
                    diff = max(dot(n, light), 0.0)
                    h = norm(sub(light, d))
                    spec = max(dot(n, h), 0.0) ** 60
                    inside = math.hypot(p[0], p[2]) < R - WALL + 0.01 and p[1] > -H + 0.1
                    base = (0.93, 0.93, 0.9) if inside else (0.78, 0.09, 0.07)
                    amb = 0.28
                    col = tuple(min(255, int(255 * (base[k] * (amb + 0.75 * diff) + 0.55 * spec))) for k in range(3))
                    break
                t += s
                if t > 8:
                    break
        rows += bytes(col)
def chunk(kind, data): return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
print(len(png))
