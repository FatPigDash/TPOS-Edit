/*
• TPOS (The Pile of Shame) 軟體開發 - Main Process
• 版本: V1.3.3
• 修正: 隱藏原生選單列以修復輸入框無法輸入文字的焦點問題 (Input Focus Fix)
*/
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const remoteMain = require('@electron/remote/main');
const fs = require('fs');
// 引入 ffmpeg 與 ffprobe 相關套件
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static'); // 新增這行

// 設定 ffmpeg 與 ffprobe 執行檔路徑
// replace 是為了處理 Electron 打包後(asar)的路徑問題
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath.replace('app.asar', 'app.asar.unpacked'));
}
if (ffprobePath && ffprobePath.path) {
  ffmpeg.setFfprobePath(ffprobePath.path.replace('app.asar', 'app.asar.unpacked')); // 新增這行
}

// 初始化 remote 模組
remoteMain.initialize();

const log = (msg) => console.log(`[Main]: ${msg}`);

let mainWindow;
let db;

function initDatabase() {
  try {
    let basePath;
    if (app.isPackaged) {
      basePath = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    } else {
      basePath = path.join(__dirname, '..');
    }
    const dbPath = path.join(basePath, 'data', 'my_collection.sqlite');
    log(`Connecting to database at: ${dbPath}`);
    
    // 確保 data 資料夾存在
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 這裡僅做連線測試與基本建立, 詳細 Schema 由 renderer 處理
    const tempDb = new Database(dbPath);
    log("Database check passed.");
    tempDb.close();
  } catch (error) {
    log(`Database Error: ${error.message}`);
    // dialog.showErrorBox 可能會阻擋啟動, 這裡僅記錄錯誤
    console.error(`無法連接資料庫: ${error.message}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "The Pile of Shame (V1.3.3)", // 更新標題
    autoHideMenuBar: true, // 修改: 自動隱藏選單列
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // 修改: 強制移除原生選單，解決 Windows 下 Alt 鍵導致的輸入框焦點卡死問題
  mainWindow.removeMenu();

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
    // 使用 ffprobe 讀取檔案
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error("FFprobe Error:", err);
        reject(err);
        return;
      }
      // 尋找視訊軌
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error("No video stream found"));
        return;
      }

      const width = videoStream.width;
      const height = videoStream.height;
      const durationSec = metadata.format.duration || videoStream.duration;

      // 格式化解析度
      let resolution = `${width}x${height}`;
      if (width === 1920 && height === 1080) resolution = "1080p (FHD)";
      else if (width === 3840 && height === 2160) resolution = "4K (UHD)";
      else if (width === 1280 && height === 720) resolution = "720p (HD)";
      else resolution = `${width}x${height}`; // 自訂格式

      // 格式化時間 (四捨五入到分鐘)
      // 若 125秒 = 2.08分 -> 2分
      // 若 150秒 = 2.5分 -> 3分
      const durationMinutes = Math.round(durationSec / 60);

      resolve({
        resolution: resolution,
        duration: `${durationMinutes}分鐘`
      });
    });
  });
});

app.whenReady().then(() => {
  initDatabase();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});