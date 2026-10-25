"""設定ファイル (config.yaml) の読み込み。足りない項目は既定値で補う。"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"
BACKGROUND_DIR = ROOT / "backgrounds"
WHITE_BACKGROUND = "白背景"

DEFAULTS: dict = {
    "server": {"port": 7860, "open_browser": True, "allow_lan": True, "username": "", "password": "", "https": False},
    "output": {"dir": "output", "size": 1080, "format": "jpg", "jpeg_quality": 92, "pad_fill": "blur"},
    "segmentation": {"model": "isnet-general-use", "min_area_ratio": 0.02, "max_area_ratio": 0.95},
    "background": {"crop_min": 0.6, "crop_max": 0.85, "rotation_max_deg": 4, "random_flip": True},
    "defaults": {
        "replace_background": True,
        "auto_enhance": True,
        "square_layout": True,
        "add_text": False,
        "background": "",
        "background_brightness": 0.85,
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
        "band_color": "#6E87A0",
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


def _yaml_scalar(text: str) -> str:
    """YAML にそのまま書ける形にする（必要なときだけ "..." で囲む）。"""
    try:
        if yaml.safe_load(f"k: {text}") == {"k": text}:
            return text
    except yaml.YAMLError:
        pass
    return json.dumps(text, ensure_ascii=False)


def save_presets(presets: list[str], path: Path | str = CONFIG_PATH) -> None:
    """config.yaml の text.presets だけを書き換える（コメントなど他の部分はそのまま残す）。"""
    path = Path(path)
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines(keepends=True)
    in_text, start = False, None
    for i, line in enumerate(lines):
        if re.match(r"^text:\s*(#.*)?$", line):
            in_text = True
        elif in_text and re.match(r"^\S", line) and not line.startswith("#"):
            break
        elif in_text and re.match(r"^\s+presets:", line):
            start = i
            break
    if start is None:
        raise ValueError("config.yaml に text: の presets: が見つかりません")
    indent = len(lines[start]) - len(lines[start].lstrip())
    end = start + 1
    while end < len(lines):  # 既存の「- ○○」の行（間のコメント行を含む）を置き換え対象にする
        body = lines[end].strip()
        deeper = len(lines[end]) - len(lines[end].lstrip()) > indent
        if body.startswith("-") or (body.startswith("#") and deeper):
            end += 1
        else:
            break
    item = " " * (indent + 2) + "- {}\n"
    lines[start:end] = [" " * indent + "presets:\n"] + [item.format(_yaml_scalar(str(p))) for p in presets]
    path.write_text("".join(lines), encoding="utf-8")
    if load_config(path)["text"]["presets"] != [str(p) for p in presets]:  # 念のため確認して、だめなら元に戻す
        path.write_text(original, encoding="utf-8")
        raise ValueError("書き換えに失敗したため元に戻しました")


def output_root(cfg: dict) -> Path:
    p = Path(cfg["output"]["dir"]).expanduser()
    return p if p.is_absolute() else ROOT / p
