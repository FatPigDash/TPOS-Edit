const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const { screen, BrowserWindow } = require('@electron/remote');
const { Globe, PlayCircle, Loader2, Download, X } = require('lucide-react');
const { stopPropagation } = require('../utils/helpers');

// 4. 網路抓取模組 (Web Scraper)

async function openJavScraperWindow(keyword) {
    let url = keyword;
    if (!keyword.startsWith('http')) {
        url = `https://www.javlibrary.com/tw/vl_searchbyid.php?keyword=${encodeURIComponent(keyword)}`;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    const scraperWidth = Math.floor(screenWidth * 0.5);
    const scraperHeight = screenHeight;
    const scraperX = screenWidth - scraperWidth;
    const scraperY = 0;

    const win = new BrowserWindow({
        width: scraperWidth,
        height: scraperHeight,
        x: scraperX,
        y: scraperY,
        show: true,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            disableBlinkFeatures: 'AutomationControlled'
        }
    });

    // 新增: 攔截並封鎖所有彈出式視窗 (廣告/惡意跳轉)
    win.webContents.setWindowOpenHandler(({ url }) => {
        // 直接拒絕開啟新視窗
        return { action: 'deny' };
    });

    win.webContents.on('did-finish-load', async () => {
        try {
            await win.webContents.executeJavaScript(`
                // 1. 注入抓取按鈕 (右下角)
                if (!document.getElementById('tpos-grab-btn')) {
                    const btn = document.createElement('div');
                    btn.id = 'tpos-grab-btn';
                    btn.innerHTML = '確認並讀取資料';
                    btn.style.cssText = 'position: fixed; bottom: 30px; right: 30px; z-index: 2147483647; background: #28a745; color: white; padding: 15px 30px; border-radius: 50px; cursor: pointer; font-family: sans-serif; font-weight: bold; box-shadow: 0 4px 15px rgba(0,0,0,0.4); font-size: 18px; transition: all 0.2s; border: 2px solid white;';
                    btn.onmouseover = () => { btn.style.transform = 'scale(1.05)'; btn.style.background = '#218838'; };
                    btn.onmouseout = () => { btn.style.transform = 'scale(1)'; btn.style.background = '#28a745'; };
                    btn.onclick = function() {
                        btn.innerHTML = '處理中...';
                        btn.style.background = '#6c757d';
                        document.title = 'TPOS_GRAB_ACTION';
                    };
                    document.body.appendChild(btn);
                }

                // 2. 注入回上一頁按鈕 (左下角)
                if (!document.getElementById('tpos-back-btn')) {
                    const backBtn = document.createElement('div');
                    backBtn.id = 'tpos-back-btn';
                    backBtn.innerHTML = '⬅ 回上一頁';
                    backBtn.style.cssText = 'position: fixed; bottom: 30px; left: 30px; z-index: 2147483647; background: #6c757d; color: white; padding: 15px 30px; border-radius: 50px; cursor: pointer; font-family: sans-serif; font-weight: bold; box-shadow: 0 4px 15px rgba(0,0,0,0.4); font-size: 18px; transition: all 0.2s; border: 2px solid white;';
                    backBtn.onmouseover = () => { backBtn.style.transform = 'scale(1.05)'; backBtn.style.background = '#5a6268'; };
                    backBtn.onmouseout = () => { backBtn.style.transform = 'scale(1)'; backBtn.style.background = '#6c757d'; };
                    backBtn.onclick = function() {
                        window.history.back();
                    };
                    document.body.appendChild(backBtn);
                }

                // 3. 自動偵測與點擊邏輯 (延遲 1 秒執行以確保 DOM 穩定)
                setTimeout(() => {
                    var titleEl = document.getElementById('video_title');
                    var btn = document.getElementById('tpos-grab-btn');
                    
                    // 檢查: 1.有標題元素 2.有按鈕 3.尚未觸發過 4.不是 Cloudflare 驗證頁
                    if (titleEl && btn && document.title.indexOf('TPOS_GRAB_ACTION') === -1 && document.title.indexOf('Just a moment') === -1) {
                         // 簡單驗證標題內容是否存在
                         var titleText = titleEl.innerText || "";
                         if (titleText.trim().length > 0) {
                             console.log("TPOS: Auto-clicking grab button...");
                             btn.innerHTML = '自動讀取中...';
                             btn.style.background = '#17a2b8'; // 變成藍色提示自動讀取
                             btn.click();
                         }
                    }
                }, 1000);
            `);
        } catch (e) {
            console.error("注入按鈕失敗", e);
        }
    });

    win.loadURL(url);
    return win;
}

async function extractJavDataFromWindow(win) {
    if (!win || win.isDestroyed()) return { success: false, message: '視窗已關閉' };
    try {
        const result = await win.webContents.executeJavaScript(`
            (function() {
                if (document.title.includes('Just a moment')) {
                    return { status: 'error', msg: '請先完成驗證。' };
                }
                var titleEl = document.getElementById('video_title');
                if (!titleEl) {
                    return { status: 'error', msg: '找不到作品標題, 請確認您已進入作品詳情頁面。' };
                }

                var title = titleEl.querySelector('a') ? titleEl.querySelector('a').innerText : titleEl.innerText;
                var date = document.getElementById('video_date') ? document.getElementById('video_date').querySelector('.text').innerText : '';
                var length = document.getElementById('video_length') ? document.getElementById('video_length').querySelector('.text').innerText : '';
                var director = document.getElementById('video_director') ? document.getElementById('video_director').querySelector('.text').innerText : '';
                var maker = document.getElementById('video_maker') ? document.getElementById('video_maker').querySelector('.text').innerText : '';
                var publisher = document.getElementById('video_label') ? document.getElementById('video_label').querySelector('.text').innerText : '';
                
                // 抓取演員 (修正: 增強版遍歷邏輯, 處理各種別名排版)
                var actors = [];
                var castEl = document.getElementById('video_cast');
                if (castEl) {
                    var stars = castEl.querySelectorAll('.star');
                    for (var i = 0; i < stars.length; i++) {
                        var star = stars[i];
                        var actorName = star.innerText.trim();
                        
                        // 往後搜尋兄弟節點, 找尋括號內容
                        var nextNode = star.nextSibling;
                        while(nextNode) {
                            if (nextNode.nodeType === 3) { // Text Node
                                var val = nextNode.nodeValue;
                                if (!val.trim()) {
                                    nextNode = nextNode.nextSibling;
                                    continue;
                                }
                                // 檢查是否包含括號 (別名特徵)
                                if (val.indexOf('(') !== -1 || val.indexOf('（') !== -1) {
                                    actorName += ' ' + val.trim();
                                    break;
                                }
                                break;
                            } else if (nextNode.nodeType === 1) { // Element Node
                                if (nextNode.classList.contains('star') || nextNode.tagName === 'BR' || nextNode.tagName === 'TR' || nextNode.tagName === 'DIV' || nextNode.tagName === 'P') {
                                    break;
                                }
                                var elText = nextNode.innerText || "";
                                if (elText.indexOf('(') !== -1 || elText.indexOf('（') !== -1) {
                                    actorName += ' ' + elText.trim();
                                }
                                break;
                            }
                            nextNode = nextNode.nextSibling;
                        }
                        actors.push(actorName);
                    }
                }

                return {
                    status: 'success',
                    data: {
                        name: title.trim(),
                        release_date: date.trim(),
                        duration: length.replace(/\\D/g, ''),
                        director: director.trim(),
                        maker: maker.trim(),
                        publisher: publisher.trim(),
                        actors: actors
                    }
                };
            })();
        `);

        if (result.status === 'success') {
            return { success: true, data: result.data };
        } else {
            return { success: false, message: result.msg || '未知錯誤' };
        }
    } catch (e) {
        return { success: false, message: '讀取失敗:' + e.message };
    }
}

function ScraperModal({ defaultUrl, onConfirm, onClose }) {
    const [inputValue, setInputValue] = React.useState(defaultUrl || "");
    const [step, setStep] = React.useState('input'); // 'input' | 'browsing'
    const [scraperWin, setScraperWin] = React.useState(null);
    const [statusMsg, setStatusMsg] = React.useState("");

    const performExtraction = async (targetWin) => {
        if (!targetWin) return;
        setStatusMsg("正在讀取資料...");
        const result = await extractJavDataFromWindow(targetWin);
        if (result.success) {
            try { if (!targetWin.isDestroyed()) targetWin.close(); } catch (e) { }
            onConfirm(result.data);
            onClose();
        } else {
            setStatusMsg(result.message);
            alert(result.message);
            try {
                if (!targetWin.isDestroyed()) {
                    targetWin.webContents.executeJavaScript(`
                        document.title = document.title.replace('TPOS_GRAB_ACTION', '');
                        const btn = document.getElementById('tpos-grab-btn');
                        if(btn) { btn.innerHTML = '確認並讀取資料'; btn.style.background = '#28a745'; }
                    `);
                }
            } catch (e) { }
        }
    };

    const handleOpenBrowser = async () => {
        const keyword = inputValue.trim();
        if (!keyword) return alert("請輸入網址或識別碼");
        setStatusMsg("正在開啟瀏覽器...");
        const win = await openJavScraperWindow(keyword);
        setScraperWin(win);
        setStep('browsing');
        setStatusMsg("");

        win.on('page-title-updated', (e, title) => {
            if (title && title.includes('TPOS_GRAB_ACTION')) {
                performExtraction(win);
            }
        });

        win.on('closed', () => {
            setScraperWin(null);
            if (step === 'browsing') onClose();
        });
    };

    const handleManualExtract = () => performExtraction(scraperWin);

    return html`
        <div className="modal-overlay" style=${{ zIndex: 2200 }}>
            <div className="modal-content" style=${{ maxWidth: '500px' }} onClick=${stopPropagation}>
                <div className="modal-header">
                    <span style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <${Globe} size=${20} color="#2196F3" /> 網頁資料讀取
                    </span>
                    <button className="btn-ghost" onClick=${() => {
                        if (scraperWin && !scraperWin.isDestroyed()) scraperWin.close();
                        onClose();
                    }}><${X} size=${24} /></button>
                </div>
                ${step === 'input' ? html`
                    <div className="modal-body" style=${{ padding: '20px 0' }}>
                        <div style=${{ marginBottom: '8px', fontWeight: 'bold' }}>網址/識別碼</div>
                        <input className="filter-input" value=${inputValue} onInput=${(e) => setInputValue(e.target.value)} placeholder="輸入 javlibrary 網址或識別碼" autoFocus />
                        <div style=${{ fontSize: '12px', color: '#666', marginTop: '16px', lineHeight: '1.5' }}>
                            <p>1. 點擊「開啟瀏覽器」, 新視窗會<b>自動靠右開啟</b></p>
                            <p>2. 如遇驗證畫面, 請手動點擊通過。</p>
                            <p>3. 確認進入作品頁面後, 您可以:</p>
                            <ul style=${{ paddingLeft: '20px', margin: '4px 0' }}>
                                <li>系統將自動偵測作品頁面並<b style=${{ color: '#17a2b8' }}>自動讀取</b></li>
                                <li>若無反應, 請點擊<b style=${{ color: '#28a745' }}>綠色懸浮按鈕</b></li>
                                <li>若遇到廣告頁面, 請點擊<b style=${{ color: '#6c757d' }}>回上一頁</b>按鈕</li>
                            </ul>
                        </div>
                    </div>
                    <div className="modal-footer">
                        <button className="btn-block" onClick=${onClose}>取消</button>
                        <button className="btn-primary" onClick=${handleOpenBrowser}>開啟瀏覽器 <${PlayCircle} size=${16} style=${{ marginLeft: 4 }} /></button>
                    </div>
                ` : html`
                    <div className="modal-body" style=${{ padding: '20px 0', textAlign: 'center' }}>
                        <div style=${{ marginBottom: '20px' }}><div className="spinner" style=${{ margin: '0 auto 10px auto' }}><${Loader2} size=${32} className="spin-anim" color="#2196F3" /></div></div>
                        <div style=${{ fontWeight: 'bold', color: '#2196F3' }}>瀏覽器已開啟...</div>
                        <p style=${{ fontWeight: 'bold', color: '#28a745' }}>請等待自動讀取，或手動點擊按鈕</p>
                        <p style=${{ fontSize: '12px', color: '#999', marginTop: '8px' }}>如果網頁按鈕沒出現, 您也可以點擊下方的按鈕:</p>
                        ${statusMsg && html`<div style=${{ color: '#dc3545', marginTop: '10px', fontWeight: 'bold' }}>${statusMsg}</div>`}
                    </div>
                    <div className="modal-footer" style=${{ justifyContent: 'space-between' }}>
                        <button className="btn-block" onClick=${() => {
                            try { if (scraperWin && !scraperWin.isDestroyed()) scraperWin.close(); } catch (e) { }
                            onClose();
                        }}>取消 / 關閉</button>
                        <button className="btn-primary" style=${{ backgroundColor: '#6c757d' }} onClick=${handleManualExtract}>
                            <${Download} size=${16} style=${{ marginRight: 4 }} /> 強制讀取 (備用)
                        </button>
                    </div>
                `}
            </div>
        </div>`;
}

module.exports = { ScraperModal };