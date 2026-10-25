"""明るさ・ホワイトバランスの控えめな自動補正。

色相を変えないよう、RGB 全体に同じ倍率をかける明るさ補正と、
白っぽい部分の色かぶり（黄色っぽさ等）だけを少し戻すホワイトバランス補正を行う。
"""
from __future__ import annotations

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def to_array(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0


def to_image(arr: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")


def _small_array(img: Image.Image, max_side: int = 512) -> np.ndarray:
    small = img.convert("RGB")
    small.thumbnail((max_side, max_side), Image.Resampling.BILINEAR)
    return to_array(small)


def estimate_neutral(arr: np.ndarray) -> np.ndarray | None:
    """白・グレーに見える明るめの部分の平均色を返す（色かぶりの推定用）。"""
    px = arr.reshape(-1, 3)
    mx = px.max(axis=1)
    mn = px.min(axis=1)
    sat = (mx - mn) / (mx + 1e-6)
    y = px @ LUMA
    cand = (sat < 0.35) & (y > 0.25) & (mx < 0.985)
    if cand.sum() < 0.01 * len(px):
        return None
    sel = cand & (y >= np.percentile(y[cand], 60))
    return px[sel].mean(axis=0)


def white_balance_gains(arr: np.ndarray, strength: float, max_gain: float) -> np.ndarray:
    neutral = estimate_neutral(arr)
    if neutral is None or strength <= 0:
        return np.ones(3, dtype=np.float32)
    gains = neutral.mean() / np.maximum(neutral, 1e-4)
    gains = 1 + (gains - 1) * strength
    gains = np.clip(gains, 1 - max_gain, 1 + max_gain)
    # 明るさは変えず色味だけを直す
    gains /= float((neutral * gains) @ LUMA) / float(neutral @ LUMA)
    return gains.astype(np.float32)


def auto_enhance(img: Image.Image, cfg: dict) -> Image.Image:
    small = _small_array(img)
    gains = white_balance_gains(small, cfg["white_balance_strength"], cfg["max_wb_gain"])

    y = (small * gains) @ LUMA
    strength = float(cfg["brightness_strength"])
    hi = max(float(np.percentile(y, 99)), 1e-3)
    gain = float(np.clip(0.96 / hi, 1.0, cfg["max_brightness_gain"]))
    gain = 1 + (gain - 1) * strength

    # 中間調が暗い場合だけ、ほんの少し持ち上げる
    gamma = 1.0
    med = float(np.median(y)) * gain
    if 0.02 < med < 0.42:
        gamma = float(np.clip(np.log(0.42) / np.log(med), 0.8, 1.0))
        gamma = 1 - (1 - gamma) * strength

    if np.allclose(gains, 1, atol=1e-3) and abs(gain - 1) < 1e-3 and gamma == 1.0:
        return img.convert("RGB")

    arr = to_array(img) * (gains * gain)
    if gamma != 1.0:
        lum = np.clip(arr @ LUMA, 1e-6, None)
        arr *= (np.clip(lum, 0, 1) ** gamma / lum)[..., None]
    return to_image(arr)


def scene_stats(img: Image.Image) -> dict:
    """背景を商品になじませるための、写真全体の明るさと色味。"""
    small = _small_array(img, 384)
    y = small @ LUMA
    neutral = estimate_neutral(small)
    tint = np.ones(3, dtype=np.float32) if neutral is None else neutral / neutral.mean()
    return {"highlight": float(np.percentile(y, 97)), "tint": tint.astype(np.float32)}
