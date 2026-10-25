import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402


def _settings(**over):
    s = dict(replace_bg=True, bg_name="白背景", bg_brightness=0.85, shadow=0.5, harmonize=0.5, enhance_on=True, square_on=True,
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


def test_save_list_links_output_images(tmp_path):
    out = tmp_path / "写真 1_mercari.jpg"
    out.write_bytes(b"x")
    page = app.save_html([{"out": str(out), "name": "写真 1.jpg"}, {"name": "失敗.jpg", "error": "x"}])
    assert page.count("<img") == 1
    assert "/gradio_api/file=" in page and "%20" in page  # 空白や日本語のファイル名も URL にできる
    assert app.save_html([]) == ""


def test_certificate_is_created(tmp_path, monkeypatch):
    import shutil

    import pytest

    if not shutil.which("openssl"):
        pytest.skip("openssl がない")
    monkeypatch.setattr(app, "CERT_DIR", tmp_path / ".cert")
    cert, key = app.ensure_certificate("192.168.1.23")
    assert Path(cert).read_text().startswith("-----BEGIN CERTIFICATE-----")
    assert app.ensure_certificate("192.168.1.23") == (cert, key)  # 同じIPなら作り直さない


def test_adding_a_saved_preset_again_just_checks_it(monkeypatch):
    # 別の画面で追加済みの文字をもう一度入れても、断らずにチェックを入れる
    cfg = app.load_config()
    cfg["text"]["presets"] = ["美品", "サイズ140"]
    monkeypatch.setattr(app, "load_config", lambda *a, **k: cfg)
    monkeypatch.setattr(app, "save_presets", lambda *a, **k: (_ for _ in ()).throw(AssertionError("保存しないはず")))
    presets, delete_list, textbox, text_on = app.add_presets("サイズ140", ["美品"])
    assert "サイズ140" in presets["choices"] and presets["value"] == ["美品", "サイズ140"]
    assert textbox == "" and text_on is True
