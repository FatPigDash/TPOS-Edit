/*
 * sync-config.js
 * --------------------------------------------------------------
 * 讀取根目錄的 app.config.json，並將軟體名稱/版次同步套用到：
 *   1. package.json -> version (semver) 與 build.productName (打包檔名用)
 *   2. src/version.js -> 提供 main.js / renderer.js 顯示用的標題字串
 *   3. src/index.html -> <title> 標籤
 *
 * 此腳本會在 `npm start` 與 `npm run build` 前自動執行 (prestart / prebuild)，
 * 一般情況下不需要手動執行。
 * --------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const configPath = path.join(rootDir, 'app.config.json');
const pkgPath = path.join(rootDir, 'package.json');
const versionJsPath = path.join(rootDir, 'src', 'version.js');
const indexHtmlPath = path.join(rootDir, 'src', 'index.html');

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const { appName, appAbbr, displayVersion } = config;

if (!appName || !appAbbr || !displayVersion) {
  throw new Error('app.config.json 缺少必要欄位 (appName / appAbbr / displayVersion)');
}

// package.json 的 version 欄位需為 semver 格式，去掉開頭的 v/V (例如 "V3.0.1" -> "3.0.1")
const semverVersion = displayVersion.replace(/^v/i, '');
const fullTitle = `${appName} (${displayVersion})`;
const productName = `${appAbbr} ${displayVersion}`;

// 1. 更新 package.json (version 與打包用的 productName)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
pkg.version = semverVersion;
pkg.build = pkg.build || {};
pkg.build.productName = productName;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

// 2. 產生 src/version.js (給程式內部顯示用，例如視窗標題)
const versionJsContent = `// =============================================================
// 此檔案由 scripts/sync-config.js 自動產生，請勿手動修改！
// 若要變更軟體名稱或版次，請編輯根目錄的 app.config.json
// =============================================================
module.exports = {
  appName: ${JSON.stringify(appName)},
  appAbbr: ${JSON.stringify(appAbbr)},
  displayVersion: ${JSON.stringify(displayVersion)},
  fullTitle: ${JSON.stringify(fullTitle)}
};
`;
fs.writeFileSync(versionJsPath, versionJsContent, 'utf-8');

// 3. 更新 src/index.html 的 <title> 標籤
let html = fs.readFileSync(indexHtmlPath, 'utf-8');
html = html.replace(/<title>.*<\/title>/, `<title>${fullTitle}</title>`);
fs.writeFileSync(indexHtmlPath, html, 'utf-8');

console.log(`[sync-config] 已套用設定 -> 名稱: "${fullTitle}", 打包檔名: "${productName} Portable.exe"`);
