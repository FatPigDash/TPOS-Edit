// 工具函式 (Utilities)

function getFileUrl(filePath) {
    if (!filePath) return null;
    // Windows path fix
    return 'file://' + filePath.replace(/\\/g, '/');
}

// 以半形/全形逗號切分字串, 去除空白與空項目 (別名、標籤等欄位共用)
function splitList(str) {
    return (str || '').split(/[,，]/).map(s => s.trim()).filter(s => s);
}

// 反轉排序方向 (asc <-> desc)
function toggleSortDirection(order) {
    if (order.endsWith('_asc')) return order.slice(0, -4) + '_desc';
    if (order.endsWith('_desc')) return order.slice(0, -5) + '_asc';
    return order;
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

// 解析名稱與括號別名 (供 UI 與批次功能共用), 支援半形 () 與全形 （）
function parseNameWithAliases(rawName) {
    if (!rawName) return { name: '', aliases: [] };

    // 1. 提取括號內的內容
    const extractedAliases = [];
    const regex = /[（(]([^（()）]+)[)）]/g;
    let match;
    while ((match = regex.exec(rawName)) !== null) {
        const alias = match[1].trim();
        if (alias) extractedAliases.push(alias);
    }

    // 2. 移除括號與內容, 取得乾淨的主名稱 (若刪光了則回傳原字串)
    const cleanName = rawName.replace(/\s*[（(][^（()）]+[)）]/g, '').trim();

    return { name: cleanName || rawName.trim(), aliases: extractedAliases };
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
    return t.replace(/[\s()（）・･\/／,，、。.'’"”\-—_]/g, '');
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
    if (!body) {
        tokens.push(trimmed);
        return tokens;
    }
    tokens.push(body);
    // 再去掉所有括號註記, 取得純藝名
    const bare = body.replace(/\s*[（(][^（()）]*[)）]/g, '').trim();
    if (bare && bare !== body) tokens.push(bare);
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
        for (const entry of splitList(col)) {
            for (const t of aliasEntryTokens(entry)) {
                const n = normalizeForMatch(t);
                if (n) set.add(n);
            }
        }
    }
    return set;
}

// 智慧比對演員: 以正規化 (全半形 / 片假名平假名 / 讀音註記) 後的字串比對,
// 提升「別名同一人」的辨識率。先以「姓名」欄位比對 (優先), 再以「別名」欄位比對。
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

    // 2. 先以「姓名」欄位比對 (優先), 再以「別名」欄位比對
    for (const tokensOf of [actorNameTokens, actorAliasTokens]) {
        for (const actor of actors) {
            for (const tok of tokensOf(actor)) {
                if (candSet.has(tok)) return actor.id;
            }
        }
    }
    return null;
}

function getOrCreateActorId(db, name) {
    if (!db) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    // 1. 先以智慧比對尋找是否已存在 (包含別名、括號分析)
    const existingId = findSmartMatchActor(db, trimmed);
    if (existingId) return existingId;

    // 2. 不存在則建立新演員。此處儲存原始的完整名稱 (包含括號), 讓使用者後續決定是否編輯;
    //    自動拆解僅在「UI 手動新增」與「批次按鈕」觸發, 抓取匯入保持原樣以免誤判。
    const actorNumber = getNewActorNumber(db);
    const info = db.prepare('INSERT INTO actors (actor_number, name, created_at, is_favorite) VALUES (?, ?, ?, 0)').run(actorNumber, trimmed, Date.now());
    return info.lastInsertRowid;
}

// 搜尋語法解析器共用骨架: 以 ' | ' 切出 OR 群組, 群組內條件以 AND 相連
// tokenize(group) 需回傳 [{ value, negate }]; 無任何條件時回傳空 sql
function buildLikeQuery(input, dbField, tokenize) {
    if (!input || !input.trim()) return { sql: "", params: [] };

    const sqlParts = [];
    const params = [];
    for (const group of input.split(' | ')) {
        const conditions = [];
        for (const { value, negate } of tokenize(group)) {
            conditions.push(`${dbField} ${negate ? 'NOT LIKE' : 'LIKE'} ?`);
            params.push(`%${value}%`);
        }
        if (conditions.length > 0) sqlParts.push(`(${conditions.join(' AND ')})`);
    }

    if (sqlParts.length === 0) return { sql: "", params: [] };
    return { sql: `(${sqlParts.join(' OR ')})`, params };
}

// 一般搜尋: + 為 AND, | 為 OR, - 為 NOT (+/- 作為分隔符, 其效力延續到下一個分隔符)
function parseSearchQuery(input, dbField) {
    return buildLikeQuery(input, dbField, group => {
        const tokens = [];
        let negate = false;
        for (const raw of group.split(/([+\-])/)) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            if (trimmed === '+' || trimmed === '-') negate = (trimmed === '-');
            else tokens.push({ value: trimmed, negate });
        }
        return tokens;
    });
}

// 識別碼專用搜尋: 空格切分段落, 只有段落開頭的 - / + 才視為 NOT / AND
function parseCodeSearchQuery(input, dbField) {
    return buildLikeQuery(input, dbField, group => {
        const tokens = [];
        for (const token of group.trim().split(/\s+/)) {
            if (!token || token === '|') continue; // 忽略殘餘 | 符號
            const hasPrefix = (token.startsWith('-') || token.startsWith('+')) && token.length > 1;
            tokens.push({ value: hasPrefix ? token.slice(1) : token, negate: hasPrefix && token[0] === '-' });
        }
        return tokens;
    });
}

// 計算高對比文字顏色 (YIQ公式): 依背景色回傳黑或白文字色
function getContrastYIQ(hexcolor) {
    if (!hexcolor || typeof hexcolor !== 'string') return '#333333';
    let hex = hexcolor.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(char => char + char).join('');
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
    return `R:${(bigint >> 16) & 255} G:${(bigint >> 8) & 255} B:${bigint & 255}`;
}

const stopPropagation = (e) => { e.stopPropagation(); };

module.exports = {
    getFileUrl,
    splitList,
    toggleSortDirection,
    getNewActorNumber,
    getOrCreateActorId,
    findSmartMatchActor,
    parseNameWithAliases,
    parseSearchQuery,
    parseCodeSearchQuery,
    getContrastYIQ,
    hexToRgb,
    stopPropagation
};
