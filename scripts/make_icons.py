"""Render the Nibly icons (icons/icon-{16,32,48,128,512}.png): a fountain-pen nib with a sparkle.

Requires Pillow. Run: npm run icons
"""
import math
import pathlib

from PIL import Image, ImageChops, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = 1024  # draw large, downsample for smooth edges
# The Web Store asks for ~16px transparent padding around 96px artwork at 128px (12.5%).
PAD = 96
TOP, BOTTOM = (247, 120, 40), (214, 64, 12)  # orange gradient


def quad(p0, p1, p2, steps=40):
    """Points along a quadratic Bezier curve."""
    out = []
    for i in range(steps + 1):
        t = i / steps
        out.append(
            (
                (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0],
                (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1],
            )
        )
    return out


def nib_mask(width, length):
    """White nib on black, pointing down, centred in a square canvas of side `length`."""
    m = Image.new("L", (length, length), 0)
    d = ImageDraw.Draw(m)
    cx = length / 2
    w = width / 2
    top, tip = 0.0, float(length)
    shoulder = length * 0.42
    # Outline: flat top, straight sides down to the shoulders, then curving in to a sharp tip.
    right = [(cx + w * 0.78, top), (cx + w, shoulder)] + quad((cx + w, shoulder), (cx + w * 0.95, length * 0.78), (cx, tip))
    left = quad((cx, tip), (cx - w * 0.95, length * 0.78), (cx - w, shoulder)) + [(cx - w * 0.78, top)]
    d.polygon(right + left[1:], fill=255)

    # Cut-outs: the band separating the grip, the breather hole, and the slit to the tip.
    band_y = length * 0.2
    d.rectangle((0, band_y - length * 0.03, length, band_y + length * 0.03), fill=0)
    hole_y, hole_r = length * 0.52, width * 0.11
    d.ellipse((cx - hole_r, hole_y - hole_r, cx + hole_r, hole_y + hole_r), fill=0)
    slit = width * 0.045
    d.polygon([(cx - slit, hole_y), (cx + slit, hole_y), (cx + slit * 0.25, tip - length * 0.06), (cx - slit * 0.25, tip - length * 0.06)], fill=0)
    return m


def star(cx, cy, r, inner=0.2, points=4):
    pts = []
    for i in range(points * 2):
        ang = math.pi / points * i - math.pi / 2
        rad = r if i % 2 == 0 else r * inner
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def render():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGBA", (S, S))
    for y in range(S):
        t = y / (S - 1)
        grad.paste(tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,), (0, y, S, y + 1))
    tile = Image.new("L", (S, S), 0)
    ImageDraw.Draw(tile).rounded_rectangle((PAD, PAD, S - PAD, S - PAD), radius=200, fill=255)
    img.paste(grad, (0, 0), tile)

    # Nib, tilted 45 degrees so the tip points to the bottom-left, like a pen mid-stroke.
    length = 560
    nib = nib_mask(width=310, length=length).rotate(-45, resample=Image.BICUBIC, expand=True)
    layer = Image.new("L", (S, S), 0)
    layer.paste(nib, (int(S * 0.44 - nib.width / 2), int(S * 0.56 - nib.height / 2)))
    layer = ImageChops.multiply(layer, tile)  # keep inside the tile
    img.paste((255, 255, 255, 255), (0, 0), layer)

    # Sparkles: the AI touch.
    d = ImageDraw.Draw(img)
    d.polygon(star(755, 268, 112), fill=(255, 255, 255, 255))
    d.polygon(star(822, 425, 48), fill=(255, 255, 255, 230))
    return img


def main():
    big = render()
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(out / f"icon-{size}.png")
    big.resize((512, 512), Image.LANCZOS).save(out / "icon-512.png")  # store listing / README


if __name__ == "__main__":
    main()
