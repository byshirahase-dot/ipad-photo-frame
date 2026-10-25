"""設定ファイル (config.yaml) の読み込み。足りない項目は既定値で補う。"""
from __future__ import annotations

import copy
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"
BACKGROUND_DIR = ROOT / "backgrounds"
WHITE_BACKGROUND = "白背景"

DEFAULTS: dict = {
    "server": {"port": 7860, "open_browser": True, "allow_lan": True, "username": "", "password": ""},
    "output": {"dir": "output", "size": 1080, "format": "jpg", "jpeg_quality": 92, "pad_fill": "blur"},
    "segmentation": {"model": "isnet-general-use", "min_area_ratio": 0.02, "max_area_ratio": 0.95},
    "background": {"crop_min": 0.55, "crop_max": 0.9, "rotation_max_deg": 4, "random_flip": True},
    "defaults": {
        "replace_background": True,
        "auto_enhance": True,
        "square_layout": True,
        "add_text": False,
        "background": "",
        "shadow_strength": 0.5,
        "harmonize_strength": 0.5,
        "product_scale": 0.78,
        "text_target": "1枚目だけ",
    },
    "enhance": {
        "white_balance_strength": 0.6,
        "max_wb_gain": 0.12,
        "brightness_strength": 0.7,
        "max_brightness_gain": 1.35,
    },
    "text": {
        "presets": ["裁断済み", "未使用", "新品", "美品", "サイズ130"],
        "position": "左上",
        "font_size": 60,
        "text_color": "#FFFFFF",
        "band_color": "#E8485A",
        "band_opacity": 0.92,
        "band_shadow": True,
        "layout": "stack",
        "separator": "・",
        "margin": 32,
        "colors": {},
        "font_path": "",
        "font_index": 0,
    },
}


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        elif value is not None:
            out[key] = value
    return out


def load_config(path: Path | str = CONFIG_PATH) -> dict:
    path = Path(path)
    data = {}
    if path.exists():
        with path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    cfg = _merge(DEFAULTS, data)
    cfg["text"]["presets"] = [str(p) for p in cfg["text"]["presets"] or []]
    cfg["text"]["colors"] = cfg["text"]["colors"] or {}
    return cfg


def output_root(cfg: dict) -> Path:
    p = Path(cfg["output"]["dir"]).expanduser()
    return p if p.is_absolute() else ROOT / p
