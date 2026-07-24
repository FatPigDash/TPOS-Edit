// 影片批次處理佇列 (影片整理 / 影片匯入 共用)
//
// 兩個模組的運作方式相同: 掃描資料夾建立待處理清單 → 開啟 javlibrary 抓取視窗 →
// 依序換頁查詢 → 由網頁標題訊號 (TPOS_GRAB_ACTION / TPOS_MULTIPLE_RESULTS / TPOS_NOT_FOUND)
// 分派處理 → 換下一筆。此模組收斂共用的狀態、控制流程、檔案工具與表格 UI,
// 各模組僅需提供自己的「掃描」與「處理」邏輯。
const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const fs = require('fs');
const path = require('path');
const { dialog } = require('@electron/remote');
const {
    FolderOpen, PlayCircle, PauseCircle, Square, RotateCw, CheckCircle2,
    XCircle, Loader2, FileVideo, SkipForward, AlertTriangle
} = require('lucide-react');
const { openJavScraperWindow } = require('./Scraper');
const { ColumnResizeHandle } = require('./Shared');

// 支援的影片副檔名
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.wmv', '.mov', '.ts', '.m2ts', '.flv', '.rmvb', '.webm', '.iso'];

// 檔名後綴對應表 (依需求文件定義的三種情境)
const SUFFIX_TYPES = [
    { suffix: '-uncensored-leak', type: 'uncensored-leak', label: '無修正流出' },
    { suffix: '-chinese-subtitle', type: 'chinese-subtitle', label: '中文字幕' }
];

const TYPE_LABELS = {
    normal: '一般',
    'uncensored-leak': '無修正流出',
    'chinese-subtitle': '中文字幕'
};

// 由檔名 (不含副檔名) 取出版本類型後綴, 回傳 { type, body }
function splitTypeSuffix(nameNoExt) {
    const trimmed = (nameNoExt || '').trim();
    for (const s of SUFFIX_TYPES) {
        if (trimmed.toLowerCase().endsWith(s.suffix)) {
            return { type: s.type, body: trimmed.slice(0, trimmed.length - s.suffix.length).trim() };
        }
    }
    return { type: 'normal', body: trimmed };
}

// 取得不重複的檔名 (若已存在則加上編號)
function getUniqueFileName(dir, baseName, ext, excludePath) {
    let candidate = baseName + ext;
    let i = 1;
    while (true) {
        const full = path.join(dir, candidate);
        if (!fs.existsSync(full) || full === excludePath) break;
        candidate = `${baseName} (${i})${ext}`;
        i++;
    }
    return candidate;
}

// 將檔案移動到指定子資料夾 (若資料夾不存在則建立, 若已存在則沿用)
function moveToFolder(dir, folderName, fileName) {
    const targetDir = path.join(dir, folderName);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    const ext = path.extname(fileName);
    const base = fileName.slice(0, fileName.length - ext.length);
    const newFileName = getUniqueFileName(targetDir, base, ext, null);
    fs.renameSync(path.join(dir, fileName), path.join(targetDir, newFileName));
    return newFileName;
}

// 狀態顯示樣式 (圖示與顏色共用; 文字由各模組依情境自行命名)
const STATUS_STYLE = {
    pending: { color: '#888', icon: FileVideo, spin: false },
    processing: { color: '#2196F3', icon: Loader2, spin: true },
    done: { color: '#28a745', icon: CheckCircle2, spin: false },
    error: { color: '#dc3545', icon: XCircle, spin: false },
    skipped: { color: '#999', icon: SkipForward, spin: false },
    unsupported: { color: '#ff9800', icon: AlertTriangle, spin: false },
    multiple: { color: '#ff9800', icon: AlertTriangle, spin: false },
    notfound: { color: '#dc3545', icon: XCircle, spin: false },
    duplicate: { color: '#ff9800', icon: AlertTriangle, spin: false }
};

// 依各模組的狀態文字組出完整樣式表
function buildStatusMeta(labels) {
    const meta = {};
    for (const key of Object.keys(labels)) meta[key] = { ...STATUS_STYLE[key], label: labels[key] };
    return meta;
}

// 狀態欄儲存格 (圖示 + 文字)
function StatusCell({ meta }) {
    const Icon = meta.icon;
    return html`
        <td style=${{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style=${{ display: 'flex', alignItems: 'center', gap: '6px', color: meta.color, fontWeight: 'bold' }}>
                <${Icon} size=${16} className=${meta.spin ? 'spin-anim' : ''} /> ${meta.label}
            </span>
        </td>`;
}

// 佇列表格外框: 可拖曳調整欄寬的表頭 + 由呼叫端提供的資料列 (最後一欄不附把手)
function QueueTable({ columns, widths, startResize, children }) {
    return html`
        <table style=${{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', tableLayout: 'fixed' }}>
            <colgroup>
                ${widths.map((w, i) => html`<col key=${i} style=${{ width: `${w}px` }} />`)}
            </colgroup>
            <thead>
                <tr style=${{ textAlign: 'left', borderBottom: '2px solid #eee', position: 'sticky', top: 0, backgroundColor: '#fff' }}>
                    ${columns.map((col, i) => html`
                        <th key=${i} style=${{ padding: '8px', position: 'relative', ...(col.nowrap ? { whiteSpace: 'nowrap' } : {}) }}>
                            ${col.label}${i < columns.length - 1 && html`<${ColumnResizeHandle} onMouseDown=${startResize(i)} />`}
                        </th>`)}
                </tr>
            </thead>
            <tbody>${children}</tbody>
        </table>`;
}

// 資料夾選擇列 + 執行控制列 (開始/暫停/停止/跳過/手動讀取) 與進度顯示
function QueueToolbar({ queue, doneStatuses, helpText }) {
    const { items, isRunning, folderPath, scraperWinRef } = queue;
    const totalProcessable = items.filter(it => it.status !== 'unsupported').length;
    const doneCount = items.filter(it => doneStatuses.includes(it.status)).length;

    // 以 Fragment 包住多個並列區塊: 不產生額外 DOM 節點, 版面與外層 flex 間距維持不變
    return html`
        <${React.Fragment}>
        <div style=${{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
            <button className="btn-primary" onClick=${queue.selectFolder} disabled=${isRunning}>
                <${FolderOpen} size=${16} style=${{ marginRight: 4 }} /> 選擇資料夾
            </button>
            <input className="filter-input" style=${{ flex: 1, minWidth: '200px' }} value=${folderPath} readOnly placeholder="尚未選擇資料夾" />
            ${folderPath && html`
                <button className="btn-ghost" onClick=${queue.rescan} disabled=${isRunning}>
                    <${RotateCw} size=${16} style=${{ marginRight: 4 }} /> 重新掃描
                </button>
            `}
        </div>
        ${items.length > 0 && html`
            <div style=${{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
                ${!isRunning ? html`
                    <button className="btn-primary" onClick=${queue.start}>
                        <${PlayCircle} size=${16} style=${{ marginRight: 4 }} /> 開始處理
                    </button>
                ` : html`
                    <button className="btn-block" onClick=${queue.pause}>
                        <${PauseCircle} size=${16} style=${{ marginRight: 4 }} /> 暫停
                    </button>
                `}
                <button className="btn-block" onClick=${queue.stop} disabled=${!isRunning && !scraperWinRef.current}>
                    <${Square} size=${16} style=${{ marginRight: 4 }} /> 停止
                </button>
                <button className="btn-ghost" onClick=${queue.skipCurrent} disabled=${!isRunning}>
                    <${SkipForward} size=${16} style=${{ marginRight: 4 }} /> 跳過目前
                </button>
                <button className="btn-ghost" onClick=${queue.manualExtract} disabled=${!isRunning}>
                    <${RotateCw} size=${16} style=${{ marginRight: 4 }} /> 手動讀取目前頁面
                </button>
                <span style=${{ marginLeft: 'auto', color: '#666', fontWeight: 'bold' }}>進度: ${doneCount} / ${totalProcessable}</span>
            </div>
            <div style=${{ fontSize: '12px', color: '#888', lineHeight: '1.5' }}>${helpText}</div>
        `}
        <//>`;
}

// 佇列狀態與控制流程
// options: {
//   scanFolder(dir)         選定資料夾後的掃描邏輯 (需自行呼叫 replaceItems)
//   onGrab()                網頁回報「可讀取資料」時的處理
//   onMultipleResults()     網頁回報「搜尋到多筆」時的處理
//   onNotFound()            網頁回報「查無結果」時的處理
//   onBeforeItem(item)      換到下一筆前的攔截 (回傳 true 代表已處理, 直接跳過該筆)
//   extraDelayMs            隨機延遲的上限增量 (基礎 3 秒 + 0~extraDelayMs)
// }
function useScraperQueue(options) {
    const [items, setItems] = React.useState([]);
    const [isRunning, setIsRunning] = React.useState(false);
    const [folderPath, setFolderPath] = React.useState('');

    const itemsRef = React.useRef([]);
    const indexRef = React.useRef(-1);
    const runningRef = React.useRef(false);
    const scraperWinRef = React.useRef(null);
    const folderPathRef = React.useRef('');

    // 事件回呼 (page-title-updated 等) 需取用最新一次 render 的處理函式
    const optionsRef = React.useRef(options);
    optionsRef.current = options;

    React.useEffect(() => { folderPathRef.current = folderPath; }, [folderPath]);

    const closeWindow = () => {
        const win = scraperWinRef.current;
        if (win && !win.isDestroyed()) {
            try { win.close(); } catch (e) { }
        }
        scraperWinRef.current = null;
    };

    // 元件卸載時一併關閉抓取視窗
    React.useEffect(() => closeWindow, []);

    const updateItem = (id, patch) => {
        setItems(prev => {
            const next = prev.map(it => it.id === id ? { ...it, ...patch } : it);
            itemsRef.current = next;
            return next;
        });
    };

    // 以新的掃描結果取代整個清單
    const replaceItems = (newItems) => {
        itemsRef.current = newItems;
        indexRef.current = -1;
        setItems(newItems);
    };

    const navigateToCode = (code) => {
        const win = scraperWinRef.current;
        if (!win || win.isDestroyed()) return;
        win.loadURL(`https://www.javlibrary.com/tw/vl_searchbyid.php?keyword=${encodeURIComponent(code)}`);
    };

    // 還原網頁上的抓取按鈕與標題訊號, 讓同一頁面可再次觸發
    const resetGrabButton = () => {
        const win = scraperWinRef.current;
        try {
            if (win && !win.isDestroyed()) {
                win.webContents.executeJavaScript(`
                    document.title = document.title.replace('TPOS_GRAB_ACTION', '').replace('TPOS_MULTIPLE_RESULTS', '').replace('TPOS_NOT_FOUND', '');
                    const btn = document.getElementById('tpos-grab-btn');
                    if (btn) { btn.innerHTML = '確認並讀取資料'; btn.style.background = '#28a745'; }
                `);
            }
        } catch (e) { }
    };

    // 分派網頁訊號給模組的處理函式; 執行已停止時一律忽略, 避免殘留訊號誤觸
    const dispatch = (name) => {
        if (!runningRef.current) return;
        const handler = optionsRef.current[name];
        if (handler) handler();
    };

    // 將目前處理中的項目標記為其他狀態 (暫停/停止/視窗關閉時共用)
    const markCurrentProcessing = (status, message) => {
        const cur = itemsRef.current[indexRef.current];
        if (cur && cur.status === 'processing') updateItem(cur.id, { status, message });
    };

    const advance = () => {
        if (!runningRef.current) return;
        let next = indexRef.current + 1;
        while (next < itemsRef.current.length && itemsRef.current[next].status !== 'pending') next++;

        // 全部處理完畢: 收尾並關閉抓取視窗
        if (next >= itemsRef.current.length) {
            runningRef.current = false;
            setIsRunning(false);
            indexRef.current = -1;
            closeWindow();
            return;
        }

        const nextItem = itemsRef.current[next];
        const { onBeforeItem, extraDelayMs } = optionsRef.current;

        // 模組可在此直接處理掉該筆 (例如識別碼重複時放棄匯入), 然後換下一筆
        if (onBeforeItem && onBeforeItem(nextItem)) {
            indexRef.current = next;
            advance();
            return;
        }

        indexRef.current = next;

        // 反爬蟲對策: 換頁前加入隨機延遲, 模擬人類操作避免觸發頻率偵測
        const delay = 3000 + Math.floor(Math.random() * extraDelayMs);
        updateItem(nextItem.id, { status: 'processing', message: `等待中... (${Math.round(delay / 1000)} 秒後查詢)` });
        setTimeout(() => {
            if (!runningRef.current || indexRef.current !== next) return;
            updateItem(nextItem.id, { message: '等待網頁載入...' });
            navigateToCode(nextItem.code);
        }, delay);
    };

    const start = async () => {
        if (runningRef.current) return;
        if (!folderPathRef.current) { alert('請先選擇資料夾'); return; }

        const startIdx = itemsRef.current.findIndex(it => it.status === 'pending');
        if (startIdx === -1) { alert('沒有待處理的項目'); return; }

        runningRef.current = true;
        setIsRunning(true);
        indexRef.current = startIdx;
        updateItem(itemsRef.current[startIdx].id, { status: 'processing', message: '等待網頁載入...' });

        if (scraperWinRef.current && !scraperWinRef.current.isDestroyed()) {
            navigateToCode(itemsRef.current[startIdx].code);
            return;
        }

        const win = await openJavScraperWindow(itemsRef.current[startIdx].code);
        scraperWinRef.current = win;

        win.on('page-title-updated', (e, title) => {
            if (!title) return;
            if (title.includes('TPOS_GRAB_ACTION')) dispatch('onGrab');
            else if (title.includes('TPOS_MULTIPLE_RESULTS')) dispatch('onMultipleResults');
            else if (title.includes('TPOS_NOT_FOUND')) dispatch('onNotFound');
        });

        win.on('closed', () => {
            scraperWinRef.current = null;
            if (runningRef.current) {
                runningRef.current = false;
                setIsRunning(false);
                markCurrentProcessing('pending', '視窗已關閉');
                indexRef.current = -1;
            }
        });
    };

    const pause = () => {
        runningRef.current = false;
        setIsRunning(false);
        markCurrentProcessing('pending', '已暫停');
    };

    const stop = () => {
        runningRef.current = false;
        setIsRunning(false);
        closeWindow();
        markCurrentProcessing('pending', '已停止');
        indexRef.current = -1;
    };

    const skipCurrent = () => {
        if (!runningRef.current) return;
        const cur = itemsRef.current[indexRef.current];
        if (cur) updateItem(cur.id, { status: 'skipped', message: '已跳過' });
        advance();
    };

    const manualExtract = () => dispatch('onGrab');

    const selectFolder = async () => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths || !result.filePaths[0]) return;
        const dir = result.filePaths[0];
        setFolderPath(dir);
        optionsRef.current.scanFolder(dir);
    };

    const rescan = () => optionsRef.current.scanFolder(folderPath);

    // 目前正在處理的項目 (供各模組的 onGrab / onNotFound 等取用)
    const currentItem = () => itemsRef.current[indexRef.current];

    return {
        items, isRunning, folderPath, folderPathRef, scraperWinRef,
        replaceItems, updateItem, currentItem,
        advance, resetGrabButton,
        selectFolder, rescan, start, pause, stop, skipCurrent, manualExtract,
        haltRun: () => { runningRef.current = false; setIsRunning(false); }
    };
}

module.exports = {
    VIDEO_EXTENSIONS,
    SUFFIX_TYPES,
    TYPE_LABELS,
    splitTypeSuffix,
    getUniqueFileName,
    moveToFolder,
    buildStatusMeta,
    StatusCell,
    QueueTable,
    QueueToolbar,
    useScraperQueue
};
