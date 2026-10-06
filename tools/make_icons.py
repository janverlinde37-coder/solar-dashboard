"""Draw the app icons (sun over a charging battery). Run: python tools/make_icons.py"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (20, 20, 19, 255)
SUN = (240, 180, 41, 255)
BATT = (25, 158, 112, 255)
SS = 4  # supersample for smooth edges


def draw(size, maskable=False):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, s, s], fill=BG)        # launcher crops it; must be full-bleed
        scale = 0.62                               # keep the artwork inside the safe circle
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)
        scale = 0.84
    off = s * (1 - scale) / 2

    def P(x, y):  # artwork drawn on a 100×100 grid
        return (off + x / 100 * s * scale, off + y / 100 * s * scale)

    def L(v):
        return v / 100 * s * scale

    # sun
    cx, cy, r = 50, 34, 15
    for i in range(8):
        a = i * math.pi / 4
        x1, y1 = cx + math.cos(a) * (r + 6), cy + math.sin(a) * (r + 6)
        x2, y2 = cx + math.cos(a) * (r + 14), cy + math.sin(a) * (r + 14)
        d.line([P(x1, y1), P(x2, y2)], fill=SUN, width=int(L(6)))
        for (x, y) in ((x1, y1), (x2, y2)):
            px, py = P(x, y)
            d.ellipse([px - L(3), py - L(3), px + L(3), py + L(3)], fill=SUN)
    d.ellipse([*P(cx - r, cy - r), *P(cx + r, cy + r)], fill=SUN)

    # battery
    x0, y0, x1, y1 = 18, 66, 78, 92
    d.rounded_rectangle([*P(x0, y0), *P(x1, y1)], radius=int(L(5)), outline=BATT, width=int(L(5)))
    d.rounded_rectangle([*P(x1 + 2, 73), *P(x1 + 8, 85)], radius=int(L(2)), fill=BATT)
    for k in range(3):
        bx = x0 + 7 + k * 17
        d.rounded_rectangle([*P(bx, y0 + 7), *P(bx + 12, y1 - 7)], radius=int(L(2)), fill=BATT)

    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
for n in (180, 192, 512):
    draw(n).save(OUT / f"icon-{n}.png")
draw(512, maskable=True).save(OUT / "icon-maskable-512.png")
print("icons written to", OUT)
