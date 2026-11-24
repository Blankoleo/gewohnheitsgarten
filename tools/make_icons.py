#!/usr/bin/env python3
"""Erzeugt die App-Icons des Gewohnheits-Gartens als Pixelkunst (32x32, hochskaliert).

Reines Python (zlib + struct), keine Fremd-Assets. Aufruf:
    python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

G = 32
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'icons')


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def art():
    top, mid, bot = (40, 32, 76), (142, 84, 138), (247, 168, 120)
    px = [[(0, 0, 0)] * G for _ in range(G)]
    for y in range(G):
        for x in range(G):
            t = y / 21
            c = mix(top, mid, t / 0.55) if t < 0.55 else mix(mid, bot, (t - 0.55) / 0.45)
            # weiches Dithering zwischen den Baendern
            if (x + y) % 2 == 0:
                c = mix(c, bot, 0.04)
            px[y][x] = c
    # Sterne oben
    for (sx, sy) in [(4, 3), (9, 6), (27, 4), (14, 2), (6, 10)]:
        px[sy][sx] = (255, 236, 214)
    # Sonne mit Glühen
    for y in range(G):
        for x in range(G):
            d = math.hypot(x - 23, y - 12)
            if d <= 4.4:
                px[y][x] = (255, 216, 156) if d > 2.2 or x > 22 else (255, 236, 196)
            elif d < 8.5:
                px[y][x] = mix(px[y][x], (255, 196, 150), (8.5 - d) / 8.5 * 0.45)
    # Hügel
    for x in range(G):
        hy = int(round(19.5 + 1.4 * math.sin(x * 0.33) + 0.9 * math.sin(x * 0.95 + 1)))
        for y in range(hy, G):
            px[y][x] = (96, 66, 118)
        hy2 = int(round(21.5 + 1.0 * math.sin(x * 0.5 + 2)))
        for y in range(hy2, G):
            px[y][x] = (74, 52, 98)
    # Erde / Beet
    for y in range(24, G):
        for x in range(G):
            px[y][x] = (128, 92, 74) if y == 24 else ((104, 72, 62) if y < 28 else (176, 124, 92))
            if y == 28:
                px[y][x] = (204, 154, 112)
            if y >= 29 and x % 9 == 8:
                px[y][x] = (130, 88, 70)
    for (cx, cy) in [(5, 26), (12, 25), (22, 26), (27, 25), (9, 27)]:
        px[cy][cx] = (82, 56, 50)

    plant = set()

    def put(x, y, c):
        if 0 <= x < G and 0 <= y < G:
            px[y][x] = c
            plant.add((x, y))

    # Stiel
    for y in range(13, 25):
        put(15, y, (120, 178, 118))
        put(16, y, (86, 138, 98))

    # Blätter
    def leaf(cx, cy, ang, rx, ry):
        ca, sa = math.cos(ang), math.sin(ang)
        for y in range(G):
            for x in range(G):
                dx, dy = x - cx, y - cy
                u = dx * ca + dy * sa
                v = -dx * sa + dy * ca
                if (u / rx) ** 2 + (v / ry) ** 2 <= 1:
                    put(x, y, (154, 206, 140) if v < -0.3 else (104, 166, 112))

    leaf(10.8, 13.6, 0.42, 5.2, 2.3)
    leaf(20.6, 10.6, -0.5, 5.4, 2.4)
    put(15, 12, (154, 206, 140))
    put(16, 12, (120, 178, 118))
    # Umriss
    out = []
    for (x, y) in plant:
        for (nx, ny) in [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]:
            if 0 <= nx < G and 0 <= ny < G and (nx, ny) not in plant and ny < 24:
                out.append((nx, ny))
    for (x, y) in out:
        px[y][x] = mix(px[y][x], (36, 24, 52), 0.7)
    return px


def write_png(path, size, px):
    rows = []
    for y in range(size):
        gy = min(G - 1, y * G // size)
        row = bytearray([0])
        for x in range(size):
            gx = min(G - 1, x * G // size)
            row.extend(px[gy][gx])
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    data = (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    a = art()
    write_png(os.path.join(OUT, 'icon-192.png'), 192, a)
    write_png(os.path.join(OUT, 'icon-512.png'), 512, a)
    write_png(os.path.join(OUT, 'apple-touch-icon.png'), 192, a)
    print('Icons geschrieben nach', os.path.normpath(OUT))
