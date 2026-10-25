"""テスト用の写真を作る（実物の写真の代わり）。"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def product_photo(w: int = 1200, h: int = 900, cast=(1.0, 0.95, 0.78), dim: float = 0.75,
                  seed: int = 0) -> Image.Image:
    """散らかった机の上に箱が置かれた、少し暗くて黄色っぽい写真。"""
    rng = np.random.default_rng(seed)
    img = Image.new("RGB", (w, h), (200, 196, 190))
    d = ImageDraw.Draw(img)
    d.rectangle((0, h * 0.55, w, h), fill=(150, 120, 90))  # 机
    for _ in range(6):  # 余計な物
        x, y = rng.uniform(0, w - 120), rng.uniform(h * 0.05, h * 0.5)
        d.rectangle((x, y, x + rng.uniform(60, 160), y + rng.uniform(40, 120)),
                    fill=tuple(int(c) for c in rng.integers(40, 220, 3)))
    # 箱の影
    shadow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(shadow).ellipse((w * 0.33, h * 0.78, w * 0.72, h * 0.86), fill=150)
    img.paste((60, 50, 40), mask=shadow.filter(ImageFilter.GaussianBlur(14)))
    # 箱（正面・上面・側面）
    d = ImageDraw.Draw(img)
    d.polygon([(w * .36, h * .40), (w * .62, h * .40), (w * .68, h * .33), (w * .42, h * .33)], fill=(235, 235, 240))
    d.polygon([(w * .62, h * .40), (w * .68, h * .33), (w * .68, h * .75), (w * .62, h * .82)], fill=(150, 160, 190))
    d.rectangle((w * .36, h * .40, w * .62, h * .82), fill=(70, 110, 200))
    d.rectangle((w * .40, h * .50, w * .58, h * .60), fill=(250, 250, 250))
    arr = np.asarray(img, np.float32) / 255 * np.array(cast, np.float32) * dim
    arr += rng.normal(0, 0.01, arr.shape).astype(np.float32)
    return Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))


def gray_card(w: int = 600, h: int = 400, rgb=(0.5, 0.5, 0.5)) -> Image.Image:
    arr = np.ones((h, w, 3), np.float32) * np.array(rgb, np.float32)
    arr[: h // 3] = np.array(rgb) * 1.7  # 明るい白っぽい部分
    return Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
