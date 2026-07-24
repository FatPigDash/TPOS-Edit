// 共用 HTTP 工具: 具轉址跟隨的 GET 請求、頁面抓取與檔案下載
// 供演員資訊抓取 (ActorScraper) 與封面圖下載 (FileOrganizer) 共用
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 桌面瀏覽器 User-Agent (降低被判定為爬蟲的機率)
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const REDIRECT_STATUS = [301, 302, 303, 307, 308];

// 發出 GET 請求並自動跟隨轉址 (最多 5 次), 取得 HTTP 200 回應後交給 onOk 處理
// opts: { headers, timeoutMs, timeoutMessage, errorPrefix }
function getFollowingRedirects(url, opts, onOk, reject, redirectsLeft = 5) {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(e); return; }

    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get(url, { headers: opts.headers }, (res) => {
        if (REDIRECT_STATUS.includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let next;
            try { next = new URL(res.headers.location, url).toString(); } catch (e) { reject(e); return; }
            getFollowingRedirects(next, opts, onOk, reject, redirectsLeft - 1);
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(opts.errorPrefix
                ? `${opts.errorPrefix} (HTTP ${res.statusCode})`
                : 'HTTP ' + res.statusCode));
            return;
        }
        onOk(res, url);
    });

    req.on('error', reject);
    if (opts.timeoutMs) {
        req.setTimeout(opts.timeoutMs, () => { req.destroy(new Error(opts.timeoutMessage || '連線逾時')); });
    }
}

// 抓取單一頁面, 自動跟隨轉址, 回傳 { finalUrl, body }
function fetchPage(url, opts = {}) {
    return new Promise((resolve, reject) => {
        getFollowingRedirects(url, opts, (res, finalUrl) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ finalUrl, body: Buffer.concat(chunks).toString('utf8') }));
        }, reject);
    });
}

// 下載檔案至 destPath, 自動跟隨轉址 (協定相對網址 "//host/..." 會補上 https:)
function downloadFile(url, destPath, opts = {}) {
    return new Promise((resolve, reject) => {
        if (!url) { reject(new Error(opts.emptyUrlMessage || '沒有圖片網址')); return; }
        const target = url.startsWith('//') ? 'https:' + url : url;

        getFollowingRedirects(target, opts, (res) => {
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => fileStream.close(() => resolve(true)));
            fileStream.on('error', (err) => {
                try { fs.unlinkSync(destPath); } catch (e) { }
                reject(err);
            });
        }, reject);
    });
}

// 由圖片網址推斷副檔名 (預設 .jpg)
function guessImageExt(url) {
    try {
        const u = new URL(url.startsWith('//') ? 'https:' + url : url);
        const ext = path.extname(u.pathname);
        if (ext && ext.length <= 5) return ext.toLowerCase();
    } catch (e) { }
    return '.jpg';
}

module.exports = { DESKTOP_USER_AGENT, fetchPage, downloadFile, guessImageExt };
