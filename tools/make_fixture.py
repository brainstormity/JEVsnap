#!/usr/bin/env python3
"""Generates desktop/test/fixtures/leaky-terminal.png: a fake terminal screenshot with secrets.

Everything in it is fake (the key is a made-up string, the person does not exist).
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "desktop", "test", "fixtures", "leaky-terminal.png")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
LINES = [
    "$ cat .env",
    "STRIPE_KEY=sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
    "DB_PASSWORD=hunter2hunter2",
    "Contact: jane.doe@example.com   Phone: +1 (415) 555-2671",
    "Owner: Jane Doe, 42 Market Street",
    "Build finished in 3.2s",
    "All tests passed",
]
W, H, PAD, LH, SIZE = 1000, 400, 40, 46, 24
img = Image.new("RGB", (W, H), (22, 24, 29))
d = ImageDraw.Draw(img)
f = ImageFont.truetype(FONT, SIZE)
for i, line in enumerate(LINES):
    d.text((PAD, PAD + i * LH), line, font=f, fill=(225, 228, 232))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT)
print("wrote", os.path.abspath(OUT))
