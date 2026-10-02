#!/usr/bin/env python3
"""Reduce the three wallet logos to white silhouettes for the Connect page.

    pip install Pillow
    ./umbrel/scripts/make-wallet-marks.py

Reads umbrel/assets/wallet-logos/ and writes
umbrel/images/nginx/connect/img/wallet-*.png.

The sources are raster and each carries its artwork in a different colour, so
there is no single rule that works for all three -- hence a table rather than a
loop over a threshold. "Ink" below means the part of the image that survives as
the silhouette; everything else becomes transparent.

    Ashigaru  black figure on a red disc        ink = near-black
    Sentinel  coloured disc, white knockouts    ink = anything not near-white
    Samourai  white figure on a red square      ink = near-white

Sentinel is the odd one: its artwork *is* the disc, with the snowflake, flame
and figure cut out of it, so it reduces to a shape with holes rather than to a
figure. That is the mark, not a limitation of this script.

Thresholding at full resolution gives hard, aliased edges; the downscale to the
output size is what feathers them, so no explicit blur is wanted anywhere here.

The sources deliberately live outside connect/ -- the Dockerfile copies that
directory wholesale, and there is no reason to ship 200KB of source artwork
inside the nginx image.

These are third-party marks, reproduced to state what Dojo is compatible with.
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    raise SystemExit("needs Pillow:  pip install Pillow")

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "umbrel/assets/wallet-logos"
OUTPUT_DIR = REPO_ROOT / "umbrel/images/nginx/connect/img"

# 4x the 22-24px the page renders them at, so they stay crisp on a retina panel
# while each file stays under a couple of KB.
BOX = 88


def is_near_white(r, g, b):
    return r > 200 and g > 200 and b > 200


def is_near_black(r, g, b):
    return r < 90 and g < 90 and b < 90


# scale: a per-mark nudge for optical balance. A dense shape reads heavier than
# an airy one at the same box size, so Sentinel's solid disc sits slightly
# smaller than the two open figures.
MARKS = [
    {"name": "ashigaru", "source": "ashigaru.png", "ink": is_near_black, "scale": 1.0},
    {"name": "sentinel", "source": "sentinel.jpg", "ink": lambda r, g, b: not is_near_white(r, g, b), "scale": 0.88},
    {"name": "samourai", "source": "samourai.png", "ink": is_near_white, "scale": 1.0},
]


def silhouette(image, ink):
    """White where ink, transparent everywhere else."""
    image = image.convert("RGBA")
    raw = image.tobytes()
    out = bytearray(len(raw))

    for i in range(0, len(raw), 4):
        r, g, b, a = raw[i], raw[i + 1], raw[i + 2], raw[i + 3]
        # A transparent source pixel is background whatever its colour: the
        # Ashigaru PNG is transparent outside its disc, and the stored RGB
        # there is arbitrary.
        keep = a > 128 and ink(r, g, b)
        out[i] = out[i + 1] = out[i + 2] = 255
        out[i + 3] = 255 if keep else 0

    return Image.frombytes("RGBA", image.size, bytes(out))


def fit(image, box, scale):
    """Crop to the artwork, then centre it in a square box at `scale`."""
    bbox = image.getbbox()
    if bbox is None:
        raise SystemExit("no ink survived the threshold")
    art = image.crop(bbox)

    target = max(1, int(box * scale))
    ratio = min(target / art.width, target / art.height)
    art = art.resize(
        (max(1, round(art.width * ratio)), max(1, round(art.height * ratio))),
        Image.LANCZOS,
    )

    canvas = Image.new("RGBA", (box, box), (255, 255, 255, 0))
    canvas.paste(art, ((box - art.width) // 2, (box - art.height) // 2))
    return canvas


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for mark in MARKS:
        source = SOURCE_DIR / mark["source"]
        if not source.exists():
            raise SystemExit(f"missing source: {source}")

        art = fit(silhouette(Image.open(source), mark["ink"]), BOX, mark["scale"])
        destination = OUTPUT_DIR / f"wallet-{mark['name']}.png"
        art.save(destination, optimize=True)

        alpha = art.tobytes()[3::4]
        coverage = sum(1 for a in alpha if a > 128) / (BOX * BOX)
        print(f"  {destination.relative_to(REPO_ROOT)}  {BOX}x{BOX}  "
              f"{destination.stat().st_size:,}B  ink {coverage:.0%}")

    print(f"\nwrote {len(MARKS)} marks to {OUTPUT_DIR.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
