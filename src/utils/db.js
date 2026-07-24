const path = require('path');
const fs = require('fs');
const betterSqlite3 = require('better-sqlite3');
const { app } = require('@electron/remote');

// 系統初始化與設定 (System Init)
// 基礎路徑: 打包後為 exe 所在資料夾, 開發時為專案根目錄
const basePath = app.isPackaged
    ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
    : path.join(__dirname, '../../');

// 關鍵檔案路徑
const dbPath = path.join(basePath, 'data', 'my_collection.sqlite');
const worksImgDir = path.join(basePath, 'user_images', 'works');
const actorsImgDir = path.join(basePath, 'user_images', 'actors');

// 確保必要的資料夾存在
[path.dirname(dbPath), worksImgDir, actorsImgDir].forEach(dir => {
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

// 舊版資料庫的欄位補齊清單 (新建的資料庫由下方 CREATE TABLE 直接帶入完整結構)。
// alertLabel 表示該欄位為關鍵欄位, 升級失敗時提示使用者以利除錯。
const ACTOR_MIGRATIONS = [
    { name: 'is_favorite', type: 'INTEGER DEFAULT 0' },
    { name: 'aliases', type: 'TEXT', alertLabel: 'aliases' },
    { name: 'birthdate', type: 'TEXT' },
    { name: 'sizes', type: 'TEXT' },
    { name: 'av_period', type: 'TEXT' },
    { name: 'name_reading', type: 'TEXT' },
    { name: 'tags', type: 'TEXT' },
    { name: 'scrape_failed', type: 'INTEGER DEFAULT 0' },
    // source_url: 自動抓取來源網址 (使用者可編輯)
    { name: 'source_url', type: 'TEXT' },
    // custom_aliases: 合併來源名 / 使用者手動輸入; 抓取流程不會覆蓋此欄位
    { name: 'custom_aliases', type: 'TEXT' }
];

const WORK_MIGRATIONS = [
    { name: 'notes', type: 'TEXT DEFAULT ""' }
];

const SCHEMA_SQL = `
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
        notes TEXT DEFAULT ""
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
`;

// 讀取資料表現有欄位名稱
function tableColumns(table) {
    try {
        return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    } catch (e) {
        console.error(`Migration Error (read ${table} schema):`, e);
        return [];
    }
}

// 補上舊版資料庫缺少的欄位; 回傳補齊後的欄位清單
function migrateColumns(table, migrations) {
    const columns = tableColumns(table);
    for (const { name, type, alertLabel } of migrations) {
        if (columns.includes(name)) continue;
        try {
            db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
            columns.push(name);
            console.log(`Migration Success: Added ${table}.${name} column`);
        } catch (e) {
            console.error(`Migration Error (${table}.${name}):`, e);
            if (alertLabel) alert(`資料庫升級失敗 (${alertLabel}): ${e.message}\n請嘗試重啟軟體。`);
        }
    }
    return columns;
}

// 資料庫表格初始化: 先建立缺少的資料表, 再補齊舊資料表缺少的欄位
function initDB() {
    if (!db) return;
    try {
        db.exec(SCHEMA_SQL);

        const hadCustomAliases = tableColumns('actors').includes('custom_aliases');
        const actorColumns = migrateColumns('actors', ACTOR_MIGRATIONS);

        // 首次升級: 將既有 aliases 複製一份到 custom_aliases,
        // 避免既有(可能為手動輸入)別名在下次抓取覆蓋 aliases 時遺失
        if (!hadCustomAliases && actorColumns.includes('custom_aliases')) {
            try {
                db.prepare("UPDATE actors SET custom_aliases = aliases WHERE aliases IS NOT NULL AND TRIM(aliases) != ''").run();
            } catch (e) { console.error('Migration Error (custom_aliases copy):', e); }
        }

        migrateColumns('works', WORK_MIGRATIONS);
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
    actorsImgDir
};
