"""「美品」「新品」などの文字を、帯付きで写真の角に入れる。"""
from __future__ import annotations

import functools
import glob
import os
import unicodedata

from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont

POSITIONS = ["左上", "右上", "左下", "右下"]

# 上から順に探して最初に見つかったフォントを使う（Mac はヒラギノ）
FONT_CANDIDATES = [
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W7.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W5.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "C:/Windows/Fonts/YuGothB.ttc",
    "C:/Windows/Fonts/meiryob.ttc",
]


def find_font_path(configured: str = "") -> str | None:
    if configured and os.path.exists(os.path.expanduser(configured)):
        return os.path.expanduser(configured)
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    # macOS のバージョン違いでファイル名が異なる場合に備えて探す
    for folder in ("/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts"):
        for path in sorted(glob.glob(os.path.join(folder, "*"))):
            name = unicodedata.normalize("NFC", os.path.basename(path))
            if "ヒラギノ角ゴ" in name or "Hiragino Sans" in name:
                return path
    return None


@functools.lru_cache(maxsize=16)
def _font(path: str | None, index: int, size: int) -> ImageFont.FreeTypeFont:
    if path:
        return ImageFont.truetype(path, size, index=index)
    return ImageFont.load_default(size)


def _rgb(color: str, fallback: str) -> tuple[int, int, int]:
    try:
        return ImageColor.getrgb(str(color))[:3]
    except ValueError:
        return ImageColor.getrgb(fallback)[:3]


def parse_free_text(text: str) -> list[str]:
    """自由入力欄。改行や「,」「、」で区切ると複数の文字として扱う。"""
    if not text:
        return []
    for sep in (",", "、", "，"):
        text = text.replace(sep, "\n")
    return [t.strip() for t in text.splitlines() if t.strip()]


def draw_labels(img: Image.Image, labels: list[str], cfg: dict, position: str | None = None) -> Image.Image:
    labels = [str(t) for t in labels if str(t).strip()]
    if not labels:
        return img
    position = position if position in POSITIONS else cfg.get("position", "左上")
    if position not in POSITIONS:
        position = "左上"
    if cfg.get("layout", "stack") == "inline":
        labels = [str(cfg.get("separator", "・")).join(labels)]

    base = img.convert("RGBA")
    W, H = base.size
    unit = min(W, H) / 1080
    margin = round(float(cfg.get("margin", 32)) * unit)
    font_path = find_font_path(cfg.get("font_path", ""))
    font_index = int(cfg.get("font_index", 0) or 0)
    opacity = round(255 * min(max(float(cfg.get("band_opacity", 0.92)), 0), 1))
    colors = cfg.get("colors") or {}

    # 帯を作ってから、大きさ・位置を決める
    bands = []
    for text in labels:
        fs = max(8, round(float(cfg.get("font_size", 60)) * unit))
        while True:
            font = _font(font_path, font_index, fs)
            l, t, r, b = font.getbbox(text, anchor="mm")
            pad_x, pad_y = round(fs * 0.5), round(fs * 0.3)
            bw, bh = (r - l) + 2 * pad_x, (b - t) + 2 * pad_y
            if bw <= W - 2 * margin or fs <= 10:
                break
            fs = int(fs * 0.9)
        own = colors.get(text) or {}
        bands.append({
            "text": text, "font": font, "w": bw, "h": bh, "r": round(fs * 0.22),
            "band": _rgb(own.get("band_color", cfg.get("band_color")), "#6E87A0"),
            "fg": _rgb(own.get("text_color", cfg.get("text_color")), "#FFFFFF"),
            "offset": ((l + r) / 2, (t + b) / 2),
        })

    gap = round(min(b["h"] for b in bands) * 0.25)
    right = position.startswith("右")
    bottom = position.endswith("下")
    total_h = sum(b["h"] for b in bands) + gap * (len(bands) - 1)
    y = H - margin - total_h if bottom else margin

    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw, sdraw = ImageDraw.Draw(overlay), ImageDraw.Draw(shadow)
    for band in bands:
        x = W - margin - band["w"] if right else margin
        box = (x, y, x + band["w"], y + band["h"])
        sdraw.rounded_rectangle((box[0], box[1] + 3 * unit, box[2], box[3] + 3 * unit), band["r"], fill=(0, 0, 0, 90))
        draw.rounded_rectangle(box, band["r"], fill=(*band["band"], opacity))
        cx = x + band["w"] / 2 - band["offset"][0]
        cy = y + band["h"] / 2 - band["offset"][1]
        draw.text((cx, cy), band["text"], font=band["font"], fill=(*band["fg"], 255), anchor="mm")
        y += band["h"] + gap

    if cfg.get("band_shadow", True):
        base = Image.alpha_composite(base, shadow.filter(ImageFilter.GaussianBlur(6 * unit)))
    return Image.alpha_composite(base, overlay).convert("RGB")
