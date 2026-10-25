import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402


def _settings(**over):
    s = dict(replace_bg=True, bg_name="白背景", bg_brightness=0.78, shadow=0.5, harmonize=0.5, enhance_on=True, square_on=True,
             scale=0.78, text_on=True, presets=["サイズ130", "美品"], free_text="送料込み", position="右下",
             target="1枚目だけ")
    s.update(over)
    return tuple(s[name] for name in app.SETTING_NAMES)


def test_build_ui():
    assert app.build_ui(7860) is not None


def test_labels_only_on_first_photo_by_default():
    first = app.options_for(0, _settings())
    assert first.labels == ["美品", "サイズ130", "送料込み"]  # 設定ファイルの並び順 → 自由入力
    assert app.options_for(1, _settings()).labels == []
    assert app.options_for(1, _settings(target="全部")).labels
    assert app.options_for(0, _settings(text_on=False)).labels == []


def test_background_choices_keep_white():
    assert app.background_choices()[-1] == "白背景"
