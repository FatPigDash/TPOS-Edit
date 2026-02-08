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

function getOrCreateActorId(db, name) {
    if (!db) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = db.prepare('SELECT id FROM actors WHERE name = ? AND is_deleted = 0').get(trimmed);
    if (existing) return existing.id;

    const actorNumber = getNewActorNumber(db);
    const info = db.prepare('INSERT INTO actors (actor_number, name, created_at, is_favorite) VALUES (?, ?, ?, 0)').run(actorNumber, trimmed, Date.now());
    return info.lastInsertRowid;
}

// 搜尋語法解析器 (+為AND, | 為OR, -為NOT)
// 優化: 改用空白分詞，避免將單字中間的連字號(如 ABC-123)誤判為排除運算子
function parseSearchQuery(input, dbField) {
    if (!input || !input.trim()) return { sql: "", params: [] };
    const orGroups = input.split(' | '); // OR logic
    const sqlParts = [];
    const params = [];

    orGroups.forEach(group => {
        // 使用空白切割單詞，保留單字內部的符號
        const rawTokens = group.trim().split(/\s+/); 
        const groupConditions = [];
        
        rawTokens.forEach(token => {
            const trimmed = token.trim();
            if (!trimmed) return;
            
            // 檢查開頭是否有運算子 (且長度大於1，避免只有一個 + 或 - 的情況)
            if (trimmed.startsWith('-') && trimmed.length > 1) {
                // NOT logic (e.g. "-keyword")
                groupConditions.push(`${dbField} NOT LIKE ?`);
                params.push(`%${trimmed.slice(1)}%`);
            } else if (trimmed.startsWith('+') && trimmed.length > 1) {
                // AND logic explicit (e.g. "+keyword")
                groupConditions.push(`${dbField} LIKE ?`);
                params.push(`%${trimmed.slice(1)}%`);
            } else {
                // Default AND logic (e.g. "keyword" or "HUNTA-645")
                groupConditions.push(`${dbField} LIKE ?`);
                params.push(`%${trimmed}%`);
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
    parseSearchQuery,
    hexToRgb,
    getDragAfterElement,
    stopPropagation
};