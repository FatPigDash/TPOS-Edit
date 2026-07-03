/*
• TPOS (The Pile of Shame) 軟體開發 - Main Process
• 版本: V1.3.3
• 修正: 調整 get-video-metadata 回傳格式 (純數字時長), 加強錯誤處理
*/
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const remoteMain = require('@electron/remote/main');
const fs = require('fs');
const { spawn } = require('child_process');
// 引入 ffmpeg 與 ffprobe 相關套件
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static');
const { fullTitle } = require('./version');

// 設定 ffmpeg 與 ffprobe 執行檔路徑
// replace 是為了處理 Electron 打包後(asar)的路徑問題
const fixPath = (pathStr) => {
  return pathStr ? pathStr.replace('app.asar', 'app.asar.unpacked') : pathStr;
};

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(fixPath(ffmpegPath));
}

if (ffprobePath && ffprobePath.path) {
  ffmpeg.setFfprobePath(fixPath(ffprobePath.path));
} else {
  console.warn("警告: 找不到 ffprobe-static 路徑，影片資訊讀取功能可能失效。");
}

// 初始化 remote 模組
remoteMain.initialize();

const log = (msg) => console.log(`[Main]: ${msg}`);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: fullTitle, // 軟體名稱與版次集中於 app.config.json / src/version.js
    icon: path.join(__dirname, '../assets/icon.ico'),
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false
    }
  });

  remoteMain.enable(mainWindow.webContents);
  mainWindow.maximize();

  const indexPath = path.join(__dirname, 'index.html');
  mainWindow.loadFile(indexPath).catch(e => {
    log(`Failed to load HTML: ${e.message}`);
  });
}

// IPC: 讀取影片資訊
ipcMain.handle('get-video-metadata', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    if (!filePath) {
      reject(new Error("File path is empty"));
      return;
    }

    // 使用 ffprobe 讀取檔案
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error("FFprobe Error:", err);
        reject(new Error(`FFprobe failed: ${err.message}`));
        return;
      }
      
      try {
        // 尋找視訊軌
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        if (!videoStream) {
          reject(new Error("No video stream found"));
          return;
        }

        const width = videoStream.width;
        const height = videoStream.height;
        const durationSec = metadata.format.duration || videoStream.duration || 0;

        // 格式化解析度
        let resolution = `${width}x${height}`;
        if (width === 1920 && height === 1080) resolution = "1080p (FHD)";
        else if (width === 3840 && height === 2160) resolution = "4K (UHD)";
        else if (width === 1280 && height === 720) resolution = "720p (HD)";
        
        // 格式化時間 (四捨五入到分鐘)
        // 修改: 僅回傳數字，不帶單位
        const durationMinutes = Math.round(durationSec / 60);

        resolve({
          resolution: resolution,
          duration: durationMinutes
        });
      } catch (processErr) {
        console.error("Metadata Processing Error:", processErr);
        reject(processErr);
      }
    });
  });
});

// =============================================================
// 影片連結與播放功能 (Link & Play)
// 以軟體所在路徑為根目錄，遞迴掃描影片，依識別碼比對，並以 PotPlayer 播放
// =============================================================

// 支援的影片副檔名
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.wmv', '.mov', '.ts', '.m2ts', '.flv', '.rmvb', '.webm', '.iso', '.mpg', '.mpeg', '.m4v'];
// 掃描時略過的資料夾 (避免掃描套件/版控目錄)
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

// 取得軟體所在的根目錄 (打包後為 exe 所在資料夾，開發時為專案根目錄)
function getAppRoot() {
  if (app.isPackaged) {
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  return path.join(__dirname, '..');
}

// 遞迴掃描根目錄 (含最底層子資料夾) 取得所有影片檔絕對路徑
function walkVideoFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue; // 無權限或讀取失敗則略過該資料夾
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        if (VIDEO_EXTENSIONS.includes(path.extname(ent.name).toLowerCase())) {
          results.push(full);
        }
      }
    }
  }
  return results;
}

// 正規化識別碼字串供比對 (轉大寫、去空白)
function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '');
}

// 取出檔名中所有 [] 內的資訊
function extractBracketCodes(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const codes = [];
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(base)) !== null) {
    const v = m[1].trim();
    if (v) codes.push(v);
  }
  return codes;
}

// 判斷檔名的 [] 資訊是否符合指定識別碼
function fileMatchesCode(fileName, workNumber) {
  const target = normalizeCode(workNumber);
  if (!target) return false;
  const targetNoHyphen = target.replace(/-/g, '');
  return extractBracketCodes(fileName).some(code => {
    const n = normalizeCode(code);
    return n === target || n.replace(/-/g, '') === targetNoHyphen;
  });
}

// 取得檔名的標題部分 (移除 [] 與整理用後綴) 供與作品名稱比對
function getTitlePart(fileName) {
  let base = fileName.replace(/\.[^.]+$/, '');
  base = base.replace(/\[[^\]]*\]/g, ' ');
  base = base.replace(/-uncensored-leak|-chinese-subtitle/gi, ' ');
  return base.toLowerCase().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 最長共同子字串長度
function longestCommonSubstr(a, b) {
  if (!a || !b) return 0;
  let max = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > max) max = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = tmp;
    }
  }
  return max;
}

// 計算檔名標題與作品名稱的相似度分數 (0~100)
function scoreByName(fileName, workName) {
  const t = getTitlePart(fileName);
  const n = (workName || '').toLowerCase().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n || !t) return 0;
  if (t === n) return 100;
  if (t.includes(n) || n.includes(t)) return 60;
  const lcs = longestCommonSubstr(t, n);
  return Math.round((lcs / Math.max(n.length, 1)) * 40);
}

// 分段字尾偵測正規表示式: 結尾 空白/-/_/( + (cd|part|disc)? + 數字或單字母 + )?
const PART_SUFFIX_RE = /[\s\-_(]+(?:cd|part|disc|disk)?\s*(\d{1,3}|[a-z])\)?$/i;

// 偵測檔名版本類型 (無修正流出 / 中文字幕 / 一般), 供區分同識別碼但不同版本的影片
function detectVideoType(fileName) {
  const b = fileName.toLowerCase();
  if (b.includes('-uncensored-leak')) return 'uncensored-leak';
  if (b.includes('-chinese-subtitle')) return 'chinese-subtitle';
  return 'normal';
}

// 取得分段順序 (A→1、B→2、cd1→1...), 無分段字尾回傳 0
function getPartOrder(fileName) {
  const m = getTitlePart(fileName).match(PART_SUFFIX_RE);
  if (!m) return 0;
  const tok = m[1];
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  return tok.toLowerCase().charCodeAt(0) - 96; // a→1, b→2 ...
}

// 版本鍵: 去除分段字尾後的標題 + 版本類型, 用來把同一部作品的分段檔歸為一組
function getReleaseKey(fileName) {
  const title = getTitlePart(fileName).replace(PART_SUFFIX_RE, '').trim();
  return detectVideoType(fileName) + '|' + title;
}

// 讀取設定的 PotPlayer 路徑 (環境變數 > 根目錄 app.config.json > 常見安裝路徑)
function getPotPlayerPath() {
  if (process.env.TPOS_POTPLAYER && fs.existsSync(process.env.TPOS_POTPLAYER)) {
    return process.env.TPOS_POTPLAYER;
  }
  try {
    const cfgPath = path.join(getAppRoot(), 'app.config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.potplayerPath && fs.existsSync(cfg.potplayerPath)) return cfg.potplayerPath;
    }
  } catch (e) { /* 忽略設定檔解析錯誤 */ }

  const defaults = [
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayer64.exe',
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayer.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayer.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DAUM', 'PotPlayer', 'PotPlayerMini64.exe') : null
  ].filter(Boolean);
  for (const p of defaults) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// IPC: 依識別碼 (work_number) 與作品名稱尋找根目錄內符合的影片
// 回傳 groups: 同一部作品 (同版本) 的分段檔會被歸為一組, 依分段順序排序, 供依序播放
ipcMain.handle('find-work-videos', async (event, { workNumber, name }) => {
  const root = getAppRoot();
  if (!workNumber) return { root, candidates: [], groups: [], unique: false };

  const all = walkVideoFiles(root);
  const matched = all
    .filter(full => fileMatchesCode(path.basename(full), workNumber))
    .map(full => ({
      fileName: path.basename(full),
      relativePath: path.relative(root, full),
      absolutePath: full,
      score: scoreByName(path.basename(full), name),
      partOrder: getPartOrder(path.basename(full)),
      releaseKey: getReleaseKey(path.basename(full))
    }));

  // 依版本鍵分組: 同一部作品的分段檔歸為一組
  const groupMap = new Map();
  for (const f of matched) {
    if (!groupMap.has(f.releaseKey)) groupMap.set(f.releaseKey, []);
    groupMap.get(f.releaseKey).push(f);
  }

  const groups = Array.from(groupMap.values()).map(files => {
    files.sort((a, b) => a.partOrder - b.partOrder || a.fileName.localeCompare(b.fileName));
    return {
      files,
      paths: files.map(f => f.absolutePath),
      score: Math.max(...files.map(f => f.score)),
      isMultiPart: files.length > 1
    };
  });
  groups.sort((a, b) => b.score - a.score || a.files[0].relativePath.localeCompare(b.files[0].relativePath));

  // 攤平的候選 (相容用途)
  const candidates = matched.slice().sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  // 只有一個版本分組時視為唯一 (即使是多段, 也可直接依序播放)
  const unique = groups.length === 1;

  return { root, candidates, groups, unique };
});

// IPC: 以 PotPlayer 播放指定影片 (可傳單一路徑或路徑陣列; 多段時作為播放清單依序播放)
ipcMain.handle('play-video', async (event, filePath) => {
  try {
    const paths = (Array.isArray(filePath) ? filePath : [filePath]).filter(p => p && fs.existsSync(p));
    if (paths.length === 0) {
      return { ok: false, message: '影片檔不存在或已被移動' };
    }
    const exe = getPotPlayerPath();
    if (!exe) return { ok: false, reason: 'notfound' };

    const child = spawn(exe, paths, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error('PotPlayer 啟動失敗:', err.message));
    child.unref();
    return { ok: true, player: exe };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});