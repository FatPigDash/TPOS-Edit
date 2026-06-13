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
    // 啟用 WAL 模式可以增加併發寫入的穩定性 (選用)
    db.pragma('journal_mode = WAL'); 
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
                console.log("Migration Success: Added is_favorite column");
            }
        } catch (e) { 
            console.error("Migration Error (is_favorite):", e); 
        }

        // V1.3.0 更新: 檢查並新增 actors 表的 aliases 欄位
        try {
            const tableInfo = db.prepare("PRAGMA table_info(actors)").all();
            const hasAliases = tableInfo.some(col => col.name === 'aliases');
            if (!hasAliases) {
                db.prepare("ALTER TABLE actors ADD COLUMN aliases TEXT").run();
                console.log("Migration Success: Added aliases column");
            }
        } catch (e) { 
            console.error("Migration Error (aliases):", e);
            // 讓使用者知道資料庫升級失敗，方便除錯
            alert("資料庫升級失敗 (aliases): " + e.message + "\n請嘗試重啟軟體。");
        }

        // V1.6.0 更新: 新增演員個人檔案欄位 (生年月日 / 三圍尺寸 / AV出演期間)
        try {
            const tableInfo = db.prepare("PRAGMA table_info(actors)").all();
            const newCols = [
                { name: 'birthdate', sql: "ALTER TABLE actors ADD COLUMN birthdate TEXT" },
                { name: 'sizes', sql: "ALTER TABLE actors ADD COLUMN sizes TEXT" },
                { name: 'av_period', sql: "ALTER TABLE actors ADD COLUMN av_period TEXT" },
                { name: 'name_reading', sql: "ALTER TABLE actors ADD COLUMN name_reading TEXT" },
                { name: 'tags', sql: "ALTER TABLE actors ADD COLUMN tags TEXT" }
            ];
            newCols.forEach(col => {
                if (!tableInfo.some(c => c.name === col.name)) {
                    db.prepare(col.sql).run();
                    console.log(`Migration Success: Added ${col.name} column`);
                }
            });
        } catch (e) {
            console.error("Migration Error (actor profile fields):", e);
        }

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
                rating REAL
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
                aliases TEXT,
                image_path TEXT,
                created_at INTEGER,
                is_deleted INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0,
                birthdate TEXT,
                sizes TEXT,
                av_period TEXT,
                name_reading TEXT,
                tags TEXT
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
    } catch (err) { 
        console.error('DB Init Failed:', err); 
        alert("資料庫初始化失敗: " + err.message);
    }
}

// 強制在載入時就執行初始化，確保欄位存在
initDB();

module.exports = {
    db,
    basePath,
    worksImgDir,
    actorsImgDir,
    initDB
};