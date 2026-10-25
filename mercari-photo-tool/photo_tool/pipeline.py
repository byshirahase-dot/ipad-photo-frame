"""1枚の写真に対する一連の処理（補正 → 切り抜き → 背景合成 → 正方形 → 文字入れ）。"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from . import background, enhance, layout, segment, text_overlay
from .config import BACKGROUND_DIR, WHITE_BACKGROUND

RANDOM_BACKGROUND = "ランダム（毎回ちがう背景）"
MAX_WORK_SIDE = 2400  # これより大きい写真は縮小してから処理（速度のため）

try:  # iPhone の HEIC 写真にも対応
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass


def load_image(path: str | Path) -> Image.Image:
    """写真を読み込む（読み取りのみ。元ファイルは変更しない）。"""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            im = im.convert("RGBA")
            white = Image.new("RGBA", im.size, (255, 255, 255, 255))
            img = Image.alpha_composite(white, im).convert("RGB")
        else:
            img = im.convert("RGB")
    img.thumbnail((MAX_WORK_SIDE, MAX_WORK_SIDE), Image.Resampling.LANCZOS)
    return img


@dataclass
class Options:
    replace_background: bool = True
    auto_enhance: bool = True
    square_layout: bool = True
    background: str = WHITE_BACKGROUND
    shadow_strength: float = 0.5
    harmonize_strength: float = 0.5
    product_scale: float = 0.78
    labels: list[str] = field(default_factory=list)
    text_position: str | None = None


@dataclass
class Result:
    image: Image.Image
    ok: bool = True
    message: str = ""
    background_replaced: bool = False
    background_name: str = ""


def resolve_background(name: str, folder: Path = BACKGROUND_DIR) -> str:
    choices = background.list_backgrounds(folder)
    if name == RANDOM_BACKGROUND:
        return random.choice(choices) if choices else WHITE_BACKGROUND
    if not name:
        return choices[0] if choices else WHITE_BACKGROUND
    return name if name in choices else WHITE_BACKGROUND


def process(img: Image.Image, opts: Options, cfg: dict, rng: np.random.Generator | None = None,
            bg_folder: Path = BACKGROUND_DIR) -> Result:
    rng = rng or np.random.default_rng()
    size = int(cfg["output"]["size"])
    work = enhance.auto_enhance(img, cfg["enhance"]) if opts.auto_enhance else img.convert("RGB")
    result = Result(work)
    out = None

    if opts.replace_background:
        seg = cfg["segmentation"]
        cut = segment.cutout(work, seg["model"], float(seg["min_area_ratio"]), float(seg["max_area_ratio"]))
        if cut.area_ratio < 0.001:
            result.ok, result.message = False, "商品を検出できなかったため、背景は差し替えていません"
        else:
            result.ok, result.message = cut.ok, cut.reason
            if opts.square_layout:
                product = layout.place_product(cut.rgba, size, float(opts.product_scale))
            else:
                product = layout.fit_long_side(cut.rgba, size)
            bg_name = resolve_background(opts.background, bg_folder)
            bg = background.make_background(bg_name, product.size, rng, cfg["background"], bg_folder)
            if bg_name != WHITE_BACKGROUND:
                bg = background.harmonize(bg, enhance.scene_stats(work), float(opts.harmonize_strength))
            alpha = np.asarray(product.getchannel("A"), np.float32) / 255
            shadow = background.contact_shadow(alpha, float(opts.shadow_strength))
            out = background.composite(bg, product, shadow)
            result.background_replaced, result.background_name = True, bg_name

    if out is None:
        if opts.square_layout:
            out = layout.fit_square(work, size, cfg["output"].get("pad_fill", "blur"))
        else:
            out = layout.fit_long_side(work, size)
    if opts.labels:
        out = text_overlay.draw_labels(out, opts.labels, cfg["text"], opts.text_position)
    result.image = out
    return result


def save_image(img: Image.Image, path: Path, cfg: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".png":
        img.save(path, "PNG", optimize=True)
    else:
        img.save(path, "JPEG", quality=int(cfg["output"].get("jpeg_quality", 92)), optimize=True, subsampling=0)
    return path


def unique_output_path(folder: Path, stem: str, cfg: dict) -> Path:
    """同じ名前のファイルがあれば _2, _3 … を付けて、既存ファイルを上書きしない。"""
    ext = ".png" if str(cfg["output"].get("format", "jpg")).lower() == "png" else ".jpg"
    path = folder / f"{stem}_mercari{ext}"
    n = 2
    while path.exists():
        path = folder / f"{stem}_mercari_{n}{ext}"
        n += 1
    return path
