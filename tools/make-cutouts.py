#!/usr/bin/env python3
"""CardQuest マップ表示用の敵・ボス切り抜き生成（開発時のみ実行）。

『CardQuest マップ仕様書』§4.1（2026-08-26改訂）：戦闘マスの敵・ボスは、カード絵／肖像から
本体を背景除去で切り抜いた絵をマス（台座タイル）の上に立たせて表示する。この切り抜きは
機械的な画像処理（rembg）で自動生成し、コミットしておく。ランタイム（run-ui.js）は
生成済みの assets/cutouts/<cardId>.png・assets/masters/m_<areaId>_cut.png を読み込むだけで、
rembg / onnxruntime への依存を持たない（切り抜きが無ければ従来表示にフォールバックする）。

使い方：
    pip install rembg onnxruntime --break-system-packages
    python3 tools/make-cutouts.py            # 未生成のぶんだけ作る
    python3 tools/make-cutouts.py --force    # 既存も作り直す

エリアを追加した／敵プールが変わったときは ENEMY_IDS を
`node -e "..."`（js/run/areas.js の enemyPool() を呼ぶ）で再計算し、下の一覧を更新してから
再実行する。MASTERS も新エリアのボス肖像ファイル名（拡張子抜き）を追加する。

2026-09-06（M8 WP0）の変更点：
  * 入力を .png → .webp のフォールバック付きにした。`tools/shrink-assets.py` で
    assets/cards/ が 640角 WebP に一本化されたため、.png だけを見ていると全部 skip になる。
  * ENEMY_IDS を M8 の全域（草原〜砂漠・7ダンジョン・七罪人・神殿・神竜の間）へ拡張。
  * MASTERS に新エリアの肖像11枚を追加（山地・海辺・砂漠・七罪人7体・バルザミコス）。
  * 既定を「未生成のぶんだけ」に変更（--force で従来どおり全再生成）。既に手で確認済みの
    切り抜きを、入力が 1024角 PNG から 640角 WebP に替わったせいで作り直してしまうのを避ける。
  * MODEL_OVERRIDES を追加。既定の isnet-general-use が分離に失敗する絵だけ別モデルにする。
"""
import os
import sys

import shutil
import subprocess

try:
    from rembg import remove, new_session
    from PIL import Image
    import numpy as np
except ImportError:
    print("rembg / Pillow / numpy が見つかりません。")
    print("  pip install rembg onnxruntime numpy --break-system-packages")
    sys.exit(1)

# マップ上での表示は最大でも ~140px（マップ仕様書§4）。1024角のまま置くと1枚1MB近くなるため、
# 512角に落としてから pngquant で圧縮する（見た目の劣化は表示サイズでは分からない）。
CUTOUT_SIZE = 512
HAS_PNGQUANT = shutil.which('pngquant') is not None

FORCE = '--force' in sys.argv

# 入力に使う拡張子。shrink-assets.py 後の資産は .webp しか無いが、
# 未圧縮の原本が残っている環境ではそちらを優先する。
SRC_EXTS = ('.png', '.webp')


def find_source(dirpath, stem):
    """<dirpath>/<stem>.png → .webp の順に探して、最初に見つかったパスを返す。"""
    for ext in SRC_EXTS:
        p = os.path.join(dirpath, stem + ext)
        if os.path.exists(p):
            return p
    return None


def tight_crop_square(im, pad_frac=0.04):
    """背景除去直後は被写体の周りに大きな透明の余白が残ることが多く、そのまま
    object-fit:contain で表示台座に乗せると、被写体と台座（node-tile）のあいだに
    見た目上の隙間ができて「浮いている」ように見える（2026-08-26 本人指摘）。
    アルファ値のある範囲だけをきつく切り出し、正方形に収め直すことでこれを解消する。"""
    arr = np.array(im)
    mask = arr[:, :, 3] > 20
    if not mask.any():
        return im
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    pad = int(max(x1 - x0, y1 - y0) * pad_frac)
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(im.width, x1 + pad); y1 = min(im.height, y1 + pad)
    cropped = im.crop((x0, y0, x1, y1))
    side = max(cropped.width, cropped.height)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2), cropped)
    return canvas


def save_optimized(im, dst):
    im = tight_crop_square(im)
    im = im.resize((CUTOUT_SIZE, CUTOUT_SIZE), Image.LANCZOS)
    im.save(dst)
    if HAS_PNGQUANT:
        subprocess.run(
            ['pngquant', '--force', '--quality=70-95', '--skip-if-larger', '--output', dst, dst],
            check=False,
        )
    else:
        print('  (pngquant が無いためファイルサイズは未圧縮のままです。'
              ' apt-get install pngquant を推奨)')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 敵プール（2026-09-06・M8 WP0 で再計算）。
# js/data.js の g テキスト（戦利品ドロップ表）に地形タグ
#   草原／森／山地／海Ｌ／砂漠／荒野／沼地／ダンジョン内／七罪人／神殿モニュメント
# のいずれかを含むユニット＝マップ上に敵として立ちうるカード、の全部。
# 再計算：
#   node -e "const fs=require('fs');
#   const c=JSON.parse('['+fs.readFileSync('js/data.js','utf8').match(/const CARDS = \[([\s\S]*?)\];/)[1]+']');
#   const T=['草原','森','山地','海Ｌ','砂漠','荒野','沼地','ダンジョン内','七罪人','神殿モニュメント'];
#   console.log(JSON.stringify(c.filter(x=>x.t==='U'&&typeof x.g==='string'&&x.g.includes('戦利品')&&T.some(t=>x.g.includes(t))).map(x=>x.id).sort((a,b)=>a-b)));"
# 73種のユニットのうち、ここに入らないのはストライフ(61)だけ
# （原作でショップ限定＝マップに立たない。M8.1 でギンリット初回撃破の報酬になる）。
ENEMY_IDS = sorted(set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
    62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73,
]))

# assets/masters/<name>.png → assets/masters/<name>_cut.png
# M8 で追加した11枚（実装計画追補 M8 §2-1）を含む。神殿（エグゼデグゼス）と神竜の間は
# 専用の肖像を持たず assets/cards/10〜18・15 を流用するので、ここには入れない。
MASTERS = [
    'm_grassland', 'm_forest',                                  # M6（既存）
    'm_mountain', 'm_coast', 'm_desert',                        # M8.1
    'm_sin_gluttony', 'm_sin_envy', 'm_sin_sloth', 'm_sin_pride',
    'm_sin_lust', 'm_sin_greed', 'm_sin_wrath',                 # M8.2（七罪人）
    'm_balsamicos',                                             # M8.3（外部教会）
]


DEFAULT_MODEL = 'isnet-general-use'

# 既定モデルが分離に失敗する絵だけ、モデルを差し替える。
# キーはカードIDの文字列か、マスター肖像のファイル名（拡張子抜き）。
#
# m_sin_wrath：暗い被写体を暗い背景に置いた絵で、isnet だと背景の煙が8割方残り
#   （不透明率 0.84。他のマスターは 0.4〜0.6）、マップの台座の上で黒い塊に見えてしまう。
#   u2net は同じ絵でフードの輪郭を正しく拾う（0.65）。2026-09-06 に目視で確認。
MODEL_OVERRIDES = {
    'm_sin_wrath': 'u2net',
}


def main():
    sessions = {}

    def session_for(key):
        name = MODEL_OVERRIDES.get(key, DEFAULT_MODEL)
        if name not in sessions:
            sessions[name] = new_session(name)
        return sessions[name]

    made = skipped = missing = 0

    out_dir = os.path.join(ROOT, 'assets', 'cutouts')
    cards_dir = os.path.join(ROOT, 'assets', 'cards')
    os.makedirs(out_dir, exist_ok=True)
    for cid in ENEMY_IDS:
        dst = os.path.join(out_dir, '%d.png' % cid)
        if os.path.exists(dst) and not FORCE:
            skipped += 1
            continue
        src = find_source(cards_dir, str(cid))
        if src is None:
            print('skip card %d: no source art in %s' % (cid, cards_dir))
            missing += 1
            continue
        im = Image.open(src).convert('RGBA')
        out = remove(im, session=session_for(str(cid)))
        save_optimized(out, dst)
        made += 1
        print('cutout: %s' % dst)

    masters_dir = os.path.join(ROOT, 'assets', 'masters')
    for name in MASTERS:
        dst = os.path.join(masters_dir, name + '_cut.png')
        if os.path.exists(dst) and not FORCE:
            skipped += 1
            continue
        src = find_source(masters_dir, name)
        if src is None:
            print('skip master %s: no source art in %s' % (name, masters_dir))
            missing += 1
            continue
        im = Image.open(src).convert('RGBA')
        out = remove(im, session=session_for(name))
        save_optimized(out, dst)
        made += 1
        print('cutout: %s' % dst)

    print('done. %d generated, %d already present, %d without source art.'
          % (made, skipped, missing))
    print('     (targets: %d cards + %d masters)' % (len(ENEMY_IDS), len(MASTERS)))


if __name__ == '__main__':
    main()
