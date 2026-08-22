# CardQuest

SOUL GATE ver1.16（2003年・RPGツクール2000製フリーゲーム）の**カードバトル部分だけ**を取り出して、
タブレットで快適に遊ぶために作り直したものです。

- 想定端末：**Galaxy Tab S11**（11.0インチ・2560×1600・16:10）を**横向き**で使用
- 画面設計の基準：**1280 × 800 CSS px**（スクロールなしで収まるよう組んでいます）
- 完全な静的サイト。サーバー側の処理はありません。GitHub Pages で配信します。

> 原作の**ルールと数値**（カードの攻撃力・効果・デッキ構成など）を参考にした独自実装です。
> 原作の画像・音楽・プログラムは一切含みません。

---

## 遊び方（タブレット）

1. ブラウザで `https://rafysta.github.io/CardQuest/` を開く
2. Chrome のメニュー →「ホーム画面に追加」
3. 以後はホーム画面のアイコンから起動（全画面・横向き固定）

## 更新のしかた

confquest と同じ仕組みです。**タブレット側の操作は「更新」を押すだけ**です。

```
[PC] js/version.js の APP_VERSION と CHANGELOG を書く
  ↓
[PC] node tools/sync-version.js      ← version.json と ?v= と sw.js を自動で揃える
  ↓
[PC] git add -A && git commit -m "..." && git push
  ↓
[タブレット] アプリを開く → 上部に「新しいバージョン v◯ があります [更新]」が出る
  ↓          「更新」を押す → キャッシュとService Workerを全消去して再取得
```

仕組みの要点：

| ファイル | 役割 |
|---|---|
| `js/version.js` | `APP_VERSION` と更新履歴。**ここだけを手で書く** |
| `version.json` | サーバー上の最新版。起動時にキャッシュ抜きで取得して比較する |
| `tools/sync-version.js` | `version.json` の更新、`index.html` の `?v=` 付与、`sw.js` の `CACHE_VERSION` 繰り上げ |
| `js/update.js` | 起動時の版チェック、「更新」バーの表示、Service Worker の登録 |
| `sw.js` | オフライン用のキャッシュ。同一オリジンは常にネット優先（`cache:'no-store'`）で、古いファイルが残らない |

## カードの絵を足す

`assets/cards/<カードID>.png` を置くだけです。プログラムの修正は不要で、置いたカードから順に絵が出ます。
詳しくは [`assets/cards/README.md`](assets/cards/README.md) を参照してください。

## フォルダ構成

```
CardQuest/
  index.html            画面（バトル／デッキ編集／説明）
  css/style.css         レイアウトと配色
  js/data.js            カード169種とデッキのデータ（原作データから抽出）
  js/version.js         バージョンと更新履歴
  js/layout.js          画面の描画（v0.1 はレイアウト確認用のモックアップ）
  js/update.js          更新チェックとService Worker登録
  sw.js                 Service Worker
  manifest.json         PWA設定（全画面・横向き）
  version.json          サーバー上の最新版（自動生成）
  tools/sync-version.js リリース準備スクリプト
  assets/cards/         カードの絵（後から足せます）
  docs/                 設計メモ・画面イメージ
```

## 現在の状態

**v0.1.0 はレイアウト確認用**です。まだ対戦はできません。
画面の配置・文字の大きさ・色を確定させてから、ゲーム部分を組み込みます。

## 元データについて

カードの数値と入手方法は、配布アーカイブの `RPG_RT.ldb` / `Map*.lmu` を
[liblcf](https://github.com/EasyRPG/liblcf) の `lcf2xml` で変換して抽出しました。
原作の配布元：<https://www.vector.co.jp/soft/win95/game/se280880.html>
