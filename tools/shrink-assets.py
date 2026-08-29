#!/usr/bin/env python3
"""CardQuest — 表示サイズに対して大きすぎる絵を縮める（2026-08-29）

発注した絵は 1024×1024 などの原寸で入っているが、実際の表示は
マスのアイコンなら約90px角、プレイヤーのコマなら100×130px しかない。
そのままだと起動時に10MB近く読み込むことになり、タブレットでは
「画面が固まった」ように見える（本人指摘）。

**表示サイズの3〜4倍**を上限に縮める。高精細な画面でも粗く見えない範囲で、
読み込み量を1/4以下にできる。元の絵はgitの履歴に残るので、やり直したくなったら
`git checkout <前のコミット> -- assets/...` で戻せる。

    python3 tools/shrink-assets.py          # 実行（上書き）
    python3 tools/shrink-assets.py --dry    # 何がどう変わるかだけ出す

絵を新しく発注して差し替えたら、そのたびに実行してよい（すでに小さい絵は触らない）。
"""
import os
import sys
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# (パス, 長辺の上限px, 用途のメモ)
TARGETS = [
    ('assets/map/icon_chest.png', 384, 'マスのアイコン（表示 約90px角）'),
    ('assets/map/icon_shop.png',  384, 'マスのアイコン（表示 約90px角）'),
    ('assets/map/icon_rest.png',  384, 'マスのアイコン（表示 約90px角）'),
    ('assets/map/icon_cash.png',  384, 'マスのアイコン（表示 約90px角）'),
    ('assets/map/player.png',     384, 'プレイヤーのコマ（表示 100×130px）'),
    ('assets/chars/amber_calm.png', 512, 'アンバーの肖像（表示 125px／目覚めは300px）'),
    ('assets/chars/amber_down.png', 512, 'アンバーの肖像（表示 125px／目覚めは300px）'),
    # 背景は画面幅ちょうど（1280）まで。マップは1280×800固定なのでこれ以上は絶対に見えない
    ('assets/map/bg_grassland.png', 1280, 'マップ背景（表示 1280px幅）'),
    ('assets/map/bg_forest.png',    1280, 'マップ背景（表示 1280px幅）'),
]

def main():
    dry = '--dry' in sys.argv
    total_before = total_after = 0
    for rel, cap, note in TARGETS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print(f'  skip (無い): {rel}')
            continue
        before = os.path.getsize(path)
        im = Image.open(path)
        w, h = im.size
        if max(w, h) <= cap:
            print(f'  そのまま: {rel} ({w}x{h}, {before/1024:.0f}KB) — すでに小さい')
            total_before += before
            total_after += before
            continue
        scale = cap / max(w, h)
        new = (max(1, round(w * scale)), max(1, round(h * scale)))
        if not dry:
            im.convert('RGBA' if im.mode in ('RGBA', 'LA', 'P') else 'RGB') \
              .resize(new, Image.LANCZOS) \
              .save(path, optimize=True)
        after = os.path.getsize(path) if not dry else before
        total_before += before
        total_after += after
        arrow = '→(dry)' if dry else '→'
        print(f'  {rel}: {w}x{h} {before/1024:.0f}KB {arrow} {new[0]}x{new[1]} '
              f'{after/1024:.0f}KB   … {note}')
    print(f'\n合計 {total_before/1024/1024:.2f}MB → {total_after/1024/1024:.2f}MB')

if __name__ == '__main__':
    main()
