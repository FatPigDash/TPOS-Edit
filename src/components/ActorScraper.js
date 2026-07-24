// 演員資訊抓取模組 (minnano-av.com)
// 在 Electron renderer (nodeIntegration + webSecurity:false) 環境執行,
// 以 utils/http 直接抓取頁面 (可完整控制 HTTP 標頭以降低被判定為爬蟲的機率),
// 並以瀏覽器內建 DOMParser 解析 HTML。
const { DESKTOP_USER_AGENT, fetchPage: httpFetchPage, downloadFile, guessImageExt } = require('../utils/http');

const BASE = 'https://www.minnano-av.com';

// 個人檔案表格可能出現的標籤 (用於 label 比對)
const PROFILE_LABELS = ['別名', '生年月日', 'サイズ', 'AV出演期間', '血液型', '出身地', '所属事務所', '趣味・特技', 'デビュー作品', '愛称', 'ブログ', '公式サイト', 'タグ', '本名'];

// 抓取 minnano-av 頁面 (帶入桌面瀏覽器標頭以降低被判定為爬蟲的機率)
function fetchPage(url) {
    return httpFetchPage(url, {
        headers: {
            'User-Agent': DESKTOP_USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja,zh-TW;q=0.8,zh;q=0.7,en;q=0.6',
            'Accept-Encoding': 'identity',
            'Referer': BASE + '/'
        },
        timeoutMs: 20000,
        timeoutMessage: '連線逾時'
    });
}

// 下載圖片到指定路徑 (帶 Referer 避免被擋)
function downloadImage(url, destPath) {
    return downloadFile(url, destPath, {
        headers: {
            'User-Agent': DESKTOP_USER_AGENT,
            'Referer': BASE + '/',
            'Accept-Language': 'ja,zh-TW;q=0.8,en;q=0.6'
        },
        errorPrefix: '下載圖片失敗',
        emptyUrlMessage: '沒有圖片網址',
        timeoutMs: 20000,
        timeoutMessage: '下載逾時'
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

// 別名 / サイズ / 一般值: 正規化空白
function cleanValue(value) {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim();
}

// 從搜尋結果頁挑出與名稱完全相符的演員連結
function pickActressFromResults(htmlBody, name) {
    try {
        const doc = new DOMParser().parseFromString(htmlBody, 'text/html');
        const anchors = Array.from(doc.querySelectorAll('a[href]'))
            .filter(a => /actress\d+\.html/.test(a.getAttribute('href') || ''));
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

// 解析搜尋結果頁的候選演員清單
// 優先回傳「搜尋結果卡片」(卡片內含「デビュー」可排除側欄推薦); 若過濾後為空則回傳全部不重複的演員連結作為後備
function parseSearchCandidates(htmlBody) {
    let doc;
    try { doc = new DOMParser().parseFromString(htmlBody, 'text/html'); } catch (e) { return []; }
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    const seen = new Set();
    const strong = [];
    const all = [];
    for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        // 相容相對/絕對網址與 actress_id 形式
        const m = href.match(/actress(\d+)\.html/) || href.match(/actress_id=(\d+)/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;

        // 向上尋找包含「デビュー」的卡片容器 (搜尋結果卡片才有)
        let card = a, hops = 0, hasDebut = false;
        while (card && hops < 6) {
            if ((card.textContent || '').indexOf('デビュー') !== -1) { hasDebut = true; break; }
            card = card.parentElement; hops++;
        }
        const container = (hasDebut && card) ? card : (a.parentElement || a);

        let name = (a.textContent || '').trim();
        let thumb = '';
        const img = (container.querySelector && container.querySelector('img')) || (a.querySelector && a.querySelector('img'));
        if (img) {
            if (!name) name = (img.getAttribute('alt') || img.getAttribute('title') || '').split(',')[0].trim();
            // 優先取 lazyload 的真實網址, 略過 data: 佔位圖與 blank/np 佔位檔
            const srcCands = [img.getAttribute('data-original'), img.getAttribute('data-src'), img.getAttribute('data-lazy'), img.getAttribute('src')];
            for (const u of srcCands) {
                const v = (u || '').trim();
                if (v && v.toLowerCase().indexOf('data:') !== 0 && v.indexOf('blank') === -1 && v.indexOf('np.gif') === -1) { thumb = v; break; }
            }
            // 相對網址補成絕對網址
            if (thumb) { try { thumb = new URL(thumb, BASE).toString(); } catch (e) { } }
        }
        let info = (container.textContent || '').replace(/\s+/g, ' ').trim();
        if (info.length > 90) info = info.slice(0, 90);

        let url;
        try { url = new URL(href, BASE).toString(); } catch (e) { url = href; }

        const cand = { id, name: name || ('actress' + id), url, thumb, info };
        seen.add(id);
        all.push(cand);
        if (hasDebut) strong.push(cand);
    }
    return strong.length > 0 ? strong : all;
}

// 查詢演員: 回傳 single(已含頁面) / multiple(候選清單) / none
async function lookupActress(rawName) {
    const name = cleanSearchName(rawName);
    if (!name) return { type: 'none' };
    const queries = [name];
    if (/\s/.test(name)) queries.push(name.replace(/\s+/g, ''));

    for (const q of queries) {
        const searchUrl = BASE + '/search_result.php?search_scope=actress&search_word=' + encodeURIComponent(q);
        let resp;
        try { resp = await fetchPage(searchUrl); } catch (e) { continue; }

        if (/\/actress\d+\.html/.test(resp.finalUrl) || /actress_id=\d+/.test(resp.finalUrl)) {
            return { type: 'single', url: resp.finalUrl, body: resp.body };
        }
        const candidates = parseSearchCandidates(resp.body);
        if (candidates.length === 1) {
            try { const r2 = await fetchPage(candidates[0].url); return { type: 'single', url: r2.finalUrl, body: r2.body }; } catch (e) { }
        }
        if (candidates.length > 1) return { type: 'multiple', candidates };
    }
    return { type: 'none' };
}

// 依指定演員頁網址抓取並解析
async function scrapeActressUrl(url) {
    const r = await fetchPage(url);
    return { success: true, data: parseProfile(r.body), sourceUrl: r.finalUrl };
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

// 從個人檔案表格取出「タグ」欄位的標籤清單
function extractTags(doc) {
    const rows = Array.from(doc.querySelectorAll('tr'));
    for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td, th'));
        if (!cells.length) continue;
        const firstText = (cells[0].textContent || '').replace(/ /g, ' ').trim();
        if (firstText !== 'タグ' && firstText.indexOf('タグ') !== 0) continue;

        const container = cells.length >= 2 ? cells[cells.length - 1] : cells[0];
        // 優先取標籤連結 (href 含 tag_a_id)
        let anchors = Array.from(container.querySelectorAll('a'))
            .filter(a => /tag_a_id=/.test(a.getAttribute('href') || ''));
        if (!anchors.length) anchors = Array.from(container.querySelectorAll('a'));
        let tags = anchors.map(a => (a.textContent || '').trim()).filter(t => t && t !== 'タグ');
        if (!tags.length) {
            // 後備: 直接切分值文字
            const v = (container.textContent || '').replace(/^\s*タグ/, '').trim();
            tags = v.split(/[\s,、]+/).map(s => s.trim()).filter(s => s);
        }
        return [...new Set(tags)];
    }
    return [];
}

// 解析演員頁 HTML, 取出檔案資料
function parseProfile(htmlBody) {
    const result = { name_reading: '', aliases: [], birthdate: '', sizes: '', av_period: '', image_url: '', tags: [] };
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
            result.sizes = cleanValue(value);
        } else if (label === 'AV出演期間') {
            result.av_period = cleanValue(value);
        }
    }

    // タグ (標籤清單)
    result.tags = extractTags(doc);

    return result;
}

// 對外主函式: 依名稱抓取演員資料
async function scrapeActorByName(rawName) {
    const found = await findActress(rawName);
    if (!found) return { success: false, message: '在 minnano-av 找不到符合的演員' };
    const data = parseProfile(found.body);
    return { success: true, data, sourceUrl: found.url };
}

module.exports = {
    scrapeActorByName,
    lookupActress,
    scrapeActressUrl,
    parseProfile,
    downloadImage,
    guessImageExt,
    cleanSearchName
};
