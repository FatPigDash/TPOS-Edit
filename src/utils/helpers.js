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
function parseNameWithAliases(rawName) {
    if (!rawName) return { name: '', aliases: [] };

    const extractedAliases = [];

    // 1. 提取括號內的內容
    const regex = /\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(rawName)) !== null) {
        const alias = match[1].trim();
        if (alias) extractedAliases.push(alias);
    }

    // 2. 移除括號與內容，取得乾淨的主名稱
    const cleanName = rawName.replace(/\s*\([^)]+\)/g, '').trim();

    return {
        name: cleanName || rawName.trim(), // 如果刪光了(罕見)，就回傳原字串
        aliases: extractedAliases
    };
}

// 智慧比對演員 (核心邏輯更新)
function findSmartMatchActor(db, rawName) {
    if (!db || !rawName) return null;

    // 1. 產生候選關鍵字清單 (Candidate Keywords)
    const candidates = new Set();

    // 使用新的解析函式來取得拆解後的名稱
    const parsed = parseNameWithAliases(rawName);

    // A. 原始輸入
    candidates.add(rawName.trim());
    // B. 主名稱
    if (parsed.name) candidates.add(parsed.name);
    // C. 括號內的別名
    parsed.aliases.forEach(a => candidates.add(a));

    // 2. 針對每個候選字進行資料庫比對
    const candidateArray = Array.from(candidates);

    for (const keyword of candidateArray) {
        if (!keyword) continue;

        // 步驟 2-1: 比對「姓名 (name)」欄位 (完全一致)
        const nameMatch = db.prepare('SELECT id FROM actors WHERE name = ? AND is_deleted = 0').get(keyword);
        if (nameMatch) return nameMatch.id;

        // 步驟 2-2: 比對「別名 (aliases)」欄位 (包含搜尋)
        const aliasCandidates = db.prepare('SELECT id, aliases FROM actors WHERE aliases LIKE ? AND is_deleted = 0').all(`%${keyword}%`);

        for (const row of aliasCandidates) {
            if (row.aliases) {
                // 將資料庫的 "A, B, C" 拆開來精確比對
                const dbAliases = row.aliases.split(/[,，]/).map(s => s.trim());
                if (dbAliases.includes(keyword)) {
                    return row.id;
                }
            }
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
    hexToRgb,
    getDragAfterElement,
    stopPropagation
};