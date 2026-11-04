"""The Chrome Web Store's small promo tile (440×280): the icon and the name on a dark gradient."""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H, S = 440, 280, 3   # drawn three times larger, then scaled down: smooth text and edges


def font(size, bold=False):
    for path, index in (("/System/Library/Fonts/SFNS.ttf", 0), ("/System/Library/Fonts/Helvetica.ttc", 1 if bold else 0),
                        ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0)):
        if os.path.exists(path):
            f = ImageFont.truetype(path, size * S, index=index)
            if bold and path.endswith("SFNS.ttf"):
                try:
                    f.set_variation_by_name("Bold")
                except Exception:
                    pass
            return f
    return ImageFont.load_default()


img = Image.new("RGB", (W * S, H * S))
d = ImageDraw.Draw(img)
for y in range(H * S):          # deep indigo to near-black
    t = y / (H * S)
    d.line([(0, y), (W * S, y)], fill=(int(46 - 30 * t), int(40 - 26 * t), int(110 - 80 * t)))
glow = Image.new("L", (W * S, H * S), 0)
ImageDraw.Draw(glow).ellipse([-120 * S, -160 * S, 300 * S, 240 * S], fill=120)
img = Image.composite(Image.new("RGB", img.size, (120, 108, 245)), img, glow.filter(ImageFilter.GaussianBlur(70 * S)))
icon = Image.open(os.path.join(ROOT, "extension", "icons", "icon128.png")).convert("RGBA").resize((104 * S, 104 * S), Image.LANCZOS)
shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([34 * S, 96 * S, 138 * S, 200 * S], radius=26 * S, fill=(0, 0, 0, 140))
img = Image.alpha_composite(img.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(14 * S)))
img.alpha_composite(icon, (34 * S, 88 * S))
d = ImageDraw.Draw(img)
d.text((160 * S, 104 * S), "Mule Flow", font=font(34, True), fill=(255, 255, 255))
d.text((160 * S, 142 * S), "Viewer", font=font(34, True), fill=(255, 255, 255))
d.text((160 * S, 192 * S), "Flows, branches and DataWeave", font=font(14), fill=(201, 205, 247))
d.text((160 * S, 212 * S), "from any code host", font=font(14), fill=(201, 205, 247))
out = os.path.join(ROOT, "store", "screenshots", "promo-tile-440x280.png")
img.convert("RGB").resize((W, H), Image.LANCZOS).save(out)
print(out)
