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
        // actors 表欄位遷移: 以單次 PRAGMA 讀取現有欄位, 缺少者才 ALTER 補上
        // (actors 表可能尚未建立, 讀取失敗時視為無欄位, 後續 CREATE TABLE 會補齊完整結構)
        let actorCols = [];
        try {
            actorCols = db.prepare("PRAGMA table_info(actors)").all().map(c => c.name);
        } catch (e) {
            console.error("Migration Error (read actors schema):", e);
        }
        const addActorColumnIfMissing = (name, sql, alertLabel) => {
            if (actorCols.includes(name)) return;
            try {
                db.prepare(sql).run();
                actorCols.push(name);
                console.log(`Migration Success: Added ${name} column`);
            } catch (e) {
                console.error(`Migration Error (${name}):`, e);
                // aliases 為關鍵欄位, 升級失敗時提示使用者以利除錯
                if (alertLabel) alert(`資料庫升級失敗 (${alertLabel}): ${e.message}\n請嘗試重啟軟體。`);
            }
        };

        // V1.2.x: is_favorite / V1.3.0: aliases / V1.6.0: 個人檔案欄位 / V1.7.0: scrape_failed
        addActorColumnIfMissing('is_favorite', "ALTER TABLE actors ADD COLUMN is_favorite INTEGER DEFAULT 0");
        addActorColumnIfMissing('aliases', "ALTER TABLE actors ADD COLUMN aliases TEXT", 'aliases');
        addActorColumnIfMissing('birthdate', "ALTER TABLE actors ADD COLUMN birthdate TEXT");
        addActorColumnIfMissing('sizes', "ALTER TABLE actors ADD COLUMN sizes TEXT");
        addActorColumnIfMissing('av_period', "ALTER TABLE actors ADD COLUMN av_period TEXT");
        addActorColumnIfMissing('name_reading', "ALTER TABLE actors ADD COLUMN name_reading TEXT");
        addActorColumnIfMissing('tags', "ALTER TABLE actors ADD COLUMN tags TEXT");
        addActorColumnIfMissing('scrape_failed', "ALTER TABLE actors ADD COLUMN scrape_failed INTEGER DEFAULT 0");
        // V1.8.0: source_url (自動抓取來源網址, 使用者可編輯)
        addActorColumnIfMissing('source_url', "ALTER TABLE actors ADD COLUMN source_url TEXT");
        // 自訂別名 custom_aliases: 合併來源名 / 使用者手動輸入; 抓取流程不會覆蓋此欄位
        const hadCustomAliases = actorCols.includes('custom_aliases');
        addActorColumnIfMissing('custom_aliases', "ALTER TABLE actors ADD COLUMN custom_aliases TEXT");
        // 首次升級: 將既有 aliases 複製一份到 custom_aliases,
        // 避免既有(可能為手動輸入)別名在下次抓取覆蓋 aliases 時遺失
        if (!hadCustomAliases && actorCols.includes('custom_aliases')) {
            try {
                db.prepare("UPDATE actors SET custom_aliases = aliases WHERE aliases IS NOT NULL AND TRIM(aliases) != ''").run();
            } catch (e) { console.error('Migration Error (custom_aliases copy):', e); }
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
                tags TEXT,
                scrape_failed INTEGER DEFAULT 0,
                custom_aliases TEXT,
                source_url TEXT
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