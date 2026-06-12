const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { dialog } = require('@electron/remote');
const {
    FolderOpen, PlayCircle, PauseCircle, Square, RotateCw, CheckCircle2,
    XCircle, Loader2, FileVideo, SkipForward, AlertTriangle, FolderCog
} = require('lucide-react');
const { openJavScraperWindow, extractJavDataFromWindow, DESKTOP_USER_AGENT } = require('./Scraper');
const { useColumnWidths, ColumnResizeHandle } = require('./Shared');

// 影片整理模組 (File Organizer)
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

const STATUS_META = {
    pending: { label: '待處理', color: '#888', icon: FileVideo, spin: false },
    processing: { label: '處理中', color: '#2196F3', icon: Loader2, spin: true },
    done: { label: '完成', color: '#28a745', icon: CheckCircle2, spin: false },
    error: { label: '錯誤', color: '#dc3545', icon: XCircle, spin: false },
    skipped: { label: '已跳過', color: '#999', icon: SkipForward, spin: false },
    unsupported: { label: '格式不符', color: '#ff9800', icon: AlertTriangle, spin: false },
    multiple: { label: '待選取', color: '#ff9800', icon: AlertTriangle, spin: false },
    notfound: { label: '找不到', color: '#dc3545', icon: XCircle, spin: false }
};

// 特殊處理結果資料夾名稱
const FOLDER_MULTIPLE = '[待選取]';
const FOLDER_NOT_FOUND = '[找不到]';

// 解析檔名 (不含副檔名), 取得識別碼與類型
function parseVideoFileName(nameNoExt) {
    const trimmed = (nameNoExt || '').trim();
    let type = 'normal';
    let codePart = trimmed;

    for (const s of SUFFIX_TYPES) {
        if (trimmed.toLowerCase().endsWith(s.suffix)) {
            type = s.type;
            codePart = trimmed.slice(0, trimmed.length - s.suffix.length);
            break;
        }
    }

    codePart = codePart.trim();
    // 識別碼格式: 字母/數字 + - + 數字, 例如 aarm-310 / dvmm-217 / same-106
    const m = codePart.match(/^([a-zA-Z0-9]+)-(\d+)$/);
    if (!m) return null;

    return { code: `${m[1].toUpperCase()}-${m[2]}`, type };
}

// 移除檔名中不合法字元
function sanitizeForFileName(str) {
    return (str || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 移除標題開頭重複的識別碼
function cleanWorkTitle(rawTitle, code) {
    let t = (rawTitle || '').trim();
    if (!t || !code) return t;
    const noHyphen = code.replace('-', '');
    const candidates = [code, noHyphen];

    for (const c of candidates) {
        const escaped = c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const re = new RegExp('^' + escaped + '[\\s_-]*', 'i');
        if (re.test(t)) {
            t = t.replace(re, '').trim();
            break;
        }
    }
    return t;
}

// 組合新檔名 (不含副檔名)
function buildNewBaseName(title, code, type) {
    const safeTitle = sanitizeForFileName(title);
    const namePart = safeTitle ? `${safeTitle} [${code}]` : `[${code}]`;
    const suffixDef = SUFFIX_TYPES.find(s => s.type === type);
    return suffixDef ? `${namePart}${suffixDef.suffix}` : namePart;
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

// 從圖片網址判斷副檔名
function getImageExtFromUrl(url) {
    try {
        const full = url.startsWith('//') ? 'https:' + url : url;
        const u = new URL(full);
        const ext = path.extname(u.pathname);
        if (ext && ext.length <= 5) return ext.toLowerCase();
    } catch (e) { }
    return '.jpg';
}

// 下載封面圖 (帶上 Referer 避免被擋)
function downloadImage(url, destPath) {
    return new Promise((resolve, reject) => {
        if (!url) { reject(new Error('沒有封面圖網址')); return; }
        const target = url.startsWith('//') ? 'https:' + url : url;

        const attempt = (u, redirectsLeft) => {
            let parsed;
            try { parsed = new URL(u); } catch (e) { reject(e); return; }
            const mod = parsed.protocol === 'http:' ? http : https;
            const req = mod.get(u, {
                headers: {
                    'User-Agent': DESKTOP_USER_AGENT,
                    'Referer': 'https://www.javlibrary.com/',
                    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
                }
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    attempt(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error('下載封面圖失敗 (HTTP ' + res.statusCode + ')'));
                    return;
                }
                const fileStream = fs.createWriteStream(destPath);
                res.pipe(fileStream);
                fileStream.on('finish', () => fileStream.close(() => resolve(true)));
                fileStream.on('error', (err) => {
                    try { fs.unlinkSync(destPath); } catch (e) { }
                    reject(err);
                });
            });
            req.on('error', reject);
        };

        attempt(target, 5);
    });
}

function FileOrganizerSystem() {
    const [folderPath, setFolderPath] = React.useState('');
    const [items, setItems] = React.useState([]);
    const [isRunning, setIsRunning] = React.useState(false);

    const { widths: colWidths, startResize } = useColumnWidths('fileOrganizer.colWidths', [100, 320, 110, 110, 300]);

    const itemsRef = React.useRef([]);
    const indexRef = React.useRef(-1);
    const runningRef = React.useRef(false);
    const scraperWinRef = React.useRef(null);
    const folderPathRef = React.useRef('');

    React.useEffect(() => { folderPathRef.current = folderPath; }, [folderPath]);

    React.useEffect(() => {
        return () => {
            const win = scraperWinRef.current;
            if (win && !win.isDestroyed()) {
                try { win.close(); } catch (e) { }
            }
        };
    }, []);

    const updateItem = (id, patch) => {
        setItems(prev => {
            const next = prev.map(it => it.id === id ? { ...it, ...patch } : it);
            itemsRef.current = next;
            return next;
        });
    };

    const scanFolder = (dir) => {
        try {
            const files = fs.readdirSync(dir, { withFileTypes: true })
                .filter(d => d.isFile())
                .map(d => d.name)
                .filter(name => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()));

            const newItems = files.map((fileName, idx) => {
                const ext = path.extname(fileName);
                const base = fileName.slice(0, fileName.length - ext.length);
                const parsed = parseVideoFileName(base);
                return {
                    id: `${Date.now()}_${idx}`,
                    fileName,
                    ext,
                    code: parsed ? parsed.code : null,
                    type: parsed ? parsed.type : null,
                    status: parsed ? 'pending' : 'unsupported',
                    message: parsed ? '' : '檔名格式不符, 無法解析識別碼',
                    newName: ''
                };
            });

            itemsRef.current = newItems;
            indexRef.current = -1;
            setItems(newItems);
        } catch (e) {
            alert('讀取資料夾失敗: ' + e.message);
        }
    };

    const handleSelectFolder = async () => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths || !result.filePaths[0]) return;
        const dir = result.filePaths[0];
        setFolderPath(dir);
        scanFolder(dir);
    };

    const navigateToCode = (code) => {
        const win = scraperWinRef.current;
        if (!win || win.isDestroyed()) return;
        const url = `https://www.javlibrary.com/tw/vl_searchbyid.php?keyword=${encodeURIComponent(code)}`;
        win.loadURL(url);
    };

    const resetGrabButton = (win) => {
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

    // 重新命名檔案並下載封面圖
    const processItem = async (item, data) => {
        const dir = folderPathRef.current;
        const code = (data.video_id && data.video_id.trim()) || item.code;
        const title = cleanWorkTitle(data.name, code);
        const baseName = buildNewBaseName(title, code, item.type);

        const oldPath = path.join(dir, item.fileName);
        const newFileName = getUniqueFileName(dir, baseName, item.ext, oldPath);
        const newPath = path.join(dir, newFileName);

        if (oldPath !== newPath) {
            fs.renameSync(oldPath, newPath);
        }

        let coverError = null;
        if (data.cover_url) {
            const imgExt = getImageExtFromUrl(data.cover_url);
            const newBaseNoExt = newFileName.slice(0, newFileName.length - item.ext.length);
            const imgFileName = getUniqueFileName(dir, newBaseNoExt, imgExt, null);
            const imgPath = path.join(dir, imgFileName);
            try {
                await downloadImage(data.cover_url, imgPath);
            } catch (e) {
                coverError = e.message;
            }
        } else {
            coverError = '未找到封面圖';
        }

        return { newFileName, coverError };
    };

    const advance = () => {
        if (!runningRef.current) return;
        let next = indexRef.current + 1;
        while (next < itemsRef.current.length && itemsRef.current[next].status !== 'pending') next++;

        if (next >= itemsRef.current.length) {
            runningRef.current = false;
            setIsRunning(false);
            indexRef.current = -1;
            const win = scraperWinRef.current;
            if (win && !win.isDestroyed()) {
                try {
                    win.webContents.executeJavaScript(`
                        document.title = document.title.replace('TPOS_GRAB_ACTION', '');
                        const btn = document.getElementById('tpos-grab-btn');
                        if (btn) { btn.innerHTML = '全部處理完成'; btn.style.background = '#28a745'; }
                    `);
                } catch (e) { }
            }
            return;
        }

        indexRef.current = next;
        const nextItem = itemsRef.current[next];

        // 反爬蟲對策: 換頁前加入隨機延遲 (3~7秒), 模擬人類操作避免觸發頻率偵測
        const delay = 3000 + Math.floor(Math.random() * 4000);
        updateItem(nextItem.id, { status: 'processing', message: `等待中... (${Math.round(delay / 1000)} 秒後查詢)` });
        setTimeout(() => {
            if (!runningRef.current || indexRef.current !== next) return;
            updateItem(nextItem.id, { message: '等待網頁載入...' });
            navigateToCode(nextItem.code);
        }, delay);
    };

    const handleGrab = async () => {
        if (!runningRef.current) return;
        const win = scraperWinRef.current;
        const idx = indexRef.current;
        const item = itemsRef.current[idx];
        if (!item) return;

        updateItem(item.id, { message: '正在讀取資料...' });
        const result = await extractJavDataFromWindow(win);

        if (!result.success) {
            updateItem(item.id, { status: 'error', message: result.message || '讀取失敗' });
            resetGrabButton(win);
            runningRef.current = false;
            setIsRunning(false);
            return;
        }

        try {
            const { newFileName, coverError } = await processItem(item, result.data);
            updateItem(item.id, {
                status: 'done',
                newName: newFileName,
                message: coverError ? `完成 (封面圖失敗: ${coverError})` : '完成'
            });
        } catch (e) {
            updateItem(item.id, { status: 'error', message: '處理失敗: ' + e.message });
            runningRef.current = false;
            setIsRunning(false);
            resetGrabButton(win);
            return;
        }

        advance();
    };

    // 搜尋到複數作品 -> 移至 [待選取] 資料夾
    const handleMultipleResults = async () => {
        if (!runningRef.current) return;
        const win = scraperWinRef.current;
        const idx = indexRef.current;
        const item = itemsRef.current[idx];
        if (!item) return;

        try {
            const dir = folderPathRef.current;
            const newFileName = moveToFolder(dir, FOLDER_MULTIPLE, item.fileName);
            updateItem(item.id, { status: 'multiple', newName: newFileName, message: `搜尋到多個結果, 已移至 ${FOLDER_MULTIPLE}` });
        } catch (e) {
            updateItem(item.id, { status: 'error', message: '移動檔案失敗: ' + e.message });
            runningRef.current = false;
            setIsRunning(false);
            resetGrabButton(win);
            return;
        }

        resetGrabButton(win);
        advance();
    };

    // 完全找不到作品 -> 移至 [找不到] 資料夾
    const handleNotFound = async () => {
        if (!runningRef.current) return;
        const win = scraperWinRef.current;
        const idx = indexRef.current;
        const item = itemsRef.current[idx];
        if (!item) return;

        try {
            const dir = folderPathRef.current;
            const newFileName = moveToFolder(dir, FOLDER_NOT_FOUND, item.fileName);
            updateItem(item.id, { status: 'notfound', newName: newFileName, message: `查無此作品, 已移至 ${FOLDER_NOT_FOUND}` });
        } catch (e) {
            updateItem(item.id, { status: 'error', message: '移動檔案失敗: ' + e.message });
            runningRef.current = false;
            setIsRunning(false);
            resetGrabButton(win);
            return;
        }

        resetGrabButton(win);
        advance();
    };

    const handleStart = async () => {
        if (runningRef.current) return;
        if (!folderPathRef.current) { alert('請先選擇資料夾'); return; }

        const startIdx = itemsRef.current.findIndex(it => it.status === 'pending');
        if (startIdx === -1) { alert('沒有待處理的項目'); return; }

        runningRef.current = true;
        setIsRunning(true);
        indexRef.current = startIdx;
        updateItem(itemsRef.current[startIdx].id, { status: 'processing', message: '等待網頁載入...' });

        if (!scraperWinRef.current || scraperWinRef.current.isDestroyed()) {
            const win = await openJavScraperWindow(itemsRef.current[startIdx].code);
            scraperWinRef.current = win;

            win.on('page-title-updated', (e, title) => {
                if (title && title.includes('TPOS_GRAB_ACTION')) {
                    handleGrab();
                } else if (title && title.includes('TPOS_MULTIPLE_RESULTS')) {
                    handleMultipleResults();
                } else if (title && title.includes('TPOS_NOT_FOUND')) {
                    handleNotFound();
                }
            });

            win.on('closed', () => {
                scraperWinRef.current = null;
                if (runningRef.current) {
                    runningRef.current = false;
                    setIsRunning(false);
                    const cur = itemsRef.current[indexRef.current];
                    if (cur && cur.status === 'processing') updateItem(cur.id, { status: 'pending', message: '視窗已關閉' });
                    indexRef.current = -1;
                }
            });
        } else {
            navigateToCode(itemsRef.current[startIdx].code);
        }
    };

    const handlePause = () => {
        runningRef.current = false;
        setIsRunning(false);
        const cur = itemsRef.current[indexRef.current];
        if (cur && cur.status === 'processing') updateItem(cur.id, { status: 'pending', message: '已暫停' });
    };

    const handleStop = () => {
        runningRef.current = false;
        setIsRunning(false);
        const win = scraperWinRef.current;
        if (win && !win.isDestroyed()) {
            try { win.close(); } catch (e) { }
        }
        scraperWinRef.current = null;
        const cur = itemsRef.current[indexRef.current];
        if (cur && cur.status === 'processing') updateItem(cur.id, { status: 'pending', message: '已停止' });
        indexRef.current = -1;
    };

    const handleSkipCurrent = () => {
        if (!runningRef.current) return;
        const cur = itemsRef.current[indexRef.current];
        if (cur) updateItem(cur.id, { status: 'skipped', message: '已跳過' });
        advance();
    };

    const handleManualExtract = () => {
        if (!runningRef.current) return;
        handleGrab();
    };

    const totalProcessable = items.filter(it => it.status !== 'unsupported').length;
    const doneCount = items.filter(it => ['done', 'skipped', 'error', 'multiple', 'notfound'].includes(it.status)).length;

    return html`
        <div className="content-area" style=${{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="content-header" style=${{ flexDirection: 'column', alignItems: 'flex-start', gap: '12px', height: 'auto' }}>
                <div className="result-info" style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <${FolderCog} size=${22} /> 影片檔案整理
                </div>
                <div style=${{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
                    <button className="btn-primary" onClick=${handleSelectFolder} disabled=${isRunning}>
                        <${FolderOpen} size=${16} style=${{ marginRight: 4 }} /> 選擇資料夾
                    </button>
                    <input className="filter-input" style=${{ flex: 1, minWidth: '200px' }} value=${folderPath} readOnly placeholder="尚未選擇資料夾" />
                    ${folderPath && html`
                        <button className="btn-ghost" onClick=${() => scanFolder(folderPath)} disabled=${isRunning}>
                            <${RotateCw} size=${16} style=${{ marginRight: 4 }} /> 重新掃描
                        </button>
                    `}
                </div>
                ${items.length > 0 && html`
                    <div style=${{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
                        ${!isRunning ? html`
                            <button className="btn-primary" onClick=${handleStart}>
                                <${PlayCircle} size=${16} style=${{ marginRight: 4 }} /> 開始處理
                            </button>
                        ` : html`
                            <button className="btn-block" onClick=${handlePause}>
                                <${PauseCircle} size=${16} style=${{ marginRight: 4 }} /> 暫停
                            </button>
                        `}
                        <button className="btn-block" onClick=${handleStop} disabled=${!isRunning && !scraperWinRef.current}>
                            <${Square} size=${16} style=${{ marginRight: 4 }} /> 停止
                        </button>
                        <button className="btn-ghost" onClick=${handleSkipCurrent} disabled=${!isRunning}>
                            <${SkipForward} size=${16} style=${{ marginRight: 4 }} /> 跳過目前
                        </button>
                        <button className="btn-ghost" onClick=${handleManualExtract} disabled=${!isRunning}>
                            <${RotateCw} size=${16} style=${{ marginRight: 4 }} /> 手動讀取目前頁面
                        </button>
                        <span style=${{ marginLeft: 'auto', color: '#666', fontWeight: 'bold' }}>進度: ${doneCount} / ${totalProcessable}</span>
                    </div>
                    <div style=${{ fontSize: '12px', color: '#888', lineHeight: '1.5' }}>
                        說明: 開始處理後會開啟右側瀏覽器視窗並前往 javlibrary 搜尋。系統會自動偵測搜尋結果並繼續:<br/>
                        ・找到單一作品 -> 自動讀取資料並重新命名、下載封面圖<br/>
                        ・搜尋到多個結果 -> 將檔案移至資料夾內的「${FOLDER_MULTIPLE}」資料夾<br/>
                        ・完全找不到結果 -> 將檔案移至資料夾內的「${FOLDER_NOT_FOUND}」資料夾<br/>
                        若遇到 Cloudflare 驗證畫面，請先手動完成驗證，系統會自動繼續。
                    </div>
                `}
            </div>
            <div style=${{ flex: 1, overflowY: 'auto' }}>
                ${items.length === 0 ? html`
                    <div style=${{ color: '#999', padding: '60px 20px', textAlign: 'center', fontSize: '16px' }}>
                        請選擇包含影片檔的資料夾以開始。<br/>
                        支援的檔名格式: 識別碼 / 識別碼-uncensored-leak / 識別碼-chinese-subtitle
                    </div>
                ` : html`
                    <table style=${{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', tableLayout: 'fixed' }}>
                        <colgroup>
                            ${colWidths.map((w, i) => html`<col key=${i} style=${{ width: `${w}px` }} />`)}
                        </colgroup>
                        <thead>
                            <tr style=${{ textAlign: 'left', borderBottom: '2px solid #eee', position: 'sticky', top: 0, backgroundColor: '#fff' }}>
                                <th style=${{ padding: '8px', whiteSpace: 'nowrap', position: 'relative' }}>狀態<${ColumnResizeHandle} onMouseDown=${startResize(0)} /></th>
                                <th style=${{ padding: '8px', position: 'relative' }}>原始檔名<${ColumnResizeHandle} onMouseDown=${startResize(1)} /></th>
                                <th style=${{ padding: '8px', whiteSpace: 'nowrap', position: 'relative' }}>識別碼<${ColumnResizeHandle} onMouseDown=${startResize(2)} /></th>
                                <th style=${{ padding: '8px', whiteSpace: 'nowrap', position: 'relative' }}>類型<${ColumnResizeHandle} onMouseDown=${startResize(3)} /></th>
                                <th style=${{ padding: '8px', position: 'relative' }}>結果 / 訊息</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${items.map(it => {
        const meta = STATUS_META[it.status] || STATUS_META.pending;
        const Icon = meta.icon;
        return html`
                                    <tr key=${it.id} style=${{ borderBottom: '1px solid #f5f5f5', backgroundColor: it.status === 'processing' ? '#e3f2fd' : 'transparent' }}>
                                        <td style=${{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            <span style=${{ display: 'flex', alignItems: 'center', gap: '6px', color: meta.color, fontWeight: 'bold' }}>
                                                <${Icon} size=${16} className=${meta.spin ? 'spin-anim' : ''} /> ${meta.label}
                                            </span>
                                        </td>
                                        <td style=${{ padding: '8px', wordBreak: 'break-all' }}>${it.fileName}</td>
                                        <td style=${{ padding: '8px', whiteSpace: 'nowrap', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis' }}>${it.code || '-'}</td>
                                        <td style=${{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${TYPE_LABELS[it.type] || '-'}</td>
                                        <td style=${{ padding: '8px', wordBreak: 'break-all', color: it.status === 'error' ? '#dc3545' : '#333' }}>
                                            ${(it.status === 'done' || it.status === 'multiple' || it.status === 'notfound') ? `${it.message || ''}${it.newName ? ' -> ' + it.newName : ''}` : (it.message || '')}
                                        </td>
                                    </tr>
                                `;
    })}
                        </tbody>
                    </table>
                `}
            </div>
        </div>
    `;
}

module.exports = { FileOrganizerSystem, parseVideoFileName, sanitizeForFileName, cleanWorkTitle, buildNewBaseName };
