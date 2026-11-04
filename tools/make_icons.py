"""Draws the extension's toolbar icons: a rounded tile with a tiny flow (three nodes, a branch)."""
import os
import sys
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")


def icon(size):
    s = 4                                            # draw large, scale down: smooth edges
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    top, bottom = (99, 102, 241), (139, 92, 246)     # indigo to violet
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.24), fill=255)
    grad = Image.new("RGBA", (n, n))
    for y in range(n):
        t = y / (n - 1)
        grad.paste(tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,), (0, y, n, y + 1))
    img.paste(grad, (0, 0), mask)
    w = max(2, int(n * 0.07))
    a, b, c = (n * 0.27, n * 0.5), (n * 0.73, n * 0.3), (n * 0.73, n * 0.7)
    for end in (b, c):
        d.line([a, (n * 0.5, a[1]), (n * 0.5, end[1]), end], fill=(255, 255, 255, 230), width=w, joint="curve")
    r = n * 0.11
    for x, y in (a, b, c):
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        icon(size).save(os.path.join(OUT, f"icon{size}.png"))
    print(OUT)
