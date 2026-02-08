const path = require('path');
const fs = require('fs');
const betterSqlite3 = require('better-sqlite3');
const { app } = require('@electron/remote');

// 1. 系統初始化與設定 (System Init)
// 設定基礎路徑
let basePath;
if (app.isPackaged) {
    basePath = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
} else {
    // 修正路徑層級以適應 src/utils 資料夾結構
    basePath = path.join(__dirname, '../../');
}

// 定義關鍵檔案路徑
const dbPath = path.join(basePath, 'data', 'my_collection.sqlite');
const worksImgDir = path.join(basePath, 'user_images', 'works');
const actorsImgDir = path.join(basePath, 'user_images', 'actors');

// 確保必要的資料夾存在
const dataDir = path.dirname(dbPath);
[dataDir, worksImgDir, actorsImgDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            console.error("無法建立資料夾:" + dir, e);
        }
    }
});

// 資料庫連線
let db;
try {
    db = new betterSqlite3(dbPath);
} catch (err) {
    console.error('資料庫連線失敗', err);
    alert("資料庫連線失敗:" + err.message + "\n路徑:" + dbPath);
}

// 資料庫表格初始化 (Schema Definition)
function initDB() {
    if (!db) return;
    try {
        // V1.2.x 更新: 檢查並新增 actors 表的 is_favorite 欄位
        try {
            const tableInfo = db.prepare("PRAGMA table_info(actors)").all();
            const hasFavorite = tableInfo.some(col => col.name === 'is_favorite');
            if (!hasFavorite) {
                db.prepare("ALTER TABLE actors ADD COLUMN is_favorite INTEGER DEFAULT 0").run();
            }
        } catch (e) { console.error("Migration Error (Actors):", e); }

        // V2.2.x 更新: 檢查並新增 works 表的 is_favorite 欄位 (待看關注)
        try {
            const tableInfo = db.prepare("PRAGMA table_info(works)").all();
            const hasWorkFavorite = tableInfo.some(col => col.name === 'is_favorite');
            if (!hasWorkFavorite) {
                db.prepare("ALTER TABLE works ADD COLUMN is_favorite INTEGER DEFAULT 0").run();
            }
        } catch (e) { console.error("Migration Error (Works):", e); }

        // 建立資料表
        db.exec(`
            CREATE TABLE IF NOT EXISTS tag_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                color TEXT
            );
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                color TEXT,
                is_visible INTEGER DEFAULT 1,
                FOREIGN KEY (group_id) REFERENCES tag_groups (id)
            );
            CREATE TABLE IF NOT EXISTS works (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                release_date TEXT,
                duration TEXT,
                resolution TEXT,
                work_number TEXT UNIQUE,
                created_at INTEGER,
                file_size TEXT,
                director TEXT,
                maker TEXT,
                publisher TEXT,
                rating REAL,
                is_favorite INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS work_images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                work_id INTEGER,
                file_name TEXT,
                sort_order INTEGER DEFAULT 0,
                is_cover INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS actors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_number TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                image_path TEXT,
                created_at INTEGER,
                is_deleted INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS work_actor_link (
                work_id INTEGER,
                actor_id INTEGER,
                actor_name TEXT,
                sort_order INTEGER DEFAULT 0,
                PRIMARY KEY (work_id, actor_id)
            );
            CREATE TABLE IF NOT EXISTS work_tag_link (
                work_id INTEGER,
                tag_id INTEGER,
                PRIMARY KEY (work_id, tag_id)
            );
            CREATE INDEX IF NOT EXISTS idx_actors_name ON actors (name);
            CREATE INDEX IF NOT EXISTS idx_works_name ON works (name);
            CREATE INDEX IF NOT EXISTS idx_works_number ON works (work_number);
        `);
    } catch (err) { console.error('DB Init Failed:', err); }
}

// 執行初始化，確保 Migration 邏輯被執行
initDB();

module.exports = {
    db,
    basePath,
    worksImgDir,
    actorsImgDir,
    initDB
};