// 2. 工具函式 (Utilities)

function getFileUrl(filePath) {
    if (!filePath) return null;
    // Windows path fix
    return 'file://' + filePath.replace(/\\/g, '/');
}

function getNewActorNumber(db) {
    if (!db) return 'No.0000';
    try {
        const rows = db.prepare('SELECT actor_number FROM actors').all();
        let maxSeq = 0;
        rows.forEach(row => {
            if (row.actor_number && row.actor_number.startsWith('No.')) {
                const seq = parseInt(row.actor_number.replace('No.', ''), 10);
                if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
            }
        });
        return 'No.' + String(maxSeq + 1).padStart(4, '0');
    } catch (e) { return 'No.' + Date.now().toString().slice(-4); }
}

// 新增: 解析名稱與括號別名 (供 UI 與 批次功能共用)
// 支援半形 () 與全形 （） 括號
function parseNameWithAliases(rawName) {
    if (!rawName) return { name: '', aliases: [] };

    const extractedAliases = [];

    // 1. 提取括號內的內容 (半形與全形括號皆支援)
    const regex = /[（(]([^（()）]+)[)）]/g;
    let match;
    while ((match = regex.exec(rawName)) !== null) {
        const alias = match[1].trim();
        if (alias) extractedAliases.push(alias);
    }

    // 2. 移除括號與內容，取得乾淨的主名稱
    const cleanName = rawName.replace(/\s*[（(][^（()）]+[)）]/g, '').trim();

    return {
        name: cleanName || rawName.trim(), // 如果刪光了(罕見)，就回傳原字串
        aliases: extractedAliases
    };
}

// 正規化字串以利比對:
//  - NFKC: 全形英數/符號/半形片假名 → 標準形 (例: （）→(), ／→/, ﾓﾘ→モリ)
//  - 片假名 → 平假名 (使假名寫法一致)
//  - 轉小寫、移除空白與常見分隔/註記符號
// 注意: 漢字與假名之間無法自動轉換 (例: 加奈子 vs かなこ), 此為先天限制。
function normalizeForMatch(s) {
    if (!s) return '';
    let t = String(s).normalize('NFKC');
    // 片假名 (ァ-ヶ) → 平假名; 長音記號 ー 保留不變
    t = t.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
    t = t.toLowerCase();
    // 移除空白、括號與常見分隔符號, 只保留識別用字元
    t = t.replace(/[\s()（）・･\/／,，、。.'’"”\-—_]/g, '');
    return t;
}

// 尾端「讀音」括號 (內含 "/" 的那組, 形如「かな / romaji」)
const READING_SUFFIX_RE = /\s*[（(]([^（()）]*[\/／][^（()）]*)[)）]\s*$/;

// 由單一別名條目取出可比對的名稱片段
// 例: "浅倉彩菜（舞ワイフ） （あさくらあやな / Asakura Ayana）"
//   -> ["あさくらあやな", "Asakura Ayana", "浅倉彩菜（舞ワイフ）", "浅倉彩菜"]
function aliasEntryTokens(entry) {
    const tokens = [];
    const trimmed = (entry || '').trim();
    if (!trimmed) return tokens;

    // 取出尾端讀音 (かな 與 romaji 分開加入)
    const readingMatch = trimmed.match(READING_SUFFIX_RE);
    if (readingMatch) {
        readingMatch[1].split(/[\/／]/).forEach(p => { const v = p.trim(); if (v) tokens.push(v); });
    }

    // 去掉尾端讀音後的主體 (可能仍含 studio 註記, 如「（舞ワイフ）」)
    const body = trimmed.replace(READING_SUFFIX_RE, '').trim();
    if (body) {
        tokens.push(body);
        // 再去掉所有括號註記, 取得純藝名
        const bare = body.replace(/\s*[（(][^（()）]*[)）]/g, '').trim();
        if (bare && bare !== body) tokens.push(bare);
    } else {
        tokens.push(trimmed);
    }
    return tokens;
}

// 取得某演員「姓名」欄位可用於比對的正規化 token
function actorNameTokens(actor) {
    const set = new Set();
    const parsed = parseNameWithAliases(actor.name || '');
    for (const s of [actor.name, parsed.name, ...parsed.aliases]) {
        const n = normalizeForMatch(s);
        if (n) set.add(n);
    }
    // name_reading (例: "もりさわかな / Morisawa kana"): 讀音 (かな / romaji) 也納入比對,
    // 讓純假名 / 羅馬拼音的輸入也能命中主藝名。
    if (actor.name_reading) {
        for (const part of actor.name_reading.split(/[\/／]/)) {
            const n = normalizeForMatch(part);
            if (n) set.add(n);
        }
    }
    return set;
}

// 取得某演員「別名」欄位可用於比對的正規化 token
// 同時涵蓋自動抓取的 aliases 與自訂的 custom_aliases。
function actorAliasTokens(actor) {
    const set = new Set();
    for (const col of [actor.aliases, actor.custom_aliases]) {
        if (!col) continue;
        for (const entry of col.split(/[,，]/)) {
            for (const t of aliasEntryTokens(entry)) {
                const n = normalizeForMatch(t);
                if (n) set.add(n);
            }
        }
    }
    return set;
}

// 智慧比對演員 (核心邏輯更新)
// 以正規化 (全半形 / 片假名平假名 / 讀音註記) 後的字串比對, 提升「別名同一人」的辨識率。
// 先以「姓名」欄位比對 (優先), 再以「別名」欄位比對。
function findSmartMatchActor(db, rawName) {
    if (!db || !rawName) return null;

    // 1. 產生候選關鍵字 (原始輸入 + 主名稱 + 括號別名), 全部正規化去重
    const parsed = parseNameWithAliases(rawName);
    const candSet = new Set();
    for (const c of [rawName, parsed.name, ...parsed.aliases]) {
        const n = normalizeForMatch(c);
        if (n) candSet.add(n);
    }
    if (candSet.size === 0) return null;

    const actors = db.prepare('SELECT id, name, aliases, name_reading, custom_aliases FROM actors WHERE is_deleted = 0').all();

    // 2-1. 先以「姓名」欄位比對 (優先)
    for (const actor of actors) {
        for (const tok of actorNameTokens(actor)) {
            if (candSet.has(tok)) return actor.id;
        }
    }
    // 2-2. 再以「別名」欄位比對
    for (const actor of actors) {
        for (const tok of actorAliasTokens(actor)) {
            if (candSet.has(tok)) return actor.id;
        }
    }

    return null; // 真的找不到
}

function getOrCreateActorId(db, name) {
    if (!db) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    // V1.3.0 更新: 使用智慧比對邏輯
    // 1. 先嘗試尋找是否存在 (包含別名、括號分析)
    const existingId = findSmartMatchActor(db, trimmed);
    if (existingId) return existingId;

    // 2. 若真的不存在，則建立新演員
    // 注意: 這裡我們仍然儲存原始的完整名稱 (包含括號)，讓使用者後續決定是否編輯
    // 若希望自動拆解，需在呼叫端處理，或是修改此處。
    // 依據目前需求，自動拆解是在「UI手動新增」與「批次按鈕」觸發，Scraper 匯入暫保持原樣以免誤判
    const actorNumber = getNewActorNumber(db);
    const info = db.prepare('INSERT INTO actors (actor_number, name, created_at, is_favorite) VALUES (?, ?, ?, 0)').run(actorNumber, trimmed, Date.now());
    return info.lastInsertRowid;
}

// 搜尋語法解析器 (+為AND, | 為OR, -為NOT)
function parseSearchQuery(input, dbField) {
    if (!input || !input.trim()) return { sql: "", params: [] };
    const orGroups = input.split(' | ');
    const sqlParts = [];
    const params = [];

    orGroups.forEach(group => {
        const tokens = group.split(/([+\-])/); // 保留分隔符
        const groupConditions = [];
        let currentOp = '+';

        tokens.forEach(token => {
            const trimmed = token.trim();
            if (!trimmed) return;
            if (trimmed === '+' || trimmed === '-') {
                currentOp = trimmed;
            } else {
                if (currentOp === '-') {
                    groupConditions.push(`${dbField} NOT LIKE ?`);
                    params.push(`%${trimmed}%`);
                } else {
                    groupConditions.push(`${dbField} LIKE ?`);
                    params.push(`%${trimmed}%`);
                }
            }
        });

        if (groupConditions.length > 0) {
            sqlParts.push(`(${groupConditions.join(' AND ')})`);
        }
    });

    if (sqlParts.length === 0) return { sql: "", params: [] };
    return { sql: ` AND (${sqlParts.join(' OR ')})`, params: params };
}

// 識別碼專用搜尋解析器: 空格切分段落，只有段落開頭的 - 才視為 NOT
function parseCodeSearchQuery(input, dbField) {
    if (!input || !input.trim()) return { sql: "", params: [] };
    // 先以 ' | ' 切出 OR 群組
    const orGroups = input.split(' | ');
    const sqlParts = [];
    const params = [];

    orGroups.forEach(group => {
        // 以空格切分 token，每個 token 整體判斷前綴
        const tokens = group.trim().split(/\s+/).filter(t => t);
        const groupConditions = [];

        tokens.forEach(token => {
            if (token === '|') return; // 忽略殘餘 | 符號
            if (token.startsWith('-') && token.length > 1) {
                // 開頭 - 視為 NOT，剩餘部分為搜尋字串
                const val = token.slice(1);
                groupConditions.push(`${dbField} NOT LIKE ?`);
                params.push(`%${val}%`);
            } else if (token.startsWith('+') && token.length > 1) {
                // 開頭 + 明確 AND，剩餘部分為搜尋字串
                const val = token.slice(1);
                groupConditions.push(`${dbField} LIKE ?`);
                params.push(`%${val}%`);
            } else {
                groupConditions.push(`${dbField} LIKE ?`);
                params.push(`%${token}%`);
            }
        });

        if (groupConditions.length > 0) {
            sqlParts.push(`(${groupConditions.join(' AND ')})`);
        }
    });

    if (sqlParts.length === 0) return { sql: "", params: [] };
    return { sql: ` AND (${sqlParts.join(' OR ')})`, params: params };
}

// 計算高對比文字顏色 (YIQ公式): 依背景色回傳黑或白文字色
function getContrastYIQ(hexcolor) {
    if (!hexcolor || typeof hexcolor !== 'string') return '#333333';
    let hex = hexcolor.replace('#', '');
    if (hex.length === 3) {
        hex = hex.split('').map(char => char + char).join('');
    }
    if (hex.length !== 6) return '#333333';
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#ffffff';
}

function hexToRgb(hex) {
    if (!hex) return '無顏色';
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const bigint = parseInt(hex, 16);
    if (isNaN(bigint)) return '無顏色';
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `R:${r} G:${g} B:${b}`;
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.tag-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

const stopPropagation = (e) => { e.stopPropagation(); };

module.exports = {
    getFileUrl,
    getNewActorNumber,
    getOrCreateActorId,
    findSmartMatchActor,
    parseNameWithAliases, // Export New Function
    parseSearchQuery,
    parseCodeSearchQuery,
    getContrastYIQ,
    hexToRgb,
    getDragAfterElement,
    stopPropagation
};