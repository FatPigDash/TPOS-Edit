# TPOS (The Pile of Shame) 開發說明

## 1. 安裝環境與套件

開發環境需求：

- Node.js（建議 v18 以上）與 npm
- Windows（本專案打包目標為 Windows portable exe）

安裝專案套件：

```bash
npm install
```

> `npm install` 完成後會自動執行 `postinstall`（`electron-builder install-app-deps`），
> 用於重新編譯 `better-sqlite3` 等原生模組以對應 Electron 版本。
> 若原生模組仍有問題，可手動執行：
>
> ```bash
> npm run rebuild
> ```

## 2. 測試啟動與打包指令

### 測試階段（啟動應用程式）

```bash
npm start
```

### 打包（產生 Windows portable exe）

```bash
npm run build
```

兩者皆會在執行前自動套用 `app.config.json` 中設定的軟體名稱與版次
（透過 `prestart` / `prebuild` 自動執行 `scripts/sync-config.js`），
不需手動同步。

## 3. 修改軟體名稱與版次

請編輯根目錄的設定檔：

```
app.config.json
```

此檔案內容：

```json
{
  "appName": "The Pile of Shame",
  "appAbbr": "TPOS",
  "displayVersion": "V3.0.1"
}
```

- `appName`：軟體完整名稱（顯示於視窗標題、導覽列）
- `appAbbr`：軟體簡稱（用於打包檔名）
- `displayVersion`：版次（顯示於標題，並用於打包檔名與 `package.json` 版本號）

修改後存檔，下次執行 `npm start` 或 `npm run build` 時會自動套用到：

- 視窗標題（`src/main.js`）與導覽列標題（`src/renderer.js`）— 透過自動產生的 `src/version.js`
- 網頁標題 `src/index.html` 的 `<title>`
- `package.json` 的 `version` 與 `build.productName`（決定打包檔名）

**不需要再手動修改其他檔案。**

## 4. 連結並播放資料夾內的影片

作品詳細頁的標頭新增「播放影片」按鈕，點選後會：

1. 以軟體所在路徑為根目錄（開發時為專案根目錄、打包後為 exe 所在資料夾），
   遞迴掃描根目錄內所有影片檔（含最底層子資料夾）。
2. 以作品識別碼（`work_number`）比對檔名中 `[ ]` 內的資訊（不分大小寫，亦容許省略連字號）。
3. 若同一識別碼有多個檔案，再以作品名稱與檔名做相似度比對：
   - 能唯一判定最佳檔案時，直接播放。
   - 無法唯一判定（多個同分）時，彈出清單供手動選擇。
   - 完全找不到符合檔案時，會提示無影片。
4. 預設以 PotPlayer 播放選定影片。

### PotPlayer 路徑設定

播放時會依下列順序尋找 PotPlayer 執行檔：

1. 環境變數 `TPOS_POTPLAYER`
2. 軟體根目錄 `app.config.json` 的 `potplayerPath` 欄位
3. 常見安裝路徑（`C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe` 等）

若皆找不到，會提示請於 `app.config.json` 設定 `potplayerPath`。範例：

```json
{
  "appName": "The Pile of Shame",
  "appAbbr": "TPOS",
  "displayVersion": "V6.4.0",
  "potplayerPath": "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe"
}
```

> 打包後若需自訂路徑，請在 exe 所在資料夾放置含 `potplayerPath` 的 `app.config.json`，
> 或設定 `TPOS_POTPLAYER` 環境變數。

## 5. 打包後檔案位置

執行 `npm run build` 後，輸出的 portable exe 會位於專案根目錄的：

```
dist/
```

檔名格式為：

```
{appAbbr} {displayVersion} Portable.exe
```

例如目前設定（`TPOS` / `V3.0.1`）會產生：

```
dist/TPOS V3.0.1 Portable.exe
```
