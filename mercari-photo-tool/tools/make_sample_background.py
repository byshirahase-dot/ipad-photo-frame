"""動作確認用の「イブル風」背景画像を作る（本物のイブル写真に置き換えて使ってください）。

使い方: python tools/make_sample_background.py [出力パス]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def make(size: int = 1800, seed: int = 7) -> Image.Image:
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    spacing = size / 14
    # キルティングのふくらみ（ひし形の格子）
    u, v = (x + y) / spacing, (x - y) / spacing
    puff = (np.abs(np.sin(np.pi * u)) * np.abs(np.sin(np.pi * v))) ** 0.6
    base = np.array([238, 214, 206], np.float32) / 255  # くすみピンク
    shade = 0.86 + 0.14 * puff
    light = 1.0 - 0.06 * ((x - size * 0.3) ** 2 + (y - size * 0.2) ** 2) / size**2
    arr = base * (shade * light)[..., None]
    arr += rng.normal(0, 0.012, arr.shape).astype(np.float32)
    img = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGB")

    # 小さな花柄（ドット）
    draw = ImageDraw.Draw(img)
    for _ in range(900):
        cx, cy = rng.uniform(0, size, 2)
        r = rng.uniform(4, 8)
        color = (250, 245, 240) if rng.random() < 0.6 else (214, 176, 170)
        for dx, dy in ((r, 0), (-r, 0), (0, r), (0, -r)):
            draw.ellipse((cx + dx * 0.8 - r * 0.6, cy + dy * 0.8 - r * 0.6, cx + dx * 0.8 + r * 0.6, cy + dy * 0.8 + r * 0.6), fill=color)
        draw.ellipse((cx - r * 0.35, cy - r * 0.35, cx + r * 0.35, cy + r * 0.35), fill=(236, 200, 120))

    # 縫い目（点線）
    stitch = Image.new("L", img.size, 0)
    sd = ImageDraw.Draw(stitch)
    for k in range(-30, 31):
        off = k * spacing
        for t in np.arange(0, size * 1.5, 22):
            sd.line((off + t, t, off + t + 12, t + 12), fill=110, width=3)
            sd.line((off + t, size - t, off + t + 12, size - t - 12), fill=110, width=3)
    stitch = stitch.filter(ImageFilter.GaussianBlur(1.2))
    dark = Image.new("RGB", img.size, (170, 140, 135))
    img = Image.composite(dark, img, stitch)
    return img.filter(ImageFilter.GaussianBlur(0.6))


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "backgrounds" / "sample_ibul_pink.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    make().save(out, "JPEG", quality=85, optimize=True)
    print(f"作成しました: {out}")
