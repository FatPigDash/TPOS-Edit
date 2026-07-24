const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const { FileVideo, ImageIcon, FolderInput, ArrowLeft } = require('lucide-react');
const { extractJavDataFromWindow } = require('./Scraper');
const { useColumnWidths } = require('./Shared');
const { db, worksImgDir } = require('../utils/db');
const { getOrCreateActorId } = require('../utils/helpers');
const {
    VIDEO_EXTENSIONS, TYPE_LABELS, splitTypeSuffix, moveToFolder, buildStatusMeta,
    StatusCell, QueueTable, QueueToolbar, useScraperQueue
} = require('./VideoQueue');

// 影片匯入模組 (Video Import)
// 將「作品名稱 [識別碼]」的影片與同名圖片視為一組, 查詢 javlibrary 後建立作品卡片

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.jfif', '.bmp', '.gif'];

// 匯入時自動選取的預設標籤名稱 (依序帶入)
const DEFAULT_IMPORT_TAGS = ['還沒看', '剛匯入未分類'];

// 匯入成功 / 識別碼重複時的目標資料夾名稱
const FOLDER_SUCCESS = '[匯入成功]';
const FOLDER_DUPLICATE = '[重複建立]';

const STATUS_META = buildStatusMeta({
    pending: '待處理',
    processing: '處理中',
    done: '匯入成功',
    error: '錯誤',
    skipped: '已跳過',
    unsupported: '不完整(已跳過)',
    multiple: '已放棄(複數結果)',
    notfound: '已放棄(找不到)',
    duplicate: '已放棄(重複建立)'
});

// 已完成 (不再處理) 的狀態, 用於計算進度
const DONE_STATUSES = ['done', 'skipped', 'error', 'multiple', 'notfound', 'duplicate'];

const COLUMNS = [
    { label: '狀態', nowrap: true },
    { label: '作品名稱' },
    { label: '識別碼', nowrap: true },
    { label: '類型', nowrap: true },
    { label: '檔案', nowrap: true },
    { label: '結果 / 訊息' }
];

// 解析「分段字尾」(識別碼 [] 之後接的部分), 例如 A / B / -A / -1 / _2 / (2) / cd1 / part2
// 回傳 { valid, order }: valid=false 代表 [] 後面接了無法辨識的內容 (非本系統檔名)
function parsePartLabel(raw) {
    const s = (raw || '').trim();
    if (!s) return { valid: true, order: 0 };

    // 去掉開頭分隔符/括號、cd|part|disc 前綴, 以及結尾的 )
    const core = s
        .replace(/^[\s\-_.(]+/, '')
        .replace(/^(cd|part|disc|disk)\s*/i, '')
        .replace(/[\s).]+$/, '')
        .trim();

    if (/^\d{1,3}$/.test(core)) return { valid: true, order: parseInt(core, 10) };

    if (/^[A-Za-z]{1,2}$/.test(core)) {
        // A=1, B=2 ... (依大寫字母序)
        let order = 0;
        const up = core.toUpperCase();
        for (let i = 0; i < up.length; i++) order = order * 26 + (up.charCodeAt(i) - 64);
        return { valid: true, order };
    }
    return { valid: false, order: 0 };
}

// 解析檔名 (不含副檔名), 取得作品名稱/識別碼/類型/分段順序
// 支援格式 (識別碼 [] 後可再接分段字尾, 例如 [ABC-123] A / [ABC-123]-1 / [ABC-123] (2)):
//   1. 作品名稱 [識別碼]
//   2. 作品名稱 [識別碼]-uncensored-leak
//   3. 作品名稱 [識別碼]-chinese-subtitle
function parseGroupFileName(nameNoExt) {
    const { type, body } = splitTypeSuffix(nameNoExt);

    // 以最後一組 [] 作為識別碼 (貪婪比對), 其後允許接分段字尾
    const m = body.match(/^(.*)\[([^\[\]]+)\]\s*(.*)$/);
    if (!m) return null;

    const code = m[2].trim();
    if (!code) return null;

    const part = parsePartLabel(m[3]);
    if (!part.valid) return null; // [] 後面有無法辨識的字尾 → 視為非本系統檔名

    return { title: m[1].trim(), code, type, partOrder: part.order };
}

const HELP_TEXT = html`
    說明: 開始處理後會開啟右側瀏覽器視窗並前往 javlibrary 搜尋。系統會自動偵測搜尋結果並繼續:<br/>
    ・找到單一作品 -> 自動新增作品、填入資訊、加入影片與圖片、選取${DEFAULT_IMPORT_TAGS.map(t => `「${t}」`).join('')}標籤並儲存, 然後將該組檔案移至「${FOLDER_SUCCESS}」資料夾<br/>
    ・搜尋到多個結果或完全找不到結果 -> 放棄該組作品的新增, 檔案保留原位<br/>
    ・識別碼已存在作品卡片 -> 放棄該組新增, 並將檔案移至「${FOLDER_DUPLICATE}」資料夾<br/>
    ・只有影片或只有圖片 (非完整一組) -> 自動跳過, 不進行匯入<br/>
    若遇到 Cloudflare 驗證畫面，請先手動完成驗證，系統會自動繼續。`;

function VideoImportSystem({ canGoBack, onGoBack }) {
    const { widths: colWidths, startResize } = useColumnWidths('videoImport.colWidths', [100, 280, 110, 110, 100, 250]);

    // 掃描資料夾, 將相同「作品名稱+識別碼+類型」的影片/圖片視為一組
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

                // 以解析後的欄位 (正規化後) 作為分組依據, 避免影片檔與圖片檔在 [識別碼] 前的
                // 空白字元或 Unicode 正規化形式不同, 導致原始檔名不完全相同而被誤判為不同組
                const groupKey = `${parsed.title.normalize('NFC')}|||${parsed.code.normalize('NFC')}|||${parsed.type}`;

                if (!groupsMap.has(groupKey)) {
                    groupsMap.set(groupKey, { base, title: parsed.title, code: parsed.code, type: parsed.type, videos: [], images: [] });
                    order.push(groupKey);
                }
                const grp = groupsMap.get(groupKey);
                // 保留分段順序 (partOrder), 供匯入與封面排序使用
                (isVideo ? grp.videos : grp.images).push({ name: fileName, order: parsed.partOrder });
            });

            // 依分段順序排序 (A→B、1→2), 順序相同時以檔名排序
            const sortByPart = (a, b) => a.order - b.order || a.name.localeCompare(b.name, 'en');
            const namesInOrder = (list) => list.slice().sort(sortByPart).map(v => v.name);

            queue.replaceItems(order.map((groupKey, idx) => {
                const g = groupsMap.get(groupKey);
                const videos = namesInOrder(g.videos);
                const images = namesInOrder(g.images);

                let message = '';
                if (!videos.length && !images.length) message = '此組沒有影片與圖片檔案, 無法匯入';
                else if (!videos.length) message = '此組缺少影片檔案, 不是完整一組, 已跳過';
                else if (!images.length) message = '此組缺少圖片檔案, 不是完整一組, 已跳過';

                return {
                    id: `${Date.now()}_${idx}`,
                    base: g.base,
                    title: g.title,
                    code: g.code,
                    type: g.type,
                    videos,
                    images,
                    status: (videos.length && images.length) ? 'pending' : 'unsupported',
                    message,
                    workNumber: ''
                };
            }));
        } catch (e) {
            alert('讀取資料夾失敗: ' + e.message);
        }
    };

    // 依抓取結果建立作品, 新增影片/圖片資訊, 選取預設標籤後儲存,
    // 最後將該組檔案移動到 [匯入成功] 資料夾
    const processGroup = async (item, data) => {
        const dir = queue.folderPathRef.current;
        const workNumber = item.code;
        const name = (data.name && data.name.trim()) || item.title || workNumber;

        // 取得影片資訊: 解析度取第一段, 長度加總所有分段 (分鐘)
        let resolution = '';
        let fileSize = '';
        let totalDuration = 0;
        let hasDuration = false;
        for (const videoFile of item.videos) {
            try {
                const metadata = await ipcRenderer.invoke('get-video-metadata', path.join(dir, videoFile));
                if (metadata) {
                    if (!resolution && metadata.resolution) resolution = metadata.resolution;
                    if (metadata.duration != null) {
                        totalDuration += Number(metadata.duration) || 0;
                        hasDuration = true;
                    }
                }
            } catch (e) {
                // 個別影片資訊讀取失敗不阻擋匯入流程
            }
        }
        if (hasDuration) fileSize = String(totalDuration);

        db.transaction(() => {
            const workId = db.prepare(`INSERT INTO works (work_number, name, release_date, resolution, duration, file_size, director, maker, publisher, rating, is_favorite, notes, created_at) VALUES (@work_number, @name, @release_date, @resolution, @duration, @file_size, @director, @maker, @publisher, @rating, @is_favorite, @notes, @created_at)`).run({
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
            }).lastInsertRowid;

            // 新增圖片 (第一張設為封面)
            const insertImg = db.prepare('INSERT INTO work_images (work_id, file_name, sort_order, is_cover) VALUES (?, ?, ?, ?)');
            item.images.forEach((imgFile, idx) => {
                const ext = path.extname(imgFile);
                const newName = `works_${workNumber}_${Date.now()}_${Math.floor(Math.random() * 10000)}${ext}`;
                fs.copyFileSync(path.join(dir, imgFile), path.join(worksImgDir, newName));
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

            // 自動選取預設標籤 (還沒看 / 剛匯入未分類)
            const findTagByName = db.prepare('SELECT id FROM tags WHERE name = ?');
            const linkWorkTag = db.prepare('INSERT OR IGNORE INTO work_tag_link (work_id, tag_id) VALUES (?, ?)');
            DEFAULT_IMPORT_TAGS.forEach(tagName => {
                const tagRow = findTagByName.get(tagName);
                if (tagRow) linkWorkTag.run(workId, tagRow.id);
            });
        })();

        // 將該組影片與圖片檔案移動到 [匯入成功] 資料夾
        moveGroupFiles(item, FOLDER_SUCCESS);
        return { workNumber };
    };

    // 移動該組的所有影片與圖片 (個別檔案失敗不影響其他檔案)
    const moveGroupFiles = (item, folderName) => {
        const dir = queue.folderPathRef.current;
        [...item.videos, ...item.images].forEach(fileName => {
            try { moveToFolder(dir, folderName, fileName); } catch (e) { }
        });
    };

    // 識別碼先前已建立過作品卡片 -> 放棄該組新增, 移至 [重複建立]
    const skipIfDuplicate = (item) => {
        if (!db.prepare('SELECT id FROM works WHERE work_number = ?').get(item.code)) return false;
        moveGroupFiles(item, FOLDER_DUPLICATE);
        queue.updateItem(item.id, { status: 'duplicate', message: `識別碼已存在作品卡片, 已放棄並移至 ${FOLDER_DUPLICATE}` });
        return true;
    };

    const handleGrab = async () => {
        const item = queue.currentItem();
        if (!item) return;

        queue.updateItem(item.id, { message: '正在讀取資料...' });
        const result = await extractJavDataFromWindow(queue.scraperWinRef.current);

        if (!result.success) {
            queue.updateItem(item.id, { status: 'error', message: result.message || '讀取失敗' });
            queue.resetGrabButton();
            queue.haltRun();
            return;
        }

        try {
            queue.updateItem(item.id, { message: '正在建立作品資料...' });
            const { workNumber } = await processGroup(item, result.data);
            queue.updateItem(item.id, { status: 'done', workNumber, message: `匯入成功, 已移至 ${FOLDER_SUCCESS}` });
        } catch (e) {
            queue.updateItem(item.id, { status: 'error', message: '匯入失敗: ' + e.message });
            queue.resetGrabButton();
            queue.advance();
            return;
        }

        queue.resetGrabButton();
        queue.advance();
    };

    // 搜尋到複數作品 / 完全找不到 -> 放棄該組的新增 (檔案保留原位)
    const abandonCurrent = (status, message) => {
        const item = queue.currentItem();
        if (!item) return;
        queue.updateItem(item.id, { status, message });
        queue.resetGrabButton();
        queue.advance();
    };

    const queue = useScraperQueue({
        scanFolder,
        onGrab: handleGrab,
        onMultipleResults: () => abandonCurrent('multiple', '搜尋到多個結果, 已放棄該組匯入'),
        onNotFound: () => abandonCurrent('notfound', '查無此作品, 已放棄該組匯入'),
        onBeforeItem: skipIfDuplicate,
        extraDelayMs: 2000
    });

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
                <${QueueToolbar} queue=${queue} doneStatuses=${DONE_STATUSES} helpText=${HELP_TEXT} />
            </div>
            <div style=${{ flex: 1, overflowY: 'auto' }}>
                ${queue.items.length === 0 ? html`
                    <div style=${{ color: '#999', padding: '60px 20px', textAlign: 'center', fontSize: '16px' }}>
                        請選擇資料夾以開始。<br/>
                        系統會將相同檔名(不含副檔名)的影片檔與圖片檔視為一組, 支援的檔名格式:<br/>
                        作品名稱 [識別碼] / 作品名稱 [識別碼]-uncensored-leak / 作品名稱 [識別碼]-chinese-subtitle
                    </div>
                ` : html`
                    <${QueueTable} columns=${COLUMNS} widths=${colWidths} startResize=${startResize}>
                        ${queue.items.map(it => html`
                            <tr key=${it.id} style=${{ borderBottom: '1px solid #f5f5f5', backgroundColor: it.status === 'processing' ? '#e3f2fd' : 'transparent' }}>
                                <${StatusCell} meta=${STATUS_META[it.status] || STATUS_META.pending} />
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
                        `)}
                    <//>
                `}
            </div>
        </div>
    `;
}

module.exports = { VideoImportSystem };
