"""背景画像（イブル等）の切り出し・なじませ・接地影。"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from .config import BACKGROUND_DIR, WHITE_BACKGROUND
from .enhance import LUMA, to_array, to_image

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"}
_cache: dict = {}


def list_backgrounds(folder: Path = BACKGROUND_DIR) -> list[str]:
    if not folder.exists():
        return []
    return sorted(
        p.name for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith(".")
    )


def _load(path: Path) -> Image.Image:
    """背景画像を読み込む（読み取りのみ。元ファイルは変更しない）。"""
    key = (str(path), path.stat().st_mtime)
    if key not in _cache:
        with Image.open(path) as im:
            img = ImageOps.exif_transpose(im).convert("RGB")
        img.thumbnail((3000, 3000), Image.Resampling.LANCZOS)
        _cache.clear()
        _cache[key] = img
    return _cache[key]


def make_background(name: str, size: tuple[int, int], rng: np.random.Generator, cfg: dict,
                    folder: Path = BACKGROUND_DIR) -> Image.Image:
    """背景画像からランダムな位置・角度で切り出す。白背景ならそのまま白。"""
    w, h = size
    path = folder / name
    if name == WHITE_BACKGROUND or not path.is_file():
        return Image.new("RGB", size, (255, 255, 255))
    src = _load(path)
    sw, sh = src.size

    theta = float(rng.uniform(-1, 1)) * float(cfg["rotation_max_deg"])
    c, s = math.cos(math.radians(abs(theta))), math.sin(math.radians(abs(theta)))
    # 回転した切り出し枠がすっぽり入る外接矩形（出力の画素単位）
    bw, bh = (w * c + h * s) * 1.02 + 2, (w * s + h * c) * 1.02 + 2
    frac = float(rng.uniform(cfg["crop_min"], cfg["crop_max"]))
    k = min(min(sw, sh) * frac / max(w, h), sw / bw, sh / bh)  # 出力1px あたりの元画像px
    need_w, need_h = bw * k, bh * k
    cx = float(rng.uniform(need_w / 2, sw - need_w / 2))
    cy = float(rng.uniform(need_h / 2, sh - need_h / 2))
    region = src.crop((cx - need_w / 2, cy - need_h / 2, cx + need_w / 2, cy + need_h / 2))
    region = region.resize((math.ceil(bw), math.ceil(bh)), Image.Resampling.LANCZOS)
    region = region.rotate(theta, resample=Image.Resampling.BICUBIC)
    left, top = (region.width - w) // 2, (region.height - h) // 2
    out = region.crop((left, top, left + w, top + h))
    if cfg.get("random_flip", True) and rng.random() < 0.5:
        out = ImageOps.mirror(out)
    return out


def normalize_brightness(bg: Image.Image, target: float) -> Image.Image:
    """背景（白っぽい布）の明るさをそろえる。暗く写った布写真でも明るく、切り出す場所による差も小さくする。

    target は中間の明るさの目安（0〜1）。0 なら元の写真のまま。
    """
    if not target or target <= 0:
        return bg
    arr = to_array(bg)
    y = arr[::4, ::4] @ LUMA
    gain = float(np.clip(0.97 / max(float(np.percentile(y, 99.5)), 1e-3), 0.8, 2.0))
    med = float(np.median(y)) * gain
    gamma = float(np.clip(np.log(target) / np.log(med), 0.45, 1.6)) if 0.01 < med < 0.99 else 1.0
    lum = np.clip(arr @ LUMA, 1e-4, None)
    new = np.clip(lum * gain, 0, 1) ** gamma
    return to_image(arr * (new / lum)[..., None])


def harmonize(bg: Image.Image, stats: dict, strength: float) -> Image.Image:
    """背景の明るさ・色味を、商品写真の明るさ・色かぶりに寄せる。"""
    if strength <= 0:
        return bg
    arr = to_array(bg)
    bg_hi = max(float(np.percentile(arr[::4, ::4] @ LUMA, 97)), 1e-3)
    ratio = float(np.clip(stats["highlight"] / bg_hi, 0.75, 1.1))
    gain = 1 + (ratio - 1) * strength
    tint = np.clip(1 + (stats["tint"] - 1) * strength, 0.92, 1.08)
    return to_image(arr * (gain * tint))


def contact_shadow(alpha: np.ndarray, strength: float) -> np.ndarray:
    """商品の下に落ちる柔らかい影（0〜1 の暗さマップ）を作る。"""
    if strength <= 0 or alpha.max() < 0.5:
        return np.zeros_like(alpha)
    ys, xs = np.nonzero(alpha > 0.5)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    w, h = x1 - x0 + 1, y1 - y0 + 1
    long_side = max(w, h)
    mask = Image.fromarray((alpha * 255).astype(np.uint8), "L")

    # 全体にふんわり落ちる影（少し下にずらす）
    ambient = Image.new("L", mask.size, 0)
    ambient.paste(mask, (0, int(0.02 * h) + 2))
    ambient = ambient.filter(ImageFilter.GaussianBlur(0.04 * long_side + 2))

    # 接地面のくっきりした影（シルエットの下端部分を薄く潰して、足元に半分隠れるように置く）
    foot_top = y1 - max(2, int(0.15 * h))
    strip_h = max(3, int(0.05 * h))
    strip = mask.crop((x0, foot_top, x1 + 1, y1 + 1)).resize((w, strip_h), Image.Resampling.BILINEAR)
    contact = Image.new("L", mask.size, 0)
    contact.paste(strip, (x0, int(y1 - strip_h * 0.6)))
    contact = contact.filter(ImageFilter.GaussianBlur(0.01 * long_side + 2))

    dark = 0.45 * np.asarray(ambient, np.float32) / 255 + 0.75 * np.asarray(contact, np.float32) / 255
    return np.clip(dark, 0, 1) * float(strength) * 0.75


def composite(bg: Image.Image, product: Image.Image, shadow: np.ndarray) -> Image.Image:
    """影を落とした背景に、切り抜いた商品（RGBA）を重ねる。"""
    base = to_image(to_array(bg) * (1 - shadow[..., None])).convert("RGBA")
    return Image.alpha_composite(base, product).convert("RGB")
