"""メルカリ出品写真まとめて加工ツール（ブラウザ画面）。

起動: python app.py （または start.command をダブルクリック）
"""
from __future__ import annotations

import atexit
import datetime as dt
import html
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from urllib.parse import quote

os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")

import gradio as gr  # noqa: E402

from photo_tool import background, segment  # noqa: E402
from photo_tool.config import ROOT, WHITE_BACKGROUND, load_config, output_root, save_presets  # noqa: E402
from photo_tool.pipeline import (  # noqa: E402
    RANDOM_BACKGROUND, Options, load_image, process, save_image, unique_output_path,
)
from photo_tool.text_overlay import POSITIONS, parse_free_text  # noqa: E402

CFG = load_config()
WORK_DIR = Path(tempfile.mkdtemp(prefix="mercari_photo_tool_"))  # 処理前プレビュー用の一時フォルダ
CERT_DIR = ROOT / ".cert"
STATE_DIR = ROOT / "logs"  # 動いているツールの PID・アドレス（.command ファイルが読む）
BACKGROUND = os.environ.get("MERCARI_BACKGROUND") == "1"  # 自動起動（裏で動かす）モード
TEXT_TARGETS = ["1枚目だけ", "全部"]

CSS = """
#run-btn {font-size: 1.15rem; min-height: 56px;}
#redo-row button {min-height: 48px;}
#share-btn {min-height: 52px;}
html:not(.can-share) #share-btn {display: none !important;}
.gradio-container {max-width: 1280px !important;}
#save-list {display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px;}
#save-list figure {margin: 0;}
#save-list img {width: 100%; height: auto; display: block; border-radius: 8px;
                -webkit-touch-callout: default; -webkit-user-select: auto; user-select: auto;}
#save-list figcaption {font-size: .85rem; opacity: .7; text-align: center; margin-top: 2px;}
"""

# 共有メニュー（iPhone の「画像を保存」）でまとめて写真に保存する。https か localhost のときだけ使える
LOAD_JS = """
() => {
  if (window.isSecureContext && navigator.canShare) document.documentElement.classList.add('can-share');
}
"""
SHARE_JS = """
async () => {
  const imgs = [...document.querySelectorAll('#save-list img')];
  if (!imgs.length) { alert('先に「まとめて処理する」を押してください。'); return; }
  try {
    const files = await Promise.all(imgs.map(async (img) => {
      const blob = await (await fetch(img.src)).blob();
      return new File([blob], img.dataset.name, { type: blob.type || 'image/jpeg' });
    }));
    if (!navigator.canShare || !navigator.canShare({ files })) throw new Error('unsupported');
    await navigator.share({ files });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    alert('まとめて保存できませんでした。画像を長押しして「"写真"に保存」を選んでください。');
  }
}
"""


# ---------------------------------------------------------------- 設定まわり
def background_choices() -> list[str]:
    names = background.list_backgrounds()
    return names + ([RANDOM_BACKGROUND] if len(names) > 1 else []) + [WHITE_BACKGROUND]


def default_background() -> str:
    choices = background_choices()
    wanted = CFG["defaults"].get("background") or ""
    return wanted if wanted in choices else choices[0]


def scheme() -> str:
    return "https" if CFG["server"].get("https") else "http"


def lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # 実際には送信しない（自分のIPを調べるだけ）
            ip = s.getsockname()[0]
    except OSError:
        return None
    return None if ip.startswith("127.") else ip


def lan_url(port: int) -> str | None:
    """同じWi-Fi内の他の端末からアクセスするためのURL。"""
    ip = lan_ip()
    return f"{scheme()}://{ip}:{port}" if ip else None


def local_hostname() -> str | None:
    """Mac のローカルホスト名（例: MacBook-Air.local）。IPアドレスが変わっても同じ名前で開ける。"""
    try:
        name = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True,
                              timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return f"{name}.local" if name else None


def hostname_url(port: int) -> str | None:
    host = local_hostname()
    return f"{scheme()}://{host}:{port}" if host else None


def ensure_certificate(ip: str | None, host: str | None = None) -> tuple[str, str] | None:
    """https: true のとき用の自己署名証明書を作る（IPが変わったら作り直す）。"""
    CERT_DIR.mkdir(exist_ok=True)
    cert, key, stamp = CERT_DIR / "cert.pem", CERT_DIR / "key.pem", CERT_DIR / "ip.txt"
    names = f"{ip or ''} {host or ''}"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text() == names:
        return str(cert), str(key)
    base = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
            "-days", "825", "-subj", "/CN=mercari-photo-tool"]
    san = "subjectAltName=DNS:localhost,IP:127.0.0.1" + (f",IP:{ip}" if ip else "") + (f",DNS:{host}" if host else "")
    for cmd in (base + ["-addext", san], base):
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except (OSError, subprocess.CalledProcessError):
            continue
        stamp.write_text(names)
        return str(cert), str(key)
    return None


def write_state(port: int, url: str | None, host_url: str | None) -> None:
    """動いているツールの PID とアドレスを書き出す（start.command などが「もう動いているか」を調べるため）。"""
    STATE_DIR.mkdir(exist_ok=True)
    (STATE_DIR / "url.txt").write_text(f"{scheme()}://localhost:{port}\n{url or ''}\n{host_url or ''}\n")
    pid_file = STATE_DIR / "server.pid"
    pid_file.write_text(str(os.getpid()))

    def cleanup():
        if pid_file.exists() and pid_file.read_text() == str(os.getpid()):
            pid_file.unlink()

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # 「自動起動をオフ」で止めたときも後片付けする


def free_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # 終了直後のポートも使えるように
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    return start


def qr_image(url: str):
    try:
        import qrcode
    except ImportError:
        return None
    return qrcode.make(url, box_size=8, border=2).get_image()


# ---------------------------------------------------------------- 処理
# 画面の設定項目（この順番で関数に渡される）
SETTING_NAMES = [
    "replace_bg", "bg_name", "bg_brightness", "shadow", "harmonize", "enhance_on", "square_on", "scale",
    "text_on", "presets", "free_text", "position", "target",
]


def options_for(index: int, settings: tuple) -> Options:
    s = dict(zip(SETTING_NAMES, settings))
    labels: list[str] = []
    if s["text_on"] and (s["target"] == "全部" or index == 0):
        chosen = list(s["presets"] or [])
        order = CFG["text"]["presets"]
        chosen.sort(key=lambda t: order.index(t) if t in order else len(order))
        labels = chosen + parse_free_text(s["free_text"] or "")
    return Options(
        replace_background=bool(s["replace_bg"]),
        auto_enhance=bool(s["enhance_on"]),
        square_layout=bool(s["square_on"]),
        background=s["bg_name"] or WHITE_BACKGROUND,
        background_brightness=float(s["bg_brightness"]),
        shadow_strength=float(s["shadow"]),
        harmonize_strength=float(s["harmonize"]),
        product_scale=float(s["scale"]),
        labels=labels,
        text_position=s["position"],
    )


def _save_preview(img) -> str:
    preview = img.copy()
    preview.thumbnail((1080, 1080))
    path = WORK_DIR / f"before_{uuid.uuid4().hex[:10]}.jpg"
    preview.save(path, "JPEG", quality=85)
    return str(path)


def _process_item(item: dict, index: int, settings: tuple, out_dir: Path | None = None,
                  replace_override: bool | None = None) -> None:
    img = load_image(item["src"])
    if not item.get("before"):
        item["before"] = _save_preview(img)
    opts = options_for(index, settings)
    if replace_override is not None:
        opts.replace_background = replace_override
    res = process(img, opts, CFG)
    # 出し直しのときは前回の出力（このツールが作ったファイル）を置き換える。元画像には書き込まない
    path = Path(item["out"]) if item.get("out") else unique_output_path(out_dir, Path(item["name"]).stem, CFG)
    save_image(res.image, path, CFG)
    item.update(out=str(path), ok=res.ok, msg=res.message, replaced=res.background_replaced,
                bg=res.background_name, error="")


def gallery_value(items: list[dict]) -> list:
    out = []
    for i, it in enumerate(items):
        img = it.get("out") or it.get("before")
        if not img:
            continue
        mark = " ⚠要確認" if it.get("error") or not it.get("ok", True) else ""
        out.append((img, f"{i + 1}. {it['name']}{mark}"))
    return out


def gallery_index_map(items: list[dict]) -> list[int]:
    return [i for i, it in enumerate(items) if it.get("out") or it.get("before")]


def status_text(items: list[dict], total: int, done: bool) -> str:
    if not items:
        return ""
    out_dir = Path(items[0]["out"]).parent if items[0].get("out") else output_root(CFG)
    head = f"✅ {len(items)}枚を処理しました" if done else f"⏳ 処理中… {len(items)} / {total}枚"
    lines = [f"{head}　保存先: `{out_dir}`"]
    warn = [(i, it) for i, it in enumerate(items) if it.get("error") or not it.get("ok", True)]
    if warn:
        lines.append("")
        lines.append("**⚠ 確認が必要な写真**（下の一覧でタップ →「背景差し替えなしで出し直す」が使えます）")
        for i, it in warn:
            lines.append(f"- {i + 1}枚目 {it['name']}: {it.get('error') or it.get('msg')}")
    return "\n".join(lines)


def detail_text(items: list[dict], i: int | None) -> str:
    if i is None or not (0 <= i < len(items)):
        return "一覧の写真をタップすると、処理前と処理後を並べて表示します。"
    it = items[i]
    lines = [f"**{i + 1}枚目: {it['name']}**"]
    if it.get("error"):
        lines.append(f"❌ {it['error']}")
    elif it.get("replaced"):
        bg = it.get("bg") or ""
        lines.append(f"背景: {bg}" + ("" if it.get("ok") else f"　⚠ {it.get('msg')}"))
    else:
        lines.append("背景: 差し替えなし" + (f"（{it['msg']}）" if it.get("msg") else ""))
    return "\n\n".join(lines)


def save_html(items: list[dict]) -> str:
    """処理後の写真を普通の画像として並べる（iPhone で長押し →「"写真"に保存」できる）。"""
    figures = []
    for i, it in enumerate(items):
        out = Path(it["out"]) if it.get("out") else None
        if not out or not out.exists():
            continue
        name = html.escape(out.name)
        src = f"/gradio_api/file={quote(str(out))}?v={out.stat().st_mtime_ns}"  # 出し直したら新しい画像を読む
        figures.append(f'<figure><img src="{src}" alt="{name}" data-name="{name}">'
                       f"<figcaption>{i + 1}. {name}</figcaption></figure>")
    return f'<div id="save-list">{"".join(figures)}</div>' if figures else ""


def run_batch(files, *settings, progress=gr.Progress()):
    """アップロードされた写真をまとめて処理する（1枚終わるごとに画面を更新）。"""
    if not files:
        yield [], [], "📷 先に写真を選んでください。", None, None, detail_text([], None), None, ""
        return
    paths = [f if isinstance(f, str) else f.name for f in files]
    out_dir = output_root(CFG) / dt.date.today().isoformat()
    items: list[dict] = []
    for i, src in enumerate(paths):
        progress((i, len(paths)), desc=f"{i + 1}/{len(paths)}枚目を処理中")
        item = {"src": src, "name": Path(src).name}
        items.append(item)
        try:
            _process_item(item, i, settings, out_dir)
        except Exception as e:  # 1枚失敗しても残りは続ける
            item.update(ok=False, error=f"処理できませんでした（{type(e).__name__}: {e}）")
        yield (items, gallery_value(items), status_text(items, len(paths), False),
               gr.update(), gr.update(), gr.update(), gr.update(), gr.update())
    first = 0 if items else None
    yield (items, gallery_value(items), status_text(items, len(paths), True),
           items[0].get("before"), items[0].get("out"), detail_text(items, first), first, save_html(items))


def on_select(items, evt: gr.SelectData):
    index_map = gallery_index_map(items or [])
    i = index_map[evt.index] if evt.index is not None and evt.index < len(index_map) else None
    if i is None:
        return None, None, None, detail_text(items, None)
    it = items[i]
    return i, it.get("before"), it.get("out"), detail_text(items, i)


def _redo(items, selected, replace_override, settings):
    if not items or selected is None or not (0 <= selected < len(items)):
        gr.Warning("先に一覧から出し直したい写真をタップしてください。")
        return items, gr.update(), gr.update(), gr.update(), gr.update(), gr.update(), gr.update()
    it = items[selected]
    out_dir = output_root(CFG) / dt.date.today().isoformat()
    try:
        _process_item(it, selected, settings, out_dir, replace_override)
    except Exception as e:
        it.update(ok=False, error=f"処理できませんでした（{type(e).__name__}: {e}）")
    return (items, gallery_value(items), it.get("before"), it.get("out"), detail_text(items, selected),
            save_html(items), status_text(items, len(items), True))


def redo_without_background(items, selected, *settings):
    return _redo(items, selected, False, settings)


def redo_with_current(items, selected, *settings):
    return _redo(items, selected, None, settings)


def on_page_load():
    words = _latest_presets()
    return (gr.update(choices=words), gr.update(choices=words, value=None),
            gr.update(choices=background_choices(), value=default_background()))


def reload_settings():
    global CFG
    CFG = load_config()
    gr.Info("設定ファイルと背景フォルダを読み込み直しました。")
    words = CFG["text"]["presets"]
    return (gr.update(choices=background_choices(), value=default_background()), gr.update(choices=words),
            gr.update(choices=words, value=None))


def _update_presets(words: list[str], checked: list[str], message: str, text_on=None):
    """よく使う文字の一覧を config.yaml に保存して、画面の選択肢を更新する。"""
    global CFG
    try:
        save_presets(words)
    except Exception as e:
        gr.Warning(f"config.yaml に保存できませんでした（{e}）")
        return gr.update(), gr.update(), gr.update(), gr.update()
    CFG = load_config()
    gr.Info(message)
    words = CFG["text"]["presets"]
    return (gr.update(choices=words, value=[w for w in checked if w in words]),
            gr.update(choices=words, value=None), "", gr.update() if text_on is None else text_on)


def _latest_presets() -> list[str]:
    """config.yaml から最新の一覧を読む（別の画面・iPhone で追加した文字も含める）。"""
    global CFG
    try:
        CFG = load_config()
    except Exception as e:  # config.yaml の書き間違いなど。今の設定のまま続ける
        gr.Warning(f"config.yaml を読めませんでした（{e}）")
    return CFG["text"]["presets"]


def add_presets(text: str, checked: list[str]):
    words = _latest_presets()
    typed = list(dict.fromkeys(parse_free_text(text or "")))
    if not typed:
        gr.Warning("追加する文字を入力してください。")
        return gr.update(), gr.update(), gr.update(), gr.update()
    # 入力した文字はすぐ使えるようにチェックも入れる
    checked = list(dict.fromkeys(list(checked or []) + typed))
    new = [w for w in typed if w not in words]
    if not new:
        gr.Info(f"「{'」「'.join(typed)}」はもう登録されているので、チェックを入れました")
        return (gr.update(choices=words, value=[w for w in checked if w in words]),
                gr.update(choices=words, value=None), "", True)
    return _update_presets(words + new, checked, f"「{'」「'.join(new)}」を追加しました", True)


def remove_preset(word: str, checked: list[str]):
    words = _latest_presets()
    if not word or word not in words:
        gr.Warning("削除する文字を選んでください。")
        return (gr.update(choices=words, value=[w for w in (checked or []) if w in words]),
                gr.update(choices=words, value=None), gr.update(), gr.update())
    return _update_presets([w for w in words if w != word], [w for w in (checked or []) if w != word],
                           f"「{word}」を削除しました")


# ---------------------------------------------------------------- 画面
def build_ui(port: int | None = None) -> gr.Blocks:
    d = CFG["defaults"]
    url = lan_url(port) if port else None
    host_url = hostname_url(port) if port else None
    with gr.Blocks(title="メルカリ写真まとめて加工", analytics_enabled=False) as demo:
        gr.Markdown("## 📦 メルカリ写真まとめて加工\n写真を入れて「まとめて処理する」を押すだけ。すべてこのパソコンの中で処理します。")
        items_state = gr.State([])
        selected_state = gr.State(None)

        with gr.Row(equal_height=False):
            with gr.Column(scale=4, min_width=320):
                files = gr.File(label="① 写真をここにドラッグ&ドロップ（複数可）", file_count="multiple",
                                file_types=["image", ".heic", ".heif"], type="filepath", height=180)
                with gr.Group():
                    replace_bg = gr.Checkbox(label="背景をイブル等の画像に差し替える（切り抜き）", value=d["replace_background"])
                    bg_name = gr.Dropdown(label="背景", choices=background_choices(), value=default_background())
                    bg_brightness = gr.Slider(0, 0.95, value=d["background_brightness"], step=0.01,
                                              label="背景の明るさ（0で元の写真のまま）")
                    shadow = gr.Slider(0, 1, value=d["shadow_strength"], step=0.05, label="接地影の濃さ")
                    harmonize = gr.Slider(0, 1, value=d["harmonize_strength"], step=0.05,
                                          label="背景を商品の明るさ・色味になじませる強さ")
                with gr.Group():
                    enhance_on = gr.Checkbox(label="明るさ・ホワイトバランスを自動補正（控えめ）", value=d["auto_enhance"])
                    square_on = gr.Checkbox(label=f"商品を中央にして正方形（{CFG['output']['size']}×{CFG['output']['size']}）にする",
                                            value=d["square_layout"])
                    scale = gr.Slider(0.4, 0.95, value=d["product_scale"], step=0.01, label="商品の大きさ（画面に占める割合）")
                with gr.Group():
                    text_on = gr.Checkbox(label="文字を入れる", value=d["add_text"])
                    presets = gr.CheckboxGroup(label="入れる文字", choices=CFG["text"]["presets"])
                    with gr.Accordion("よく使う文字を追加・削除", open=False):
                        new_preset = gr.Textbox(label="追加する文字（複数は「、」で区切る）", lines=1,
                                                placeholder="例: サイズ140、箱なし")
                        add_preset_btn = gr.Button("追加する", size="sm")
                        del_preset = gr.Dropdown(label="削除する文字", choices=CFG["text"]["presets"], value=None)
                        del_preset_btn = gr.Button("削除する", size="sm", variant="stop")
                    free_text = gr.Textbox(label="自由入力（複数は改行か「、」で区切る）", lines=1,
                                           placeholder="例: 送料込み、匿名配送")
                    with gr.Row():
                        position = gr.Radio(POSITIONS, value=CFG["text"]["position"] if CFG["text"]["position"] in POSITIONS else "左上",
                                            label="文字の位置")
                        target = gr.Radio(TEXT_TARGETS, value=d["text_target"] if d["text_target"] in TEXT_TARGETS else "1枚目だけ",
                                          label="文字を入れる写真")
                run_btn = gr.Button("まとめて処理する", variant="primary", elem_id="run-btn")
                reload_btn = gr.Button("設定ファイル・背景フォルダを再読み込み", size="sm", variant="secondary")
                if url:
                    with gr.Accordion("📱 iPhoneから使う", open=False):
                        gr.Markdown(f"同じWi-FiにつないだiPhoneのSafariで **{url}** を開いてください（下のQRコードをカメラで読み取ってもOK）。"
                                    + (f"\n\nホーム画面に追加するなら **{host_url}** がおすすめ（IPアドレスが変わってもつながります）。"
                                       if host_url else ""))
                        qr = qr_image(url)
                        if qr is not None:
                            gr.Image(value=qr, show_label=False, height=220, interactive=False, buttons=[])

            with gr.Column(scale=6, min_width=320):
                status = gr.Markdown()
                gr.Markdown("**② 処理結果**（写真をタップすると、下に処理前と処理後を並べて表示）")
                gallery = gr.Gallery(show_label=False, columns=3, height="auto",
                                     object_fit="contain", allow_preview=False, interactive=False)
                with gr.Row():
                    before_img = gr.Image(label="処理前", interactive=False, min_width=140, buttons=[])
                    after_img = gr.Image(label="処理後", interactive=False, min_width=140, buttons=["download"])
                detail = gr.Markdown(detail_text([], None))
                with gr.Row(elem_id="redo-row"):
                    redo_nobg_btn = gr.Button("この写真を背景差し替えなしで出し直す", min_width=140)
                    redo_btn = gr.Button("この写真を今の設定で出し直す", min_width=140)
                gr.Markdown("**③ iPhoneの写真に保存**　下の画像を長押し →「\"写真\"に保存」")
                share_btn = gr.Button("処理した写真をまとめて写真に保存", variant="primary", elem_id="share-btn")
                save_list = gr.HTML()

        settings = [replace_bg, bg_name, bg_brightness, shadow, harmonize, enhance_on, square_on, scale,
                    text_on, presets, free_text, position, target]
        assert len(settings) == len(SETTING_NAMES)
        run_btn.click(run_batch, [files, *settings],
                      [items_state, gallery, status, before_img, after_img, detail, selected_state, save_list])
        gallery.select(on_select, [items_state], [selected_state, before_img, after_img, detail])
        redo_outputs = [items_state, gallery, before_img, after_img, detail, save_list, status]
        redo_nobg_btn.click(redo_without_background, [items_state, selected_state, *settings], redo_outputs)
        redo_btn.click(redo_with_current, [items_state, selected_state, *settings], redo_outputs)
        reload_btn.click(reload_settings, None, [bg_name, presets, del_preset])
        # 画面を開くたびに最新の設定（追加した文字・背景フォルダ）を反映する
        demo.load(on_page_load, None, [presets, del_preset, bg_name])
        share_btn.click(None, None, None, js=SHARE_JS)
        preset_outputs = [presets, del_preset, new_preset, text_on]
        add_preset_btn.click(add_presets, [new_preset, presets], preset_outputs)
        new_preset.submit(add_presets, [new_preset, presets], preset_outputs)
        del_preset_btn.click(remove_preset, [del_preset, presets], preset_outputs)
        # 文字を選んだら「文字を入れる」も自動でオンにする
        presets.input(lambda sel: gr.update(value=True) if sel else gr.update(), presets, text_on)
        free_text.input(lambda t: gr.update(value=True) if (t or "").strip() else gr.update(), free_text, text_on)
    return demo


def main() -> None:
    server = CFG["server"]
    port = free_port(int(server["port"]))
    host = "0.0.0.0" if server.get("allow_lan", True) else "127.0.0.1"
    ssl = {}
    if server.get("https"):
        files = ensure_certificate(lan_ip(), local_hostname())
        if files:
            ssl = {"ssl_certfile": files[0], "ssl_keyfile": files[1], "ssl_verify": False}
        else:
            print("[注意] 証明書を作れなかったため、https ではなく http で起動します")
            server["https"] = False
    url = lan_url(port) if host == "0.0.0.0" else None
    host_url = hostname_url(port) if host == "0.0.0.0" else None
    write_state(port, url, host_url)
    print("=" * 60)
    print(" メルカリ写真まとめて加工ツール")
    print(f"  このMacで開く : {scheme()}://localhost:{port}")
    if url:
        print(f"  iPhoneで開く  : {url}  （同じWi-Fiにつないで Safari で開く）")
        if host_url:
            print(f"  　　　　または : {host_url}  （IPアドレスが変わっても使える）")
    print(f"  保存先        : {output_root(CFG)}")
    if BACKGROUND:
        print("  裏で動いています。止めるには「自動起動をオフにする.command」をダブルクリック")
    else:
        print("  終了するには、このウィンドウで Control + C を押すか、ウィンドウを閉じてください")
    print("=" * 60)
    threading.Thread(target=segment.warmup, args=(CFG["segmentation"]["model"],), daemon=True).start()
    output_root(CFG).mkdir(parents=True, exist_ok=True)
    auth = (server["username"], server["password"]) if server.get("username") and server.get("password") else None
    theme = gr.themes.Soft(font=["Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "sans-serif"],
                           font_mono=["Menlo", "monospace"])  # 外部フォントを読み込まない
    build_ui(port).queue(default_concurrency_limit=1).launch(
        server_name=host,
        server_port=port,
        inbrowser=bool(server.get("open_browser", True)) and not BACKGROUND,
        auth=auth,
        allowed_paths=[str(output_root(CFG)), str(WORK_DIR)],
        show_error=True,
        theme=theme,
        css=CSS,
        js=LOAD_JS,
        **ssl,
    )


if __name__ == "__main__":
    main()
