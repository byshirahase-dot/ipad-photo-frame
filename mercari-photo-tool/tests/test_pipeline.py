import hashlib
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from photo_tool import background, enhance, layout, pipeline, text_overlay  # noqa: E402
from photo_tool.config import WHITE_BACKGROUND, load_config  # noqa: E402
from samples import gray_card, product_photo  # noqa: E402

CFG = load_config()


@pytest.fixture()
def bg_folder(tmp_path):
    sys.path.insert(0, str(ROOT / "tools"))
    from make_sample_background import make

    make(size=900).save(tmp_path / "ibul.jpg", quality=90)
    return tmp_path


def test_config_has_presets_and_defaults():
    assert "美品" in CFG["text"]["presets"]
    assert CFG["output"]["size"] == 1080
    assert CFG["segmentation"]["model"]


def test_enhance_brightens_and_reduces_yellow_cast():
    img = gray_card(rgb=(0.40, 0.38, 0.30))  # 暗くて黄色っぽい
    out = np.asarray(enhance.auto_enhance(img, CFG["enhance"]), np.float32)
    src = np.asarray(img, np.float32)
    assert out.mean() > src.mean() * 1.1
    yellow_before = src[..., :2].mean() - src[..., 2].mean()
    yellow_after = out[..., :2].mean() - out[..., 2].mean()
    assert 0 < yellow_after < yellow_before  # 控えめに戻す（真っ白にはしない）


def test_enhance_leaves_good_photo_almost_unchanged():
    img = gray_card(rgb=(0.55, 0.55, 0.55))
    out = np.asarray(enhance.auto_enhance(img, CFG["enhance"]), np.float32)
    assert np.abs(out - np.asarray(img, np.float32)).mean() < 6


def test_background_crop_is_random_and_has_no_black_corners(bg_folder):
    cfg = CFG["background"]
    a = background.make_background("ibul.jpg", (1080, 1080), np.random.default_rng(1), cfg, bg_folder)
    b = background.make_background("ibul.jpg", (1080, 1080), np.random.default_rng(2), cfg, bg_folder)
    assert a.size == b.size == (1080, 1080)
    assert np.abs(np.asarray(a, np.int16) - np.asarray(b, np.int16)).mean() > 5
    for img in (a, b):
        arr = np.asarray(img)
        for corner in (arr[:4, :4], arr[:4, -4:], arr[-4:, :4], arr[-4:, -4:]):
            assert corner.mean() > 60


def test_white_background_and_missing_file():
    for name in (WHITE_BACKGROUND, "存在しない.jpg"):
        bg = background.make_background(name, (100, 80), np.random.default_rng(), CFG["background"])
        assert bg.size == (100, 80) and np.asarray(bg).min() == 255


def test_contact_shadow_is_below_product():
    alpha = np.zeros((400, 400), np.float32)
    alpha[100:300, 150:250] = 1
    dark = background.contact_shadow(alpha, 0.5)
    assert dark[305:320, 200].mean() > dark[80:95, 200].mean()
    assert dark[0, 0] < 0.01 and dark.max() <= 1
    assert background.contact_shadow(alpha, 0).max() == 0


def test_place_product_scale_and_center():
    cut = Image.new("RGBA", (500, 300), (0, 0, 0, 0))
    cut.paste((255, 0, 0, 255), (100, 50, 300, 250))  # 200x200 の商品
    canvas = layout.place_product(cut, 1080, 0.5)
    x0, y0, x1, y1 = layout.alpha_bbox(canvas)
    assert abs((x1 - x0) - 540) <= 2
    assert abs((x0 + x1) / 2 - 540) <= 2 and abs((y0 + y1) / 2 - 540) <= 20


def test_fit_square_keeps_whole_photo():
    out = layout.fit_square(Image.new("RGB", (1200, 600), (10, 200, 10)), 1080, "white")
    arr = np.asarray(out)
    assert out.size == (1080, 1080)
    assert arr[540, 540, 1] > 150 and arr[5, 540].min() == 255


def test_text_overlay_corner_and_font():
    assert text_overlay.find_font_path() is not None  # 日本語フォントが見つかる
    img = Image.new("RGB", (1080, 1080), (255, 255, 255))
    for pos, (ys, xs) in {"左上": (slice(0, 200), slice(0, 300)), "右下": (slice(-200, None), slice(-300, None))}.items():
        out = np.asarray(text_overlay.draw_labels(img, ["美品", "サイズ130"], CFG["text"], pos))
        assert (out[ys, xs] != 255).any()
        assert (out[540, 540] == 255).all()


def test_parse_free_text():
    assert text_overlay.parse_free_text("送料込み、匿名配送\n 即購入OK ") == ["送料込み", "匿名配送", "即購入OK"]
    assert text_overlay.parse_free_text("") == []


def test_unique_output_path_never_overwrites(tmp_path):
    first = pipeline.unique_output_path(tmp_path, "IMG_1", CFG)
    first.write_bytes(b"x")
    second = pipeline.unique_output_path(tmp_path, "IMG_1", CFG)
    assert first != second and not second.exists()


def test_pipeline_without_background_replacement(tmp_path):
    src = tmp_path / "IMG_0001.jpg"
    product_photo().save(src, quality=90)
    digest = hashlib.md5(src.read_bytes()).hexdigest()
    opts = pipeline.Options(replace_background=False, labels=["新品"])
    res = pipeline.process(pipeline.load_image(src), opts, CFG)
    assert res.image.size == (1080, 1080) and not res.background_replaced
    assert hashlib.md5(src.read_bytes()).hexdigest() == digest  # 元画像は変更しない


@pytest.mark.slow
def test_full_pipeline_with_ai_cutout(bg_folder):
    opts = pipeline.Options(background="ibul.jpg")
    res = pipeline.process(product_photo(), opts, CFG, np.random.default_rng(0), bg_folder)
    assert res.background_replaced and res.ok, res.message
    assert res.image.size == (1080, 1080)
    r, g, b = np.moveaxis(np.asarray(res.image, np.int16), -1, 0)
    blue = (b > r + 40)
    assert blue.mean() > 0.15  # 青い箱が大きく写っている
    ys, xs = np.nonzero(blue)
    assert abs(xs.mean() - 540) < 80 and abs(ys.mean() - 540) < 120  # 中央にある
    assert ((r > g + 80) & (r > b + 80)).mean() < 0.002  # 写り込んだ赤い小物は消えている


@pytest.mark.slow
def test_cutout_failure_is_detected():
    blank = Image.new("RGB", (800, 600), (128, 128, 128))
    res = pipeline.process(blank, pipeline.Options(), CFG)
    assert not res.ok and res.message
