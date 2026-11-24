#!/usr/bin/env python3
"""Generate assets/icon.png — 512x512 speedometer gauge + lightning bolt."""
import math
from PIL import Image, ImageDraw

S = 2048  # supersample factor 4 -> final 512
BG = (34, 33, 29, 255)        # dark charcoal
TRACK = (74, 72, 64, 255)     # dim gauge track
CREAM = (236, 234, 225, 255)  # app cream (needle, ticks)
AMBER = (235, 168, 52, 255)   # lightning accent
GREEN = (122, 190, 122, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded-square background
r = int(S * 0.225)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BG)

# gauge geometry: arc from 150deg to 30deg (through top), 240deg sweep
cx, cy = S / 2, S * 0.56
rad = S * 0.34
bbox = [cx - rad, cy - rad, cx + rad, cy + rad]
w = int(S * 0.075)

START, END = 150, 30  # PIL angles, degrees, clockwise from 3 o'clock

# PIL angle convention: 0 = 3 o'clock, increasing clockwise (y grows downward)

# full track (240 deg sweep, drawn clockwise 150 -> 390(=30))
d.arc(bbox, start=START, end=360 + END, fill=TRACK, width=w)

# colored portion: green -> amber over first ~72% of the sweep
d.arc(bbox, start=START, end=START + 100, fill=GREEN, width=w)
d.arc(bbox, start=START + 100, end=START + 172, fill=AMBER, width=w)

# tick marks around the outside of the arc (9 ticks over the 240 deg sweep)
for i in range(9):
    a = math.radians(150 + i * (240 / 8))
    x1, y1 = cx + (rad + w * 0.9) * math.cos(a), cy + (rad + w * 0.9) * math.sin(a)
    x2, y2 = cx + (rad + w * 1.7) * math.cos(a), cy + (rad + w * 1.7) * math.sin(a)
    d.line([x1, y1, x2, y2], fill=TRACK, width=int(S * 0.018))

# needle pointing right-ish (342 deg = upper-right), rounded hub
a = math.radians(342)
nx, ny = cx + rad * 0.78 * math.cos(a), cy + rad * 0.78 * math.sin(a)
d.line([cx, cy, nx, ny], fill=CREAM, width=int(S * 0.038))
pr = int(S * 0.045)
d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=CREAM)

# lightning bolt below the hub, amber
bx, by = S / 2, S * 0.86
u = S * 0.052
bolt = [
    (bx + 0.35 * u, by - 1.9 * u),
    (bx - 1.15 * u, by + 0.25 * u),
    (bx - 0.15 * u, by + 0.25 * u),
    (bx - 0.45 * u, by + 1.9 * u),
    (bx + 1.15 * u, by - 0.35 * u),
    (bx + 0.15 * u, by - 0.35 * u),
]
d.polygon(bolt, fill=AMBER)

img = img.resize((512, 512), Image.LANCZOS)
import os
out = os.path.join(os.path.dirname(__file__), "..", "assets", "icon.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out)
print("wrote", out)
