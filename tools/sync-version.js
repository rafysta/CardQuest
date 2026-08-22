/* js/version.js の APP_VERSION を version.json に同期する
 * 使い方: node tools/sync-version.js
 * リリース前に必ず実行してください(version.json がサーバー側の更新検出に使われます)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'js/version.js'), 'utf8');

const version = (src.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
const build = (src.match(/APP_BUILD\s*=\s*'([^']+)'/) || [])[1];
if (!version || !build) {
  console.error('APP_VERSION / APP_BUILD を js/version.js から読み取れません');
  process.exit(1);
}

const firstEntry = (src.match(/version:\s*'([^']+)'/) || [])[1];
if (firstEntry !== version) {
  console.error(`⚠ CHANGELOG の先頭 (${firstEntry}) と APP_VERSION (${version}) が一致しません`);
  process.exit(1);
}

fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version, build }, null, 2) + '\n');
console.log(`✓ version.json を v${version} (${build}) に更新しました`);

// index.html のローカルJS/CSS参照に ?v=バージョン を付与する
const idxPath = path.join(root, 'index.html');
let html = fs.readFileSync(idxPath, 'utf8');
let stamped = 0;
html = html.replace(/(src|href)="((?:js|css)\/[^"?]+)(?:\?v=[^"]*)?"/g,
  (_, attr, file) => { stamped++; return `${attr}="${file}?v=${version}"`; });
fs.writeFileSync(idxPath, html);
console.log(`✓ index.html の ${stamped} 個のファイル参照に ?v=${version} を付与しました`);

// sw.js の CACHE_VERSION も上げる(古いキャッシュを確実に捨てるため)
const swPath = path.join(root, 'sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE_VERSION = 'cardquest-v(\d+)'/,
  (_, n) => `const CACHE_VERSION = 'cardquest-v${Number(n) + 1}'`);
fs.writeFileSync(swPath, sw);
console.log('✓ sw.js の CACHE_VERSION を1つ進めました');
