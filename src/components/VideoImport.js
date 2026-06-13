const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { dialog } = require('@electron/remote');
const {
    FolderOpen, PlayCircle, PauseCircle, Square, RotateCw, CheckCircle2,
    XCircle, Loader2, FileVideo, SkipForward, AlertTriangle, FolderInput, ImageIcon, ArrowLeft
} = require('lucide-react');
const { openJavScraperWindow, extractJavDataFromWindow } = require('./Scraper');
const { useColumnWidths, ColumnResizeHandle } = require('./Shared');
const { db, worksImgDir } = require('../utils/db');
const { getOrCreateActorId } = require('../utils/helpers');

// 影片匯入模組 (Video Import)
// 支援的影片/圖片副檔名
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.wmv', '.mov', '.ts', '.m2ts', '.flv', '.rmvb', '.webm', '.iso'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.jfif', '.bmp', '.gif'];

// 自動選取的標籤名稱
const TAG_NOT_WATCHED = '還沒看';

// 匯入成功後的目標資料夾名稱
const FOLDER_SUCCESS = '[匯入成功]';

// 識別碼重複建立時的目標資料夾名稱
const FOLDER_DUPLICATE = '[重複建立]';

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
    done: { label: '匯入成功', color: '#28a745', icon: CheckCircle2, spin: false },
    error: { label: '錯誤', color: '#dc3545', icon: XCircle, spin: false },
    skipped: { label: '已跳過', color: '#999', icon: SkipForward, spin: false },
    unsupported: { label: '不完整(已跳過)', color: '#ff9800', icon: AlertTriangle, spin: false },
    multiple: { label: '已放棄(複數結果)', color: '#ff9800', icon: AlertTriangle, spin: false },
    notfound: { label: '已放棄(找不到)', color: '#dc3545', icon: XCircle, spin: false },
    duplicate: { label: '已放棄(重複建立)', color: '#ff9800', icon: AlertTriangle, spin: false }
};

// 解析檔名 (不含副檔名), 取得作品名稱/識別碼/類型
// 支援格式:
//   1. 作品名稱 [識別碼]
//   2. 作品名稱 [識別碼]-uncensored-leak
//   3. 作品名稱 [識別碼]-chinese-subtitle
function parseGroupFileName(nameNoExt) {
    const trimmed = (nameNoExt || '').trim();
    if (!trimmed) return null;

    let type = 'normal';
    let main = trimmed;

    for (const s of SUFFIX_TYPES) {
        if (trimmed.toLowerCase().endsWith(s.suffix)) {
            type = s.type;
            main = trimmed.slice(0, trimmed.length - s.suffix.length);
            break;
        }
    }

    main = main.trim();
    const m = main.match(/^(.*?)\s*\[([^\[\]]+)\]\s*$/);
    if (!m) return null;

    const title = m[1].trim();
    const code = m[2].trim();
    if (!code) return null;

    return { title, code, type };
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

function VideoImportSystem({ canGoBack, onGoBack }) {
    const [folderPath, setFolderPath] = React.useState('');
    const [items, setItems] = React.useState([]);
    const [isRunning, setIsRunning] = React.useState(false);

    const { widths: colWidths, startResize } = useColumnWidths('videoImport.colWidths', [100, 280, 110, 110, 100, 250]);

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

    // 掃描資料夾, 將相同檔名(不含副檔名)的影片/圖片視為一組
    const scanFolder = (dir) => {
        try {
            const files = fs.readdirSync(dir, { withFileTypes: true })
                .filter(d => d.isFile())
                .map(d => d.name);

            const groupsMap = new Map();
            const order = [];

            files.forEach(fileName => {
                const ext = path.extname(fileName).toLowerCase();
                const isVideo = VIDEO_EXTENSIONS.includes(ext);
                const isImage = IMAGE_EXTENSIONS.includes(ext);
                if (!isVideo && !isImage) return;

                const base = fileName.slice(0, fileName.length - ext.length);
                const parsed = parseGroupFileName(base);
                if (!parsed) return; // 檔名格式不符者忽略

                // 以解析後的「作品名稱+識別碼+類型」(正規化後) 作為分組依據,
                // 避免影片檔與圖片檔在 [識別碼] 前的空白字元或 Unicode 正規化形式
                // 不同, 導致原始檔名字串不完全相同而被誤判為不同組
                const groupKey = `${parsed.title.normalize('NFC')}|||${parsed.code.normalize('NFC')}|||${parsed.type}`;

                if (!groupsMap.has(groupKey)) {
                    groupsMap.set(groupKey, { base, title: parsed.title, code: parsed.code, type: parsed.type, videos: [], images: [] });
                    order.push(groupKey);
                }
                const grp = groupsMap.get(groupKey);
                if (isVideo) grp.videos.push(fileName);
                else grp.images.push(fileName);
            });

            const newItems = order.map((groupKey, idx) => {
                const g = groupsMap.get(groupKey);
                const hasVideo = g.videos.length > 0;
                const hasImage = g.images.length > 0;
                const isComplete = hasVideo && hasImage;
                let message = '';
                if (!hasVideo && !hasImage) message = '此組沒有影片與圖片檔案, 無法匯入';
                else if (!hasVideo) message = '此組缺少影片檔案, 不是完整一組, 已跳過';
                else if (!hasImage) message = '此組缺少圖片檔案, 不是完整一組, 已跳過';
                return {
                    id: `${Date.now()}_${idx}`,
                    base: g.base,
                    title: g.title,
                    code: g.code,
                    type: g.type,
                    videos: g.videos,
                    images: g.images,
                    status: isComplete ? 'pending' : 'unsupported',
                    message,
                    workNumber: ''
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

    // 依抓取結果建立作品, 新增影片/圖片資訊, 選取「還沒看」標籤後儲存,
    // 最後將該組檔案移動到 [匯入成功] 資料夾
    const processGroup = async (item, data) => {
        const dir = folderPathRef.current;
        const workNumber = item.code;
        const name = (data.name && data.name.trim()) || item.title || workNumber;

        // 取得影片資訊 (使用該組第一個影片檔)
        let resolution = '';
        let fileSize = '';
        const videoFile = item.videos[0];
        if (videoFile) {
            try {
                const metadata = await ipcRenderer.invoke('get-video-metadata', path.join(dir, videoFile));
                resolution = metadata && metadata.resolution ? metadata.resolution : '';
                fileSize = metadata && metadata.duration != null ? String(metadata.duration) : '';
            } catch (e) {
                // 影片資訊讀取失敗不阻擋匯入流程
            }
        }

        let workId;
        db.transaction(() => {
            const insertInfo = db.prepare(`INSERT INTO works (work_number, name, release_date, resolution, duration, file_size, director, maker, publisher, rating, is_favorite, notes, created_at) VALUES (@work_number, @name, @release_date, @resolution, @duration, @file_size, @director, @maker, @publisher, @rating, @is_favorite, @notes, @created_at)`).run({
                work_number: workNumber,
                name: name,
                release_date: data.release_date || '',
                resolution: resolution,
                duration: data.duration || '',
                file_size: fileSize,
                director: data.director || '',
                maker: data.maker || '',
                publisher: data.publisher || '',
                rating: null,
                is_favorite: 0,
                notes: '',
                created_at: Date.now()
            });
            workId = insertInfo.lastInsertRowid;

            // 新增圖片 (第一張設為封面)
            const insertImg = db.prepare('INSERT INTO work_images (work_id, file_name, sort_order, is_cover) VALUES (?, ?, ?, ?)');
            item.images.forEach((imgFile, idx) => {
                const srcPath = path.join(dir, imgFile);
                const ext = path.extname(imgFile);
                const newName = `works_${workNumber}_${Date.now()}_${Math.floor(Math.random() * 10000)}${ext}`;
                fs.copyFileSync(srcPath, path.join(worksImgDir, newName));
                insertImg.run(workId, newName, idx + 1, idx === 0 ? 1 : 0);
            });

            // 連結演員 (依原始自動抓取邏輯, 自動建立/比對演員卡片)
            if (Array.isArray(data.actors)) {
                const insActor = db.prepare('INSERT INTO work_actor_link (work_id, actor_id, actor_name, sort_order) VALUES (?, ?, ?, ?)');
                let sortOrder = 1;
                data.actors.forEach(actorName => {
                    const trimmedName = (actorName || '').trim();
                    if (!trimmedName) return;
                    const actorId = getOrCreateActorId(db, trimmedName);
                    insActor.run(workId, actorId || null, actorId ? null : trimmedName, sortOrder);
                    sortOrder++;
                });
            }

            // 自動選取標籤「還沒看」
            const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(TAG_NOT_WATCHED);
            if (tagRow) {
                db.prepare('INSERT OR IGNORE INTO work_tag_link (work_id, tag_id) VALUES (?, ?)').run(workId, tagRow.id);
            }
        })();

        // 將該組影片與圖片檔案移動到 [匯入成功] 資料夾
        const allFiles = [...item.videos, ...item.images];
        allFiles.forEach(fileName => {
            try {
                moveToFolder(dir, FOLDER_SUCCESS, fileName);
            } catch (e) {
                // 個別檔案移動失敗不影響已建立的作品紀錄
            }
        });

        return { workId, workNumber };
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

        const nextItem = itemsRef.current[next];

        // 識別碼以前已建立過作品卡片 -> 放棄該組新增, 移至 [重複建立]
        const existing = db.prepare('SELECT id FROM works WHERE work_number = ?').get(nextItem.code);
        if (existing) {
            const dir = folderPathRef.current;
            const allFiles = [...nextItem.videos, ...nextItem.images];
            allFiles.forEach(fileName => {
                try { moveToFolder(dir, FOLDER_DUPLICATE, fileName); } catch (e) { }
            });
            updateItem(nextItem.id, { status: 'duplicate', message: `識別碼已存在作品卡片, 已放棄並移至 ${FOLDER_DUPLICATE}` });
            indexRef.current = next;
            advance();
            return;
        }

        indexRef.current = next;

        // 反爬蟲對策: 換頁前加入隨機延遲 (3~5秒), 避免被判定為機器人
        const delay = 3000 + Math.floor(Math.random() * 2000);
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
            updateItem(item.id, { message: '正在建立作品資料...' });
            const { workNumber } = await processGroup(item, result.data);
            updateItem(item.id, {
                status: 'done',
                workNumber,
                message: `匯入成功, 已移至 ${FOLDER_SUCCESS}`
            });
        } catch (e) {
            updateItem(item.id, { status: 'error', message: '匯入失敗: ' + e.message });
            resetGrabButton(win);
            advance();
            return;
        }

        resetGrabButton(win);
        advance();
    };

    // 搜尋到複數作品 -> 放棄該組的新增
    const handleMultipleResults = async () => {
        if (!runningRef.current) return;
        const win = scraperWinRef.current;
        const idx = indexRef.current;
        const item = itemsRef.current[idx];
        if (!item) return;

        updateItem(item.id, { status: 'multiple', message: '搜尋到多個結果, 已放棄該組匯入' });
        resetGrabButton(win);
        advance();
    };

    // 完全找不到作品 -> 放棄該組的新增
    const handleNotFound = async () => {
        if (!runningRef.current) return;
        const win = scraperWinRef.current;
        const idx = indexRef.current;
        const item = itemsRef.current[idx];
        if (!item) return;

        updateItem(item.id, { status: 'notfound', message: '查無此作品, 已放棄該組匯入' });
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
    const doneCount = items.filter(it => ['done', 'skipped', 'error', 'multiple', 'notfound', 'duplicate'].includes(it.status)).length;

    return html`
        <div className="content-area" style=${{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="content-header" style=${{ flexDirection: 'column', alignItems: 'flex-start', gap: '12px', height: 'auto' }}>
                <div className="result-info" style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    ${canGoBack && html`
                        <button className="btn-ghost" onClick=${onGoBack} title="返回上一頁" style=${{ padding: '4px', display: 'flex', alignItems: 'center' }}>
                            <${ArrowLeft} size=${18} />
                        </button>
                    `}
                    <${FolderInput} size=${22} /> 影片匯入
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
                        ・找到單一作品 -> 自動新增作品、填入資訊、加入影片與圖片、選取「${TAG_NOT_WATCHED}」標籤並儲存, 然後將該組檔案移至「${FOLDER_SUCCESS}」資料夾<br/>
                        ・搜尋到多個結果或完全找不到結果 -> 放棄該組作品的新增, 檔案保留原位<br/>
                        ・識別碼已存在作品卡片 -> 放棄該組新增, 並將檔案移至「${FOLDER_DUPLICATE}」資料夾<br/>
                        ・只有影片或只有圖片 (非完整一組) -> 自動跳過, 不進行匯入<br/>
                        若遇到 Cloudflare 驗證畫面，請先手動完成驗證，系統會自動繼續。
                    </div>
                `}
            </div>
            <div style=${{ flex: 1, overflowY: 'auto' }}>
                ${items.length === 0 ? html`
                    <div style=${{ color: '#999', padding: '60px 20px', textAlign: 'center', fontSize: '16px' }}>
                        請選擇資料夾以開始。<br/>
                        系統會將相同檔名(不含副檔名)的影片檔與圖片檔視為一組, 支援的檔名格式:<br/>
                        作品名稱 [識別碼] / 作品名稱 [識別碼]-uncensored-leak / 作品名稱 [識別碼]-chinese-subtitle
                    </div>
                ` : html`
                    <table style=${{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', tableLayout: 'fixed' }}>
                        <colgroup>
                            ${colWidths.map((w, i) => html`<col key=${i} style=${{ width: `${w}px` }} />`)}
                        </colgroup>
                        <thead>
                            <tr style=${{ textAlign: 'left', borderBottom: '2px solid #eee', position: 'sticky', top: 0, backgroundColor: '#fff' }}>
                                <th style=${{ padding: '8px', whiteSpace: 'nowrap', position: 'relative' }}>狀態<${ColumnResizeHandle} onMouseDown=${startResize(0)} /></th>
                                <th style=${{ padding: '8px', position: 'relative' }}>作品名稱<${ColumnResizeHandle} onMouseDown=${startResize(1)} /></th>
                                <th style=${{ padding: '8px', whiteSpace: 'nowrap', position: 'relative' }}>識別碼<${ColumnResizeHandle} onMouseDown=${startResize(2)} /></th>
                                <th style=${{ padding: '8px', whiteSpace: 'nowrap', position: 'relative' }}>類型<${ColumnResizeHandle} onMouseDown=${startResize(3)} /></th>
                                <th style=${{ padding: '8px', whiteSpace: 'nowrap', position: 'relative' }}>檔案<${ColumnResizeHandle} onMouseDown=${startResize(4)} /></th>
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
                                        <td style=${{ padding: '8px', wordBreak: 'break-all' }}>${it.title || '-'}</td>
                                        <td style=${{ padding: '8px', whiteSpace: 'nowrap', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis' }}>${it.code || '-'}</td>
                                        <td style=${{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${TYPE_LABELS[it.type] || '-'}</td>
                                        <td style=${{ padding: '8px', whiteSpace: 'nowrap', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            <span style=${{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: '10px' }}><${FileVideo} size=${14} /> ${it.videos.length}</span>
                                            <span style=${{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><${ImageIcon} size=${14} /> ${it.images.length}</span>
                                        </td>
                                        <td style=${{ padding: '8px', wordBreak: 'break-all', color: it.status === 'error' ? '#dc3545' : '#333' }}>
                                            ${it.message || ''}${it.workNumber ? ` (${it.workNumber})` : ''}
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

module.exports = { VideoImportSystem, parseGroupFileName };
