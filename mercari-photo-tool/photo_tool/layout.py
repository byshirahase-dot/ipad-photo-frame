"""商品を中央に置いて正方形にする等の配置処理。"""
from __future__ import annotations

from PIL import Image, ImageFilter


def alpha_bbox(rgba: Image.Image, threshold: int = 26):
    return rgba.getchannel("A").point(lambda v: 255 if v > threshold else 0).getbbox()


def _resize(img: Image.Image, factor: float) -> Image.Image:
    w, h = img.size
    return img.resize((max(1, round(w * factor)), max(1, round(h * factor))), Image.Resampling.LANCZOS)


def place_product(cut: Image.Image, size: int, scale: float) -> Image.Image:
    """切り抜いた商品を、長い辺が size*scale になるよう中央に置いた透明キャンバスを返す。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = alpha_bbox(cut)
    if box is None:
        return canvas
    item = cut.crop(box)
    item = _resize(item, size * scale / max(item.size))
    x = (size - item.width) // 2
    # 下に影が落ちるぶん、ほんの少しだけ上に寄せる
    y = max(0, (size - item.height) // 2 - round(0.012 * size))
    canvas.alpha_composite(item, (x, y))
    return canvas


def fit_long_side(img: Image.Image, size: int) -> Image.Image:
    return _resize(img, size / max(img.size))


def fit_square(img: Image.Image, size: int, fill: str = "blur") -> Image.Image:
    """写真全体が入るように縮小し、余白を埋めて正方形にする。"""
    img = img.convert("RGB")
    if fill == "white":
        canvas = Image.new("RGB", (size, size), (255, 255, 255))
    else:
        cover = _resize(img, size / min(img.size))
        left, top = (cover.width - size) // 2, (cover.height - size) // 2
        canvas = cover.crop((left, top, left + size, top + size))
        canvas = canvas.filter(ImageFilter.GaussianBlur(size * 0.03))
        canvas = Image.blend(canvas, Image.new("RGB", canvas.size, (255, 255, 255)), 0.15)
    item = fit_long_side(img, size)
    canvas.paste(item, ((size - item.width) // 2, (size - item.height) // 2))
    return canvas
