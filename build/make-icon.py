"""Draws the Royale CAD icon: a crown as a closed polyline with AutoCAD-style grips, on the app's dark ground.

Run from the repository root: python3 build/make-icon.py. Writes build/icon.png (1024 px) and build/icon.ico.
"""
from PIL import Image, ImageDraw

S = 4  # supersampling
N = 1024 * S
BG = (27, 29, 32)       # --bg
SURFACE2 = (44, 48, 53)  # --surface-2
ACCENT = (103, 232, 249)  # --accent


def px(v):
    return round(v * S)


def draw(size_hint):
    im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # Rounded square, from --surface-2 at the top to --bg at the bottom.
    ground = Image.new('RGBA', (N, N))
    gd = ImageDraw.Draw(ground)
    for y in range(N):
        t = max(0.0, min(1.0, (y / S - 64) / 896))
        gd.line([0, y, N, y], fill=tuple(round(a + (b - a) * t) for a, b in zip(SURFACE2, BG)) + (255,))
    shape = Image.new('L', (N, N), 0)
    ImageDraw.Draw(shape).rounded_rectangle([px(64), px(64), px(960), px(960)], radius=px(200), fill=255)
    im.paste(ground, (0, 0), shape)
    # The drawing grid, faint, as in the viewport (left out where it would only blur).
    if size_hint >= 64:
        grid = Image.new('RGBA', (N, N), (0, 0, 0, 0))
        g = ImageDraw.Draw(grid)
        for k in range(1, 8):
            v = 64 + k * 112
            g.line([px(v), px(64), px(v), px(960)], fill=ACCENT + (24,), width=px(4))
            g.line([px(64), px(v), px(960), px(v)], fill=ACCENT + (24,), width=px(4))
        mask = Image.new('L', (N, N), 0)
        ImageDraw.Draw(mask).rounded_rectangle([px(64), px(64), px(960), px(960)], radius=px(200), fill=255)
        im.paste(grid, (0, 0), Image.composite(grid, Image.new('RGBA', (N, N)), mask))
    # The crown: base, two side points, the middle peak.
    pts = [(240, 720), (240, 400), (384, 560), (512, 300), (640, 560), (784, 400), (784, 720)]
    width = 56 if size_hint >= 48 else 80
    line = [(px(x), px(y)) for x, y in pts + [pts[0]]]
    d.line(line, fill=ACCENT, width=px(width), joint='curve')
    for x, y in pts:
        d.ellipse([px(x - width / 2), px(y - width / 2), px(x + width / 2), px(y + width / 2)], fill=ACCENT)
    # Grips on the peaks, as AutoCAD shows a selected polyline's vertices.
    if size_hint >= 48:
        g = 44
        for x, y in [pts[1], pts[3], pts[5]]:
            d.rectangle([px(x - g), px(y - g), px(x + g), px(y + g)], fill=BG, outline=ACCENT, width=px(16))
    return im.resize((1024, 1024), Image.LANCZOS)


big = draw(1024)
big.save('build/icon.png')
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [(draw(s) if s < 64 else big).resize((s, s), Image.LANCZOS) for s in sizes]
frames[-1].save('build/icon.ico', format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
print('wrote build/icon.png and build/icon.ico')
