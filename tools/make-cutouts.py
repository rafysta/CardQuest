#!/usr/bin/env python3
"""CardQuest マップ表示用の敵・ボス切り抜き生成（開発時のみ実行）。

『CardQuest マップ仕様書』§4.1（2026-08-26改訂）：戦闘マスの敵・ボスは、カード絵／肖像から
本体を背景除去で切り抜いた絵をマス（台座タイル）の上に立たせて表示する。この切り抜きは
機械的な画像処理（rembg）で自動生成し、コミットしておく。ランタイム（run-ui.js）は
生成済みの assets/cutouts/<cardId>.png・assets/masters/m_<areaId>_cut.png を読み込むだけで、
rembg / onnxruntime への依存を持たない（切り抜きが無ければ従来表示にフォールバックする）。

使い方：
    pip install rembg onnxruntime --break-system-packages
    python3 tools/make-cutouts.py

エリアを追加した／敵プールが変わったときは ENEMY_IDS を
`node -e "..."`（js/run/areas.js の enemyPool() を呼ぶ）で再計算し、下の一覧を更新してから
再実行する。MASTERS も新エリアのボス肖像ファイル名（拡張子抜き）を追加する。
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

# M8.1 の敵プール（2026-09-06 更新）：
# 草原 + 森 + 山地 + 海辺 + 砂漠 + 荒野 の全エリアの敵カード ID
# 計算コマンド：
#   node -e "const fs=require('fs');const d=JSON.parse('['+fs.readFileSync('js/data.js','utf8').match(/const CARDS = \[([\s\S]*?)\];/)[1]+']');
#   ['草原','森','山地','海','砂漠','荒野'].forEach(t=>{const p=d.filter(c=>c.t==='U'&&c.id!==64&&c.p>0&&c.g.indexOf(t)>=0).sort((a,b)=>a.p-b.p);console.log(t+': '+p.map(c=>c.id).join(','))});"
ENEMY_IDS = sorted(set([
    1, 4, 5, 6, 7, 8, 9, 20, 21, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 36, 37, 40, 41, 42, 44, 45, 46, 47, 48, 49, 50, 51, 59, 65, 67, 68, 70,
]))

# assets/masters/<name>.png → assets/masters/<name>_cut.png
# M8.1 時点での新しいエリアのボス肖像を追加
MASTERS = ['m_grassland', 'm_forest', 'm_mountain', 'm_coast', 'm_desert']


def main():
    session = new_session('isnet-general-use')

    out_dir = os.path.join(ROOT, 'assets', 'cutouts')
    os.makedirs(out_dir, exist_ok=True)
    for cid in ENEMY_IDS:
        src = os.path.join(ROOT, 'assets', 'cards', '%d.png' % cid)
        if not os.path.exists(src):
            print('skip card %d: no source art at %s' % (cid, src))
            continue
        im = Image.open(src).convert('RGBA')
        out = remove(im, session=session)
        dst = os.path.join(out_dir, '%d.png' % cid)
        save_optimized(out, dst)
        print('cutout: %s' % dst)

    for name in MASTERS:
        src = os.path.join(ROOT, 'assets', 'masters', name + '.png')
        if not os.path.exists(src):
            print('skip master %s: no source art at %s' % (name, src))
            continue
        im = Image.open(src).convert('RGBA')
        out = remove(im, session=session)
        dst = os.path.join(ROOT, 'assets', 'masters', name + '_cut.png')
        save_optimized(out, dst)
        print('cutout: %s' % dst)

    print('done. %d card cutouts + %d master cutouts.' % (len(ENEMY_IDS), len(MASTERS)))


if __name__ == '__main__':
    main()
