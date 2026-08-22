/* CardQuest - バージョン情報と更新履歴 */
'use strict';

const APP_VERSION = '0.1.0';
const APP_BUILD = '2026-08-22';

/**
 * 更新履歴(新しい順)
 * type: 'new' 新機能 / 'fix' 修正 / 'change' 変更
 */
const CHANGELOG = [
  {
    version: '0.1.0',
    date: '2026-08-22',
    items: [
      { type: 'new', text: '🎴 CardQuest を作りました。SOUL GATE ver1.16 のカードバトル部分だけを、タブレットで遊ぶために作り直します' },
      { type: 'new', text: '📐 Galaxy Tab S11（横向き 1280×800）に合わせた画面レイアウト案を入れました。バトル画面・デッキ編集画面の見た目だけを確認できます' },
      { type: 'new', text: '🔄 confquest と同じ更新の仕組み（version.json ＋ Service Worker）を入れました。新しい版が出ると画面上部に「更新」ボタンが出ます' }
    ]
  }
];
