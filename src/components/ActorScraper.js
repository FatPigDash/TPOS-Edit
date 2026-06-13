// 演員資訊抓取模組 (minnano-av.com)
// 在 Electron renderer (nodeIntegration + webSecurity:false) 環境執行,
// 使用 Node https 直接抓取頁面 (可完整控制 HTTP 標頭以降低被判定為爬蟲的機率),
// 並以瀏覽器內建 DOMParser 解析 HTML。
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.minnano-av.com';
// 桌面瀏覽器 User-Agent (降低被判定為機器人的機率)
const SCRAPER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 個人檔案表格可能出現的標籤 (用於 label 比對)
const PROFILE_LABELS = ['別名', '生年月日', 'サイズ', 'AV出演期間', '血液型', '出身地', '所属事務所', '趣味・特技', 'デビュー作品', '愛称', 'ブログ', '公式サイト', 'タグ', '本名'];

// 抓取單一頁面, 自動跟隨轉址, 回傳 { finalUrl, body }
function fetchPage(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { reject(e); return; }
        const mod = parsed.protocol === 'http:' ? http : https;
        const req = mod.get(url, {
            headers: {
                'User-Agent': SCRAPER_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,zh-TW;q=0.8,zh;q=0.7,en;q=0.6',
                'Accept-Encoding': 'identity',
                'Referer': BASE + '/'
            }
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, url).toString(); } catch (e) { reject(e); return; }
                fetchPage(next, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ finalUrl: url, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(new Error('連線逾時')); });
    });
}

// 清理搜尋用名稱: 去除括號內容 (別名/讀音) 與前後空白
function cleanSearchName(rawName) {
    if (!rawName) return '';
    return rawName.replace(/\s*[\(（][^\)）]*[\)）]/g, '').trim();
}

// 生年月日: 取「（現在 XX歳）」之前的日期部分
function cleanBirthdate(value) {
    if (!value) return '';
    return value.split(/[（(]/)[0].replace(/\s+/g, ' ').trim();
}

// サイズ: 正規化空白
function cleanSizes(value) {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim();
}

// 別名 / 一般值: 正規化空白
function cleanValue(value) {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim();
}

// 從搜尋結果頁挑出與名稱完全相符的演員連結
function pickActressFromResults(htmlBody, name) {
    try {
        const doc = new DOMParser().parseFromString(htmlBody, 'text/html');
        const anchors = Array.from(doc.querySelectorAll('a[href]'))
            .filter(a => /\/actress\d+\.html/.test(a.getAttribute('href') || ''));
        // 優先: 連結文字與搜尋名稱完全相符
        for (const a of anchors) {
            const t = (a.textContent || '').trim();
            if (t === name) {
                try { return new URL(a.getAttribute('href'), BASE).toString(); } catch (e) { }
            }
        }
        return null;
    } catch (e) { return null; }
}

// 依名稱搜尋, 回傳演員頁 { url, body } 或 null
async function findActress(rawName) {
    const name = cleanSearchName(rawName);
    if (!name) return null;

    // 空格可能影響搜尋結果: 先用原樣, 失敗再嘗試移除空白版本
    const queries = [name];
    if (/\s/.test(name)) queries.push(name.replace(/\s+/g, ''));

    for (const q of queries) {
        const searchUrl = BASE + '/search_result.php?search_scope=actress&search_word=' + encodeURIComponent(q);
        let resp;
        try { resp = await fetchPage(searchUrl); } catch (e) { continue; }

        // 情形 1: 唯一相符 -> 自動轉址到演員頁
        if (/\/actress\d+\.html/.test(resp.finalUrl) || /actress_id=\d+/.test(resp.finalUrl)) {
            return { url: resp.finalUrl, body: resp.body };
        }

        // 情形 2: 多筆結果列表 -> 找完全相符的連結
        const link = pickActressFromResults(resp.body, q);
        if (link) {
            try {
                const r2 = await fetchPage(link);
                return { url: r2.finalUrl, body: r2.body };
            } catch (e) { }
        }
    }
    return null;
}

// 掃描個人檔案表格, 收集 (label, value) 配對 (相容單欄式與雙欄式表格)
function collectLabelValuePairs(doc) {
    const pairs = [];
    const rows = Array.from(doc.querySelectorAll('tr'));
    for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td, th'));
        if (!cells.length) continue;
        const firstText = (cells[0].textContent || '').replace(/ /g, ' ').trim();
        const matched = PROFILE_LABELS.find(L => firstText === L || firstText.indexOf(L) === 0);
        if (!matched) continue;

        let value = '';
        if (cells.length >= 2) {
            // 雙欄式: 值在後續儲存格
            value = cells.slice(1).map(c => (c.textContent || '').trim()).join(' ').trim();
            if (!value) value = firstText.slice(matched.length).trim();
        } else {
            // 單欄式: 「標籤\n值」同一格
            value = firstText.slice(matched.length).trim();
        }
        pairs.push({ label: matched, value });
    }
    return pairs;
}

// 解析演員頁 HTML, 取出檔案資料
function parseProfile(htmlBody) {
    const result = { name_reading: '', aliases: [], birthdate: '', sizes: '', av_period: '', image_url: '' };
    let doc;
    try { doc = new DOMParser().parseFromString(htmlBody, 'text/html'); } catch (e) { return result; }

    // 圖片: og:image
    const ogImg = doc.querySelector('meta[property="og:image"]');
    if (ogImg) result.image_url = (ogImg.getAttribute('content') || '').trim();

    // 主名稱讀音 (かな / romaji)
    // 來源1: meta-keywords 結構通常為「漢字名, 平假名, 羅馬拼音, ...」
    let kana = '', romaji = '';
    const kw = doc.querySelector('meta[name="keywords"]');
    if (kw) {
        const parts = (kw.getAttribute('content') || '').split(',').map(s => s.trim()).filter(s => s);
        if (parts[1] && /[ぁ-んァ-ヶー]/.test(parts[1]) && !/[A-Za-z]/.test(parts[1])) kana = parts[1];
        if (parts[2] && /^[A-Za-z]/.test(parts[2])) romaji = parts[2];
    }
    // 來源2 (後備): 從頁面文字找第一組「（かな / romaji）」
    if (!kana) {
        const bodyText = (doc.body && doc.body.textContent) || htmlBody || '';
        const m = bodyText.match(/[（(]\s*([ぁ-んァ-ヶー]+)\s*[\/／]\s*([A-Za-z][A-Za-z\s\.]*?)\s*[）)]/);
        if (m) { kana = m[1].trim(); if (!romaji) romaji = m[2].trim(); }
    }
    if (kana || romaji) {
        result.name_reading = romaji ? (kana + ' / ' + romaji) : kana;
    }

    // 個人檔案欄位
    const pairs = collectLabelValuePairs(doc);
    for (const { label, value } of pairs) {
        if (label === '別名') {
            const v = cleanValue(value);
            if (v) result.aliases.push(v);
        } else if (label === '生年月日') {
            result.birthdate = cleanBirthdate(value);
        } else if (label === 'サイズ') {
            result.sizes = cleanSizes(value);
        } else if (label === 'AV出演期間') {
            result.av_period = cleanValue(value);
        }
    }
    return result;
}

// 對外主函式: 依名稱抓取演員資料
async function scrapeActorByName(rawName) {
    const found = await findActress(rawName);
    if (!found) return { success: false, message: '在 minnano-av 找不到符合的演員' };
    const data = parseProfile(found.body);
    return { success: true, data, sourceUrl: found.url };
}

// 下載圖片到指定路徑 (帶 Referer 避免被擋)
function downloadImage(url, destPath) {
    return new Promise((resolve, reject) => {
        if (!url) { reject(new Error('沒有圖片網址')); return; }
        const target = url.startsWith('//') ? 'https:' + url : url;
        const attempt = (u, redirectsLeft) => {
            let parsed;
            try { parsed = new URL(u); } catch (e) { reject(e); return; }
            const mod = parsed.protocol === 'http:' ? http : https;
            const req = mod.get(u, {
                headers: {
                    'User-Agent': SCRAPER_UA,
                    'Referer': BASE + '/',
                    'Accept-Language': 'ja,zh-TW;q=0.8,en;q=0.6'
                }
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    attempt(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error('下載圖片失敗 (HTTP ' + res.statusCode + ')'));
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
            req.setTimeout(20000, () => { req.destroy(new Error('下載逾時')); });
        };
        attempt(target, 5);
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

module.exports = {
    scrapeActorByName,
    downloadImage,
    guessImageExt,
    fetchPage,
    parseProfile,
    cleanSearchName,
    cleanBirthdate,
    cleanSizes,
    cleanValue
};
