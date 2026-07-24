const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const fs = require('fs');
const path = require('path');
const { FolderCog, ArrowLeft } = require('lucide-react');
const { extractJavDataFromWindow } = require('./Scraper');
const { useColumnWidths } = require('./Shared');
const { DESKTOP_USER_AGENT, downloadFile, guessImageExt } = require('../utils/http');
const {
    VIDEO_EXTENSIONS, SUFFIX_TYPES, TYPE_LABELS, splitTypeSuffix,
    getUniqueFileName, moveToFolder, buildStatusMeta,
    StatusCell, QueueTable, QueueToolbar, useScraperQueue
} = require('./VideoQueue');

// 影片整理模組 (File Organizer)
// 依識別碼查詢 javlibrary, 將檔案重新命名為「作品名稱 [識別碼]」並下載封面圖

const STATUS_META = buildStatusMeta({
    pending: '待處理',
    processing: '處理中',
    done: '完成',
    error: '錯誤',
    skipped: '已跳過',
    unsupported: '格式不符',
    multiple: '待選取',
    notfound: '找不到'
});

// 已完成 (不再處理) 的狀態, 用於計算進度
const DONE_STATUSES = ['done', 'skipped', 'error', 'multiple', 'notfound'];

// 結果欄需附帶新檔名的狀態
const DONE_MESSAGE_STATUSES = ['done', 'multiple', 'notfound'];

// 特殊處理結果資料夾名稱
const FOLDER_MULTIPLE = '[待選取]';
const FOLDER_NOT_FOUND = '[找不到]';

const COLUMNS = [
    { label: '狀態', nowrap: true },
    { label: '原始檔名' },
    { label: '識別碼', nowrap: true },
    { label: '類型', nowrap: true },
    { label: '結果 / 訊息' }
];

// 解析檔名 (不含副檔名), 取得識別碼與類型
function parseVideoFileName(nameNoExt) {
    const { type, body } = splitTypeSuffix(nameNoExt);
    // 識別碼格式: 字母/數字 + - + 數字, 例如 aarm-310 / dvmm-217 / same-106
    const m = body.match(/^([a-zA-Z0-9]+)-(\d+)$/);
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

    for (const c of [code, code.replace('-', '')]) {
        const escaped = c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const re = new RegExp('^' + escaped + '[\\s_-]*', 'i');
        if (re.test(t)) return t.replace(re, '').trim();
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

// 下載封面圖 (帶上 javlibrary 的 Referer 避免被擋)
function downloadCover(url, destPath) {
    return downloadFile(url, destPath, {
        headers: {
            'User-Agent': DESKTOP_USER_AGENT,
            'Referer': 'https://www.javlibrary.com/',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        errorPrefix: '下載封面圖失敗',
        emptyUrlMessage: '沒有封面圖網址'
    });
}

const HELP_TEXT = html`
    說明: 開始處理後會開啟右側瀏覽器視窗並前往 javlibrary 搜尋。系統會自動偵測搜尋結果並繼續:<br/>
    ・找到單一作品 -> 自動讀取資料並重新命名、下載封面圖<br/>
    ・搜尋到多個結果 -> 將檔案移至資料夾內的「${FOLDER_MULTIPLE}」資料夾<br/>
    ・完全找不到結果 -> 將檔案移至資料夾內的「${FOLDER_NOT_FOUND}」資料夾<br/>
    若遇到 Cloudflare 驗證畫面，請先手動完成驗證，系統會自動繼續。`;

function FileOrganizerSystem({ canGoBack, onGoBack }) {
    const { widths: colWidths, startResize } = useColumnWidths('fileOrganizer.colWidths', [100, 320, 110, 110, 300]);

    const scanFolder = (dir) => {
        try {
            const files = fs.readdirSync(dir, { withFileTypes: true })
                .filter(d => d.isFile())
                .map(d => d.name)
                .filter(name => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()));

            queue.replaceItems(files.map((fileName, idx) => {
                const ext = path.extname(fileName);
                const parsed = parseVideoFileName(fileName.slice(0, fileName.length - ext.length));
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
            }));
        } catch (e) {
            alert('讀取資料夾失敗: ' + e.message);
        }
    };

    // 重新命名檔案並下載封面圖
    const processItem = async (item, data) => {
        const dir = queue.folderPathRef.current;
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
            const imgExt = guessImageExt(data.cover_url);
            const newBaseNoExt = newFileName.slice(0, newFileName.length - item.ext.length);
            const imgFileName = getUniqueFileName(dir, newBaseNoExt, imgExt, null);
            try {
                await downloadCover(data.cover_url, path.join(dir, imgFileName));
            } catch (e) {
                coverError = e.message;
            }
        } else {
            coverError = '未找到封面圖';
        }

        return { newFileName, coverError };
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
            const { newFileName, coverError } = await processItem(item, result.data);
            queue.updateItem(item.id, {
                status: 'done',
                newName: newFileName,
                message: coverError ? `完成 (封面圖失敗: ${coverError})` : '完成'
            });
        } catch (e) {
            queue.updateItem(item.id, { status: 'error', message: '處理失敗: ' + e.message });
            queue.haltRun();
            queue.resetGrabButton();
            return;
        }

        queue.advance();
    };

    // 搜尋到複數作品 / 完全找不到 -> 移至對應的特殊資料夾後繼續下一筆
    const moveCurrentTo = (folderName, status, describe) => {
        const item = queue.currentItem();
        if (!item) return;

        try {
            const newFileName = moveToFolder(queue.folderPathRef.current, folderName, item.fileName);
            queue.updateItem(item.id, { status, newName: newFileName, message: describe(folderName) });
        } catch (e) {
            queue.updateItem(item.id, { status: 'error', message: '移動檔案失敗: ' + e.message });
            queue.haltRun();
            queue.resetGrabButton();
            return;
        }

        queue.resetGrabButton();
        queue.advance();
    };

    const queue = useScraperQueue({
        scanFolder,
        onGrab: handleGrab,
        onMultipleResults: () => moveCurrentTo(FOLDER_MULTIPLE, 'multiple', f => `搜尋到多個結果, 已移至 ${f}`),
        onNotFound: () => moveCurrentTo(FOLDER_NOT_FOUND, 'notfound', f => `查無此作品, 已移至 ${f}`),
        extraDelayMs: 4000
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
                    <${FolderCog} size=${22} /> 影片檔案整理
                </div>
                <${QueueToolbar} queue=${queue} doneStatuses=${DONE_STATUSES} helpText=${HELP_TEXT} />
            </div>
            <div style=${{ flex: 1, overflowY: 'auto' }}>
                ${queue.items.length === 0 ? html`
                    <div style=${{ color: '#999', padding: '60px 20px', textAlign: 'center', fontSize: '16px' }}>
                        請選擇包含影片檔的資料夾以開始。<br/>
                        支援的檔名格式: 識別碼 / 識別碼-uncensored-leak / 識別碼-chinese-subtitle
                    </div>
                ` : html`
                    <${QueueTable} columns=${COLUMNS} widths=${colWidths} startResize=${startResize}>
                        ${queue.items.map(it => html`
                            <tr key=${it.id} style=${{ borderBottom: '1px solid #f5f5f5', backgroundColor: it.status === 'processing' ? '#e3f2fd' : 'transparent' }}>
                                <${StatusCell} meta=${STATUS_META[it.status] || STATUS_META.pending} />
                                <td style=${{ padding: '8px', wordBreak: 'break-all' }}>${it.fileName}</td>
                                <td style=${{ padding: '8px', whiteSpace: 'nowrap', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis' }}>${it.code || '-'}</td>
                                <td style=${{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${TYPE_LABELS[it.type] || '-'}</td>
                                <td style=${{ padding: '8px', wordBreak: 'break-all', color: it.status === 'error' ? '#dc3545' : '#333' }}>
                                    ${DONE_MESSAGE_STATUSES.includes(it.status) ? `${it.message || ''}${it.newName ? ' -> ' + it.newName : ''}` : (it.message || '')}
                                </td>
                            </tr>
                        `)}
                    <//>
                `}
            </div>
        </div>
    `;
}

module.exports = { FileOrganizerSystem };
