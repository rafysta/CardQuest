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
except ImportError:
    print("rembg / Pillow が見つかりません。")
    print("  pip install rembg onnxruntime --break-system-packages")
    sys.exit(1)

# マップ上での表示は最大でも ~140px（マップ仕様書§4）。1024角のまま置くと1枚1MB近くなるため、
# 512角に落としてから pngquant で圧縮する（見た目の劣化は表示サイズでは分からない）。
CUTOUT_SIZE = 512
HAS_PNGQUANT = shutil.which('pngquant') is not None


def save_optimized(im, dst):
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

# js/run/areas.js の CQAreas.enemyPool() の出力をエリアごとに合算した一覧（2026-08-26 時点）。
# 草原: 8,7,23,24,32,41,1,29,33,21,70
# 森  : 28,23,27,31,44,5,25,33,68,65,67,35
ENEMY_IDS = sorted(set([
    1, 5, 7, 8, 21, 23, 24, 25, 27, 28, 29, 31, 32, 33, 35, 41, 44, 65, 67, 68, 70,
]))

# assets/masters/<name>.png → assets/masters/<name>_cut.png
MASTERS = ['m_grassland', 'm_forest']


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
