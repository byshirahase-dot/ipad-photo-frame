"""rembg（ローカルAIモデル）で商品を切り抜く。"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage

_sessions: dict = {}
_lock = threading.Lock()


def get_session(model: str):
    with _lock:
        if model not in _sessions:
            from rembg import new_session  # 読み込みが重いので必要になってから

            _sessions[model] = new_session(model)
        return _sessions[model]


def warmup(model: str) -> None:
    """起動時に裏でモデルを読み込んでおく（初回はダウンロードも行う）。"""
    try:
        get_session(model)
        print(f"[準備完了] 切り抜きモデル {model} を読み込みました")
    except Exception as e:  # ネットワーク不通など。実際に使うときにもう一度試す
        print(f"[注意] 切り抜きモデル {model} の準備に失敗しました: {e}")


@dataclass
class Cutout:
    rgba: Image.Image  # 元画像と同じ大きさ。背景部分は透明
    ok: bool
    reason: str
    area_ratio: float


def _clean_mask(alpha: np.ndarray) -> tuple[np.ndarray, int]:
    """商品から離れた小さな物（写り込んだ小物やゴミ）を消し、縁を少しだけ内側に寄せる。

    大きな塊（最大の塊の25%以上）は商品として残し、小さな塊は大きな塊のすぐ近くにあるときだけ残す。
    """
    alpha = np.where(alpha < 0.04, 0, alpha)
    H, W = alpha.shape
    f = max(1, int(np.ceil(max(H, W) / 512)))  # 速度のため縮小して判定する
    small = alpha[::f, ::f] > 0.5
    labels, n = ndimage.label(small)
    if n == 0:
        return alpha * 0, 0
    index = np.arange(1, n + 1)
    sizes = ndimage.sum_labels(np.ones(small.shape, np.float32), labels, index)
    big = sizes >= sizes.max() * 0.25
    dist = ndimage.distance_transform_edt(~np.isin(labels, index[big]))
    near = ndimage.minimum(dist, labels, index) <= 0.03 * np.hypot(*small.shape)
    keep = big | ((sizes >= sizes.max() * 0.01) & near)
    kept = ndimage.binary_dilation(np.isin(labels, index[keep]), iterations=2)
    kept = Image.fromarray(kept.astype(np.uint8) * 255).resize((W, H), Image.Resampling.NEAREST)
    alpha = alpha * (np.asarray(kept) > 127)
    alpha = np.clip((alpha - 0.08) / 0.92, 0, 1)
    return alpha, int(keep.sum())


def _decontaminate(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """半透明の縁に残る元の背景色を、内側の商品の色で置き換える。"""
    edge = (alpha > 0.01) & (alpha < 0.95)
    if not edge.any():
        return rgb
    hard = (alpha >= 0.95).astype(np.float32)
    sigma = max(2.0, 0.004 * max(alpha.shape))
    num = ndimage.gaussian_filter(rgb * hard[..., None], (sigma, sigma, 0))
    den = ndimage.gaussian_filter(hard, sigma)[..., None]
    fg = np.where(den > 1e-3, num / np.maximum(den, 1e-6), rgb)
    t = np.clip((0.95 - alpha) / 0.5, 0, 1)[..., None] * edge[..., None]
    return rgb * (1 - t) + fg * t


def cutout(img: Image.Image, model: str, min_ratio: float, max_ratio: float) -> Cutout:
    from rembg import remove

    img = img.convert("RGB")
    mask = remove(img, session=get_session(model), only_mask=True)
    alpha = np.asarray(mask.convert("L"), dtype=np.float32) / 255.0
    alpha, parts = _clean_mask(alpha)

    ratio = float((alpha > 0.5).mean())
    reasons = []
    if ratio < min_ratio:
        reasons.append("商品がほとんど検出されませんでした")
    elif ratio > max_ratio:
        reasons.append("背景まで商品と判定された可能性があります")
    edges = [alpha[0].mean(), alpha[-1].mean(), alpha[:, 0].mean(), alpha[:, -1].mean()]
    if sum(e > 0.6 for e in edges) >= 3 and ratio <= max_ratio:
        reasons.append("背景まで切り抜かれた可能性があります")
    if parts > 6:
        reasons.append("切り抜きがバラバラになっています")
    solid = (alpha > 0.9).sum() / max((alpha > 0.5).sum(), 1)
    if ratio >= min_ratio and solid < 0.5:
        reasons.append("商品と背景の境目があいまいです")

    rgb = np.asarray(img, dtype=np.float32) / 255.0
    rgb = _decontaminate(rgb, alpha)
    rgba = np.dstack([rgb, alpha])
    out = Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")
    return Cutout(out, not reasons, " / ".join(reasons), ratio)
