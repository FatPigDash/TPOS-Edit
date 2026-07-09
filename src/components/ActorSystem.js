const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const path = require('path');
const fs = require('fs');
const { webUtils, shell } = require('electron');
const {
    MoreVertical, Edit, Trash2, Users, AlertTriangle, Star,
    Upload, Plus, Search, X, GitMerge, ArrowRight, Zap, RefreshCw, ArrowLeft,
    Globe, Loader2, StopCircle, ArrowUpDown
} = require('lucide-react');

// 反轉排序方向 (asc <-> desc)
const toggleSortDirection = (order) => {
    if (order.endsWith('_asc')) return order.slice(0, -4) + '_desc';
    if (order.endsWith('_desc')) return order.slice(0, -5) + '_asc';
    return order;
};

const { db, actorsImgDir } = require('../utils/db');
// 引入 findSmartMatchActor 與 parseNameWithAliases
const {
    getFileUrl, getNewActorNumber, parseSearchQuery, stopPropagation, findSmartMatchActor, parseNameWithAliases
} = require('../utils/helpers');
const {
    ConfirmModal, Modal, ImageViewerModal, Pagination, SearchHelpText
} = require('./Shared');
const { WorkCard } = require('./WorkSystem');
const { scrapeActorByName, lookupActress, scrapeActressUrl, parseProfile, downloadImage, guessImageExt, cleanSearchName } = require('./ActorScraper');

// 將抓取到的資料寫入資料庫 (供自動與手動選擇共用)
// 回傳 { status: 'updated', imageUpdated } 或 { status: 'error', message }
async function applyScrapedData(actor, d) {
    try {
        // 別名: 直接以抓取結果覆蓋舊資料 (避免新舊格式造成重複), 並去除重複
        const aliasesStr = [...new Set((d.aliases || []).map(a => (a || '').trim()).filter(s => s))].join(',');

        // 文字欄位: 有抓到才覆蓋, 否則保留原值
        const birthdate = d.birthdate || actor.birthdate || null;
        const sizes = d.sizes || actor.sizes || null;
        const avPeriod = d.av_period || actor.av_period || null;
        const nameReading = d.name_reading || actor.name_reading || null;
        // タグ: 直接以抓取結果覆蓋 (去重)
        const tagsStr = [...new Set((d.tags || []).map(t => (t || '').trim()).filter(s => s))].join(',');

        // 來源網址: 有抓到才覆蓋, 否則保留原值 (使用者可於編輯視窗手動修改此欄位)
        const sourceUrl = d.source_url || actor.source_url || null;

        // 名稱: 移除括號內的別名 (別名已存於別名欄位); 若清理後為空則保留原名
        const cleanedName = cleanSearchName(actor.name) || actor.name;

        db.prepare('UPDATE actors SET name = ?, aliases = ?, birthdate = ?, sizes = ?, av_period = ?, name_reading = ?, tags = ?, scrape_failed = 0, source_url = ? WHERE id = ?')
            .run(cleanedName, aliasesStr, birthdate, sizes, avPeriod, nameReading, tagsStr, sourceUrl, actor.id);

        // 圖片: 僅在原本沒有圖片時才下載
        let imageUpdated = false;
        if (!actor.image_path && d.image_url) {
            const ext = guessImageExt(d.image_url);
            const fileName = `actors_${actor.actor_number}_001${ext}`;
            const destPath = path.join(actorsImgDir, fileName);
            try {
                await downloadImage(d.image_url, destPath);
                db.prepare('UPDATE actors SET image_path = ? WHERE id = ?').run(fileName, actor.id);
                imageUpdated = true;
            } catch (e) { /* 圖片下載失敗不影響文字資料 */ }
        }
        return { status: 'updated', imageUpdated };
    } catch (e) {
        return { status: 'error', message: e.message };
    }
}

// 若演員已有來源網址, 優先直接抓取該網址 (較快且避免同名/改名造成搜尋結果跑掉);
// 網址失效 (例如頁面下架) 時退回用姓名搜尋。回傳格式與 scrapeActorByName 相同。
async function scrapeActorAuto(actor) {
    if (actor.source_url) {
        try {
            const r = await scrapeActressUrl(actor.source_url);
            return { success: true, data: r.data, sourceUrl: r.sourceUrl };
        } catch (e) { /* 網址失效, 退回姓名搜尋 */ }
    }
    return scrapeActorByName(actor.name);
}

// 自動抓取並寫入 (供批量抓取與失敗清單重新掃描使用; 多筆結果時自動比對/略過, 不互動)
// 回傳 { status: 'updated' | 'notfound' | 'error', message?, imageUpdated? }
async function scrapeAndUpdateActor(actor) {
    let res;
    try {
        res = await scrapeActorAuto(actor);
    } catch (e) {
        try { db.prepare('UPDATE actors SET scrape_failed = 1 WHERE id = ?').run(actor.id); } catch (e2) { }
        return { status: 'error', message: e.message };
    }
    if (!res.success) {
        try { db.prepare('UPDATE actors SET scrape_failed = 1 WHERE id = ?').run(actor.id); } catch (e) { }
        return { status: 'notfound', message: res.message };
    }
    res.data.source_url = res.sourceUrl;
    const result = await applyScrapedData(actor, res.data);
    if (result.status !== 'updated') {
        try { db.prepare('UPDATE actors SET scrape_failed = 1 WHERE id = ?').run(actor.id); } catch (e) { }
    }
    return result;
}

// 6. 演員系統元件 (Actor System)

function ActorCard({ actor, onEdit, onDelete, onMerge, onOpenDetail, onToggleFavorite, onSearch }) {
    const [showMenu, setShowMenu] = React.useState(false);
    const menuRef = React.useRef(null);
    const [imageError, setImageError] = React.useState(false);

    let imgSrc = null;
    if (actor.image_path) {
        imgSrc = getFileUrl(path.join(actorsImgDir, actor.image_path));
        if (actor.cacheBust) imgSrc += `?t=${actor.cacheBust}`;
    }

    React.useEffect(() => {
        const handleClickOutside = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false); };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    React.useEffect(() => { setImageError(false); }, [actor.id, actor.image_path, actor.cacheBust]);

    const handleImageError = () => {
        setImageError(true);
        if (actor.id && actor.image_path) {
            try { setTimeout(() => { db.prepare('UPDATE actors SET image_path = NULL WHERE id = ?').run(actor.id); }, 0); } catch (e) { }
        }
    };

    return html`
        <div className="work-card actor-card" style=${{ position: 'relative' }}>
            <div style=${{ position: 'absolute', top: 4, right: 4, zIndex: 10 }} ref=${menuRef}>
                <button className="btn-ghost" style=${{ padding: '4px', background: 'rgba(255,255,255,0.8)', borderRadius: '50%' }} onClick=${(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}>
                    <${MoreVertical} size=${16} />
                </button>
                ${showMenu && html`
                    <div className="kebab-menu" style=${{ position: 'absolute', top: '100%', right: 0, backgroundColor: '#fff', border: '1px solid #eee', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', zIndex: 20, minWidth: '120px', overflow: 'hidden' }}>
                        <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid #eee', fontSize: '14px', color: '#333', backgroundColor: '#fff' }} onClick=${(e) => { e.stopPropagation(); setShowMenu(false); onEdit(actor.id); }}>
                            <${Edit} size=${16} /> 編輯
                        </div>
                        <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid #eee', fontSize: '14px', color: '#333', backgroundColor: '#fff' }} onClick=${(e) => { e.stopPropagation(); setShowMenu(false); onMerge(actor); }}>
                            <${GitMerge} size=${16} /> 合併至...
                        </div>
                        <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', color: '#dc3545', fontSize: '14px', backgroundColor: '#fff' }} onClick=${(e) => { e.stopPropagation(); setShowMenu(false); onDelete(actor.id); }}>
                            <${Trash2} size=${16} /> 刪除
                        </div>
                    </div>
                `}
            </div>
            <div style=${{ padding: '8px', fontSize: '12px', color: '#666', fontWeight: 'bold' }}>${actor.actor_number}</div>
            <div className="card-cover" onClick=${() => onOpenDetail(actor.id)} title="查看詳細資料" style=${{ cursor: 'pointer', height: '180px' }}>
                ${imgSrc && !imageError ? html`<img src="${imgSrc}" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} onError=${handleImageError} />` : (imageError ? html`<div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#e6a700' }}><${AlertTriangle} size=${48} /><span style=${{ marginTop: 4, fontWeight: 'bold' }}>ERROR</span></div>` : html`<${Users} size=${48} color="#ccc" />`)}
            </div>
            <div className="card-info">
                <div className="card-title" title=${actor.name} onClick=${() => onOpenDetail(actor.id)} style=${{ cursor: 'pointer' }}>${actor.name}</div>
                ${(actor.aliases || actor.custom_aliases) && html`<div style=${{ fontSize: '11px', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>(${[actor.aliases, actor.custom_aliases].filter(s => s && s.trim()).join(', ')})</div>`}
                <div style=${{ fontSize: '12px', color: '#666', marginBottom: '4px', marginTop: '4px' }}>
                    <span>作品: ${actor.work_count || 0}部</span>
                </div>
                <div style=${{ marginTop: '4px', cursor: 'pointer', display: 'inline-block' }} onClick=${(e) => { e.stopPropagation(); onToggleFavorite(actor.id, actor.is_favorite); }}>
                    <${Star} size=${16} fill=${actor.is_favorite ? "#fbc02d" : "none"} color=${actor.is_favorite ? "#fbc02d" : "#ccc"} />
                </div>
            </div>
        </div>`;
}

function ActorEditModal({ actorId, onClose, onSaveSuccess, setIsLoading }) {
    const isEdit = !!actorId;
    const [name, setName] = React.useState("");
    const [aliasItems, setAliasItems] = React.useState([""]); // 自訂別名清單 (custom_aliases)
    const [autoAliases, setAutoAliases] = React.useState(""); // 自動別名 (aliases, 唯讀顯示)
    const [birthdate, setBirthdate] = React.useState("");
    const [sizes, setSizes] = React.useState("");
    const [avPeriod, setAvPeriod] = React.useState("");
    const [tags, setTags] = React.useState("");
    const [sourceUrl, setSourceUrl] = React.useState("");
    const [actorNumber, setActorNumber] = React.useState("");
    const [image, setImage] = React.useState(null);
    const [originalImage, setOriginalImage] = React.useState(null);
    const [isFavorite, setIsFavorite] = React.useState(0);
    const fileInputRef = React.useRef(null);
    const [initialState, setInitialState] = React.useState(null);
    const [showDirtyWarning, setShowDirtyWarning] = React.useState(false);

    // 別名動態清單操作 (預設一欄，可自行增減)
    const splitAliases = (str) => {
        const arr = (str || "").split(/[,，]/).map(s => s.trim()).filter(s => s);
        return arr.length ? arr : [""];
    };
    const cleanAliases = (arr) => arr.map(s => s.trim()).filter(s => s);
    const updateAlias = (idx, v) => setAliasItems(prev => prev.map((x, i) => i === idx ? v : x));
    const addAlias = () => setAliasItems(prev => [...prev, ""]);
    const removeAlias = (idx) => setAliasItems(prev => prev.length <= 1 ? [""] : prev.filter((_, i) => i !== idx));

    React.useEffect(() => {
        if (!db) return;
        if (isEdit) {
            const actor = db.prepare('SELECT * FROM actors WHERE id=?').get(actorId);
            if (actor) {
                setName(actor.name);
                setAutoAliases(actor.aliases || "");
                setAliasItems(splitAliases(actor.custom_aliases));
                setBirthdate(actor.birthdate || "");
                setSizes(actor.sizes || "");
                setAvPeriod(actor.av_period || "");
                setTags(actor.tags || "");
                setSourceUrl(actor.source_url || "");
                setActorNumber(actor.actor_number);
                let imgState = null;
                if (actor.image_path) {
                    const url = getFileUrl(path.join(actorsImgDir, actor.image_path));
                    imgState = { preview: url, isStored: true, path: actor.image_path };
                }
                setImage(imgState);
                setOriginalImage(actor.image_path);
                setIsFavorite(actor.is_favorite || 0);
                setInitialState({ name: actor.name, customAliases: cleanAliases(splitAliases(actor.custom_aliases)).join(','), birthdate: actor.birthdate || "", sizes: actor.sizes || "", avPeriod: actor.av_period || "", tags: actor.tags || "", sourceUrl: actor.source_url || "", image: imgState, isFavorite: actor.is_favorite || 0 });
            }
        } else {
            const num = getNewActorNumber(db);
            setActorNumber(num);
            setIsFavorite(0);
            setAutoAliases("");
            setAliasItems([""]);
            setTags("");
            setSourceUrl("");
            setInitialState({ name: '', customAliases: '', birthdate: '', sizes: '', avPeriod: '', tags: '', sourceUrl: '', image: null, isFavorite: 0 });
        }
    }, [actorId]);

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            if (!['image/jpeg', 'image/png'].includes(file.type)) return alert('僅支援 JPG/PNG');
            let realPath = file.path;
            if (!realPath) try { realPath = webUtils.getPathForFile(file); } catch (err) { }
            if (realPath) setImage({ preview: URL.createObjectURL(file), filePath: realPath, isNew: true });
        }
    };

    const handleDrop = (e) => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer.files[0]; if (file) handleFileChange({ target: { files: [file] } }); };

    const isDirty = () => {
        if (!initialState) return false;
        return name !== initialState.name || cleanAliases(aliasItems).join(',') !== initialState.customAliases || birthdate !== initialState.birthdate || sizes !== initialState.sizes || avPeriod !== initialState.avPeriod || tags !== initialState.tags || sourceUrl !== initialState.sourceUrl || isFavorite !== initialState.isFavorite || JSON.stringify(image) !== JSON.stringify(initialState.image);
    };

    const attemptClose = () => { if (isDirty()) setShowDirtyWarning(true); else onClose(); };

    const handleSave = () => {
        if (!db) return;
        const rawName = name.trim();
        if (!rawName) return alert('請輸入姓名');

        // Feature: 自動解析名稱中的括號內容
        // 修改: 括號別名歸入「自訂別名」, 名稱保留括號顯示
        const parsed = parseNameWithAliases(rawName);
        const finalName = rawName; // 使用原始名稱 (包含括號)
        const extractedAliases = parsed.aliases;

        // 自訂別名 = 表單輸入 + 名稱括號別名; 去重, 並排除與「自動別名」完全一致者 (沿用自動欄位)
        const currentCustom = cleanAliases(aliasItems);
        const autoList = (autoAliases || '').split(/[,，]/).map(s => s.trim()).filter(s => s);
        const mergedCustom = [...new Set([...currentCustom, ...extractedAliases])]
            .filter(a => !autoList.includes(a))
            .join(',');

        // 檢查重複 (使用智慧比對)
        const duplicateId = findSmartMatchActor(db, finalName);
        
        if (duplicateId) {
            if (!isEdit || (isEdit && duplicateId !== actorId)) {
                const dupActor = db.prepare('SELECT name, actor_number FROM actors WHERE id = ?').get(duplicateId);
                if (dupActor) {
                    alert(`已存在重複的演員！\n系統偵測到此名稱與現有資料庫衝突。\n\n【現有演員資訊】\n姓名: ${dupActor.name}\n編號: ${dupActor.actor_number}`);
                    setIsLoading(false);
                    return;
                }
            }
        }

        setIsLoading(true);
        setTimeout(() => {
            try {
                db.transaction(() => {
                    let currentId = actorId;
                    
                    const bd = birthdate.trim() || null;
                    const sz = sizes.trim() || null;
                    const avp = avPeriod.trim() || null;
                    const tg = tags.trim() || null;
                    const su = sourceUrl.trim() || null;
                    if (isEdit) {
                        // 注意: 不更新 aliases (自動別名由抓取管理, 表單唯讀), 僅寫入 custom_aliases
                        db.prepare('UPDATE actors SET name = ?, custom_aliases = ?, is_favorite = ?, birthdate = ?, sizes = ?, av_period = ?, tags = ?, source_url = ? WHERE id = ?').run(finalName, mergedCustom, isFavorite, bd, sz, avp, tg, su, actorId);
                    } else {
                        const info = db.prepare('INSERT INTO actors (actor_number, name, custom_aliases, created_at, is_favorite, birthdate, sizes, av_period, tags, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(actorNumber, finalName, mergedCustom, Date.now(), isFavorite, bd, sz, avp, tg, su);
                        currentId = info.lastInsertRowid;
                    }

                    if (image && image.isNew) {
                        const ext = path.extname(image.filePath);
                        const newFileName = `actors_${actorNumber}_001${ext}`;
                        const targetPath = path.join(actorsImgDir, newFileName);
                        if (originalImage && originalImage != newFileName) { try { fs.unlinkSync(path.join(actorsImgDir, originalImage)); } catch (e) { } }
                        fs.copyFileSync(image.filePath, targetPath);
                        db.prepare('UPDATE actors SET image_path = ? WHERE id = ?').run(newFileName, currentId);
                    } else if (!image && originalImage) {
                        try { fs.unlinkSync(path.join(actorsImgDir, originalImage)); } catch (e) { }
                        db.prepare('UPDATE actors SET image_path = NULL WHERE id = ?').run(currentId);
                    }
                    
                    // 自動關聯文字連結 (使用新名稱)
                    db.prepare('UPDATE work_actor_link SET actor_id = ?, actor_name = NULL WHERE actor_id IS NULL AND actor_name = ?').run(currentId, finalName);
                })();
                setTimeout(() => {
                    setIsLoading(false);
                    onSaveSuccess();
                    onClose();
                }, 100);
            } catch (e) { setIsLoading(false); alert(e.message); }
        }, 100);
    };

    return html`
        ${showDirtyWarning && html`<${ConfirmModal} title="尚未儲存的變更" message="您有尚未儲存的變更, 確定要捨棄嗎?" confirmText="繼續編輯" cancelText="放棄變更" onConfirm=${() => setShowDirtyWarning(false)} onCancel=${onClose} />`}
        <${Modal} title=${isEdit ? '編輯演員' : '新增演員'} onClose=${attemptClose} footer=${html`<div style=${{ display: 'flex', gap: '8px', justifyContent: 'flex-end', width: '100%' }}> <button className="btn-block" onClick=${attemptClose}>取消</button> <button className="btn-primary" onClick=${handleSave}>確認</button></div>`}>
            <div className="actor-edit-form">
                <div className="filter-group">
                    <label className="filter-label">演員編號</label>
                    <input className="filter-input" value=${actorNumber} disabled style=${{ backgroundColor: '#eee' }} />
                </div>
                <div className="filter-group">
                    <label className="filter-label">演員姓名</label>
                    <input className="filter-input" value=${name} onInput=${e => setName(e.target.value)} placeholder="輸入姓名..." />
                    <small style=${{color: '#888', display: 'block', marginTop: '4px'}}>* 提示: 若輸入 "姓名 (別名)"，儲存時括號別名會加入「自訂別名」，且顯示名稱保留括號。</small>
                </div>
                <div className="filter-group">
                    <label className="filter-label">別名 (自動抓取) <span style=${{fontSize:'12px', color:'#888', fontWeight:'normal'}}>唯讀・由線上抓取管理</span></label>
                    <div className="filter-input" style=${{ backgroundColor: '#eee', minHeight: '38px', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', cursor: 'not-allowed' }}>
                        ${autoAliases && autoAliases.split(/[,，]/).map(s => s.trim()).filter(s => s).length > 0
                            ? autoAliases.split(/[,，]/).map(s => s.trim()).filter(s => s).map((a, i) => html`<span key=${i} style=${{ fontSize: '13px', padding: '2px 8px', borderRadius: '10px', backgroundColor: '#fff', border: '1px solid #ddd', color: '#555' }}>${a}</span>`)
                            : html`<span style=${{ color: '#aaa' }}>—</span>`}
                    </div>
                </div>
                <div className="filter-group">
                    <label className="filter-label">自訂別名 / 舊藝名 <span style=${{fontSize:'12px', color:'#888', fontWeight:'normal'}}>(可新增多筆・合併與手動輸入, 不受抓取影響)</span></label>
                    ${aliasItems.map((val, idx) => html`
                        <div key=${idx} style=${{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                            <input className="filter-input" style=${{ flex: 1 }} value=${val} onInput=${e => updateAlias(idx, e.target.value)} placeholder=${`自訂別名 ${idx + 1}`} />
                            <button type="button" className="btn-ghost" title="移除此別名" style=${{ padding: '6px', flexShrink: 0, opacity: aliasItems.length <= 1 ? 0.3 : 1 }} disabled=${aliasItems.length <= 1} onClick=${() => removeAlias(idx)}>
                                <${Trash2} size=${16} />
                            </button>
                        </div>
                    `)}
                    <button type="button" className="btn-block" style=${{ width: 'auto', padding: '6px 12px', display: 'inline-flex', alignItems: 'center' }} onClick=${addAlias}>
                        <${Plus} size=${14} style=${{ marginRight: 4 }} /> 新增自訂別名
                    </button>
                </div>
                <div className="filter-group">
                    <label className="filter-label">生年月日</label>
                    <input className="filter-input" value=${birthdate} onInput=${e => setBirthdate(e.target.value)} placeholder="例如: 1993年8月16日" />
                </div>
                <div className="filter-group">
                    <label className="filter-label">サイズ (三圍)</label>
                    <input className="filter-input" value=${sizes} onInput=${e => setSizes(e.target.value)} placeholder="例如: T159 / B88(F) / W58 / H86" />
                </div>
                <div className="filter-group">
                    <label className="filter-label">AV出演期間</label>
                    <input className="filter-input" value=${avPeriod} onInput=${e => setAvPeriod(e.target.value)} placeholder="例如: 2015年 ～" />
                </div>
                <div className="filter-group">
                    <label className="filter-label">タグ <span style=${{fontSize:'12px', color:'#888', fontWeight:'normal'}}>(以逗號區隔)</span></label>
                    <input className="filter-input" value=${tags} onInput=${e => setTags(e.target.value)} placeholder="例如: 巨乳, 美乳, 芸能人" />
                </div>
                <div className="filter-group">
                    <label className="filter-label">來源網址 <span style=${{fontSize:'12px', color:'#888', fontWeight:'normal'}}>(自動抓取・可手動編輯)</span></label>
                    <input className="filter-input" value=${sourceUrl} onInput=${e => setSourceUrl(e.target.value)} placeholder="例如: https://www.minnano-av.com/actress12345.html" />
                </div>
                <div className="filter-group">
                    <label className="filter-label">關注演員</label>
                    <div style=${{ cursor: 'pointer', display: 'inline-block' }} onClick=${() => setIsFavorite(isFavorite ? 0 : 1)}>
                        <${Star} size=${24} fill=${isFavorite ? "#fbc02d" : "none"} color=${isFavorite ? "#fbc02d" : "#ccc"} />
                        <span style=${{ marginLeft: '8px', verticalAlign: 'middle', color: isFavorite ? '#fbc02d' : '#666', fontWeight: isFavorite ? 'bold' : 'normal' }}>${isFavorite ? '已關注' : '未關注'}</span>
                    </div>
                </div>
                <div className="filter-group">
                    <label className="filter-label">圖片</label>
                    <div style=${{ width: '100%', height: '200px', border: '2px dashed #ccc', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }} onDragOver=${e => e.preventDefault()} onDrop=${handleDrop}>
                        ${image ? html`
                            <img src=${image.preview} style=${{ width: '100%', height: '100%', objectFit: 'contain' }} />
                            <button onClick=${() => setImage(null)} style=${{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.5)', color: 'white', border: 'none', borderRadius: '50%', padding: 4, cursor: 'pointer' }}><${Trash2} size=${16}/></button>
                        ` : html`
                            <div style=${{ textAlign: 'center', color: '#999', cursor: 'pointer' }} onClick=${() => fileInputRef.current.click()}>
                                <${Upload} size=${24} style=${{ marginBottom: 8 }}/>
                                <div>點擊或拖曳圖片至此</div>
                                <input type="file" ref=${fileInputRef} style=${{ display: 'none' }} accept="image/jpeg, image/png" onChange=${handleFileChange} />
                            </div>
                        `}
                    </div>
                </div>
            </div>
        <//>`;
}

function MergeActorModal({ sourceActor, onClose, onMergeSuccess }) {
    const [searchQuery, setSearchQuery] = React.useState('');
    const [candidates, setCandidates] = React.useState([]);
    const [targetActor, setTargetActor] = React.useState(null);
    const [useSourceImage, setUseSourceImage] = React.useState(true);

    const handleSearch = (e) => {
        if (e.key === 'Enter') {
            if (!searchQuery.trim()) return;
            // 搜尋除了自己以外的演員
            const rows = db.prepare(`
                SELECT * FROM actors
                WHERE (name LIKE ? OR aliases LIKE ? OR custom_aliases LIKE ?)
                AND id != ? AND is_deleted = 0
                LIMIT 10
            `).all(`%${searchQuery.trim()}%`, `%${searchQuery.trim()}%`, `%${searchQuery.trim()}%`, sourceActor.id);
            setCandidates(rows);
            setTargetActor(null);
        }
    };

    const executeMerge = () => {
        if (!targetActor) return;
        if (!confirm(`確定要將「${sourceActor.name}」合併至「${targetActor.name}」嗎？\n此操作無法復原，${sourceActor.name} 將會被刪除。`)) return;

        try {
            db.transaction(() => {
                // 1. 處理別名: 來源的本名 / 別名 / 自訂別名 併入「目標的自訂別名 (custom_aliases)」。
                //    與目標「自動別名 (aliases)」完全一致者略過 (沿用自動欄位); 自訂別名不受抓取覆蓋。
                const targetAutoAliases = targetActor.aliases ? targetActor.aliases.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
                const targetCustom = targetActor.custom_aliases ? targetActor.custom_aliases.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];

                const incoming = [sourceActor.name];
                if (sourceActor.aliases) incoming.push(...sourceActor.aliases.split(/[,，]/));
                if (sourceActor.custom_aliases) incoming.push(...sourceActor.custom_aliases.split(/[,，]/));

                for (const raw of incoming) {
                    const v = (raw || '').trim();
                    if (!v) continue;
                    if (targetAutoAliases.includes(v)) continue; // 與自動別名完全一致 -> 沿用自動欄位
                    if (targetCustom.includes(v)) continue;       // 已在自訂別名中
                    targetCustom.push(v);
                }

                db.prepare('UPDATE actors SET custom_aliases = ? WHERE id = ?').run(targetCustom.join(','), targetActor.id);

                // 2. 轉移作品關聯
                const sourceLinks = db.prepare('SELECT work_id FROM work_actor_link WHERE actor_id = ?').all(sourceActor.id);
                for (const link of sourceLinks) {
                    // 檢查目標是否已經關聯此作品
                    const exists = db.prepare('SELECT 1 FROM work_actor_link WHERE work_id = ? AND actor_id = ?').get(link.work_id, targetActor.id);
                    if (exists) {
                        // 如果重複，直接刪除來源的連結
                        db.prepare('DELETE FROM work_actor_link WHERE work_id = ? AND actor_id = ?').run(link.work_id, sourceActor.id);
                    } else {
                        // 如果沒重複，將連結轉移給目標
                        db.prepare('UPDATE work_actor_link SET actor_id = ? WHERE work_id = ? AND actor_id = ?').run(targetActor.id, link.work_id, sourceActor.id);
                    }
                }

                // 3. 處理圖片 (若目標無圖片且選項開啟，轉移來源圖片)
                if (!targetActor.image_path && sourceActor.image_path && useSourceImage) {
                    db.prepare('UPDATE actors SET image_path = ? WHERE id = ?').run(sourceActor.image_path, targetActor.id);
                    // 為了避免 source 被刪除時觸發圖片刪除邏輯(如果有 cleanup)，這裡先將 source 置空
                    db.prepare('UPDATE actors SET image_path = NULL WHERE id = ?').run(sourceActor.id);
                }

                // 4. 刪除來源演員 (標記為刪除)
                if (sourceActor.image_path) {
                    const imgPath = path.join(actorsImgDir, sourceActor.image_path);
                    if (fs.existsSync(imgPath) && (!targetActor.image_path || targetActor.image_path !== sourceActor.image_path)) {
                        // 只有當圖片沒有被轉移時才刪除
                        try { fs.unlinkSync(imgPath); } catch(e){}
                    }
                }
                
                db.prepare('DELETE FROM actors WHERE id = ?').run(sourceActor.id);

            })();
            alert('合併完成！');
            onMergeSuccess();
            onClose();
        } catch (err) {
            console.error(err);
            alert('合併失敗: ' + err.message);
        }
    };

    return html`
        <${Modal} title="合併演員卡片" onClose=${onClose} footer=${null}>
            <div style=${{ display: 'flex', flexDirection: 'column', gap: '16px', minHeight: '300px' }}>
                <div style=${{ padding: '10px', background: '#f8f9fa', borderRadius: '4px', border: '1px solid #ddd' }}>
                    <strong>來源 (將被刪除): </strong> ${sourceActor.name} <br/>
                    <small style=${{color:'#666'}}>ID: ${sourceActor.actor_number} | 作品: ${sourceActor.work_count || 0} 部</small>
                </div>

                <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>
                    <${ArrowRight} size=${24} />
                    <span style=${{ margin: '0 8px' }}>合併至</span>
                    <${ArrowRight} size=${24} />
                </div>

                ${!targetActor ? html`
                    <div>
                        <label className="filter-label">搜尋目標演員 (保留的卡片)</label>
                        <div style=${{ display: 'flex', gap: '8px' }}>
                            <input className="filter-input" value=${searchQuery} onInput=${e => setSearchQuery(e.target.value)} onKeyDown=${handleSearch} placeholder="輸入名字按 Enter 搜尋..." autoFocus />
                            <button className="btn-primary" onClick=${() => handleSearch({key:'Enter'})}>搜尋</button>
                        </div>
                        <div style=${{ marginTop: '8px', maxHeight: '150px', overflowY: 'auto', border: '1px solid #eee' }}>
                            ${candidates.map(c => html`
                                <div className="menu-item" style=${{ padding: '8px', cursor: 'pointer', borderBottom: '1px solid #eee' }} onClick=${() => setTargetActor(c)}>
                                    <div style=${{ fontWeight: 'bold' }}>${c.name}</div>
                                    <div style=${{ fontSize: '12px', color: '#666' }}>ID: ${c.actor_number} | 別名: ${[c.aliases, c.custom_aliases].filter(s => s && s.trim()).join(', ') || '無'}</div>
                                </div>
                            `)}
                            ${candidates.length === 0 && searchQuery && html`<div style=${{ padding: '8px', color: '#999', textAlign: 'center' }}>無搜尋結果</div>`}
                        </div>
                    </div>
                ` : html`
                    <div style=${{ padding: '10px', background: '#e3f2fd', borderRadius: '4px', border: '1px solid #90caf9', position: 'relative' }}>
                        <button style=${{ position: 'absolute', top: 4, right: 4, background: 'none', border: 'none', cursor: 'pointer' }} onClick=${() => setTargetActor(null)}><${X} size=${16} /></button>
                        <strong>目標 (保留): </strong> ${targetActor.name} <br/>
                        <small style=${{color:'#666'}}>ID: ${targetActor.actor_number}</small>
                        <div style=${{ marginTop: '8px', fontSize: '12px', color: '#0d47a1' }}>
                            <ul style=${{ margin: '4px 0', paddingLeft: '20px' }}>
                                <li>${sourceActor.name} 將加入自訂別名</li>
                                <li>${sourceActor.work_count || 0} 部作品將轉移至此</li>
                            </ul>
                        </div>
                    </div>
                    
                    ${!targetActor.image_path && sourceActor.image_path && html`
                        <label style=${{ display: 'flex', alignItems: 'center', fontSize: '14px', cursor: 'pointer', marginTop: 8 }}>
                            <input type="checkbox" checked=${useSourceImage} onChange=${e => setUseSourceImage(e.target.checked)} style=${{ marginRight: 8 }} />
                            目標無圖片，使用來源圖片
                        </label>
                    `}

                    <button className="btn-primary" style=${{ marginTop: 'auto', width: '100%', padding: '12px', backgroundColor: '#d32f2f' }} onClick=${executeMerge}>
                        <${GitMerge} size=${16} style=${{ marginRight: 8 }} />
                        確認合併並刪除來源
                    </button>
                `}
            </div>
        <//>
    `;
}

// 女優詳細頁面 (Actor Detail Page)
function ActorDetail({ actorId, onBack, onNavigateToWorkDetails, setIsLoading }) {
    const WORKS_PER_PAGE = 15;
    const [actor, setActor] = React.useState(null);
    const [works, setWorks] = React.useState([]);
    const [page, setPage] = React.useState(1);
    const [totalPages, setTotalPages] = React.useState(1);
    const [totalWorks, setTotalWorks] = React.useState(0);
    const [viewingImage, setViewingImage] = React.useState(null);
    const [imageError, setImageError] = React.useState(false);
    const [imgTs, setImgTs] = React.useState(0); // 圖片快取破壞用時間戳 (換圖後即時刷新)
    const [scraping, setScraping] = React.useState(false);
    const [editing, setEditing] = React.useState(false);
    const [candidates, setCandidates] = React.useState(null); // null | [{id,name,url,thumb,info}]

    const reloadActor = () => {
        try {
            const a = db.prepare('SELECT * FROM actors WHERE id = ?').get(actorId);
            if (a) { setActor(a); setImageError(false); setImgTs(Date.now()); }
        } catch (e) { console.error(e); }
    };

    React.useEffect(() => {
        if (!db || !actorId) return;
        try {
            const a = db.prepare('SELECT * FROM actors WHERE id = ?').get(actorId);
            setActor(a);
        } catch (e) { console.error(e); }
        setImageError(false);
        setPage(1);
    }, [actorId]);

    // 標記/取消標記此演員的資料抓取失敗狀態
    const markScrapeFailed = (failed) => {
        try {
            db.prepare('UPDATE actors SET scrape_failed = ? WHERE id = ?').run(failed ? 1 : 0, actorId);
            reloadActor();
        } catch (e) { console.error(e); }
    };

    // 抓取此演員資訊 (minnano-av); 若已有來源網址則優先直接抓取該網址, 失效才退回姓名搜尋; 多筆候選時讓使用者選擇
    const handleScrapeThis = async () => {
        if (!actor || scraping) return;
        setScraping(true);
        try {
            if (actor.source_url) {
                try {
                    const r = await scrapeActressUrl(actor.source_url);
                    r.data.source_url = r.sourceUrl;
                    const applied = await applyScrapedData(actor, r.data);
                    if (applied.status === 'updated') { reloadActor(); return; }
                } catch (e) { /* 來源網址已失效, 退回姓名搜尋 */ }
            }
            const res = await lookupActress(actor.name);
            if (res.type === 'none') {
                alert('在 minnano-av 找不到此演員的資料。');
                markScrapeFailed(true);
            } else if (res.type === 'single') {
                const data = parseProfile(res.body);
                data.source_url = res.url;
                const r = await applyScrapedData(actor, data);
                if (r.status === 'updated') reloadActor();
                else { alert('抓取失敗: ' + (r.message || '未知錯誤')); markScrapeFailed(true); }
            } else if (res.type === 'multiple') {
                setCandidates(res.candidates);
            }
        } catch (e) {
            alert('抓取失敗: ' + e.message);
            markScrapeFailed(true);
        } finally {
            setScraping(false);
        }
    };

    // 候選太多時, 用別名等關鍵字重新搜尋網站
    const handleResearch = async (keyword) => {
        const kw = (keyword || '').trim();
        if (!kw) return;
        const res = await lookupActress(kw);
        if (res.type === 'none') {
            alert('找不到「' + kw + '」的資料。');
        } else if (res.type === 'single') {
            const data = parseProfile(res.body);
            data.source_url = res.url;
            const r = await applyScrapedData(actor, data);
            setCandidates(null);
            if (r.status === 'updated') reloadActor();
            else { alert('抓取失敗: ' + (r.message || '未知錯誤')); markScrapeFailed(true); }
        } else if (res.type === 'multiple') {
            setCandidates(res.candidates);
        }
    };

    // 使用者從候選清單選定一位後抓取
    const handlePickCandidate = async (c) => {
        setCandidates(null);
        if (!actor) return;
        setScraping(true);
        try {
            const r = await scrapeActressUrl(c.url);
            r.data.source_url = r.sourceUrl;
            const applied = await applyScrapedData(actor, r.data);
            if (applied.status === 'updated') reloadActor();
            else { alert('抓取失敗: ' + (applied.message || '未知錯誤')); markScrapeFailed(true); }
        } catch (e) {
            alert('抓取失敗: ' + e.message);
            markScrapeFailed(true);
        }
        setScraping(false);
    };

    const loadWorks = () => {
        if (!db || !actorId) return;
        setIsLoading(true);
        setTimeout(() => {
            try {
                const total = db.prepare('SELECT COUNT(*) AS c FROM work_actor_link WHERE actor_id = ?').get(actorId).c;
                setTotalWorks(total);
                const totalP = Math.ceil(total / WORKS_PER_PAGE) || 1;
                setTotalPages(totalP);
                let targetPage = Math.min(page, totalP);
                if (targetPage < 1) targetPage = 1;
                const offset = (targetPage - 1) * WORKS_PER_PAGE;

                const rows = db.prepare(`
                    SELECT w.*, wi.file_name AS cover_image,
                        (SELECT COUNT(*) FROM work_actor_link wal JOIN actors a ON wal.actor_id = a.id WHERE wal.work_id = w.id AND a.is_favorite = 1) AS fav_actor_count
                    FROM works w
                    JOIN work_actor_link l ON w.id = l.work_id AND l.actor_id = ?
                    LEFT JOIN work_images wi ON w.id = wi.work_id AND wi.is_cover = 1
                    ORDER BY w.created_at DESC
                    LIMIT ? OFFSET ?
                `).all(actorId, WORKS_PER_PAGE, offset);

                const firstGroupOrderResult = db.prepare('SELECT MIN(sort_order) as min_order FROM tag_groups').get();
                const globalFirstGroupOrder = firstGroupOrderResult ? firstGroupOrderResult.min_order : null;
                rows.forEach(row => {
                    try {
                        row.tags = db.prepare(`SELECT t.name, t.color, tg.sort_order as group_sort_order FROM work_tag_link wtl JOIN tags t ON wtl.tag_id = t.id JOIN tag_groups tg ON t.group_id = tg.id WHERE wtl.work_id = ? ORDER BY tg.sort_order ASC, t.sort_order ASC`).all(row.id);
                        row.firstGroupOrder = globalFirstGroupOrder;
                    } catch (e) { row.tags = []; row.firstGroupOrder = null; }
                });
                setWorks(rows);
            } catch (e) { console.error(e); }
            setIsLoading(false);
        }, 30);
    };

    React.useEffect(() => { loadWorks(); }, [actorId, page]);

    if (!actor) return null;

    let imgSrc = null;
    if (actor.image_path) {
        imgSrc = getFileUrl(path.join(actorsImgDir, actor.image_path));
        if (imgTs) imgSrc += `?t=${imgTs}`;
    }
    const hasImg = imgSrc && !imageError;

    const aliasList = actor.aliases ? actor.aliases.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
    const customAliasList = actor.custom_aliases ? actor.custom_aliases.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
    const tagList = actor.tags ? actor.tags.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];

    const labelStyle = { width: '110px', flexShrink: 0, color: '#888', fontSize: '14px', fontWeight: 'bold' };
    const rowStyle = { display: 'flex', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid #f0f0f0' };
    const emptyStyle = { color: '#bbb' };

    return html`
        <div className="main-layout">
            <div className="content-area">
                <div className="content-header">
                    <div className="result-info" style=${{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '18px', fontWeight: 'bold' }}>
                        <button className="btn-ghost" onClick=${onBack} title="返回上一頁" style=${{ padding: '4px', display: 'flex', alignItems: 'center' }}>
                            <${ArrowLeft} size=${20} />
                        </button>
                        演員編號 ${actor.actor_number}
                        <button className="btn-primary" onClick=${handleScrapeThis} disabled=${scraping} title="從 minnano-av 抓取此演員資訊"
                            style=${{ marginLeft: '8px', padding: '4px 12px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: scraping ? 0.6 : 1 }}>
                            ${scraping
                                ? html`<${Loader2} size=${15} className="spin-anim" /> 抓取中...`
                                : html`<${Globe} size=${15} /> 抓取資訊`}
                        </button>
                        <button className="btn-block" onClick=${() => setEditing(true)} disabled=${scraping} title="編輯此演員的個人檔案"
                            style=${{ marginLeft: '8px', padding: '4px 12px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <${Edit} size=${15} /> 編輯
                        </button>
                    </div>
                </div>

                <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '24px', padding: '20px', alignItems: 'flex-start' }}>
                    <div style=${{ flex: '0 0 320px', maxWidth: '100%' }}>
                        <div onClick=${() => hasImg && setViewingImage(imgSrc)} style=${{ width: '100%', height: '420px', border: '1px solid #eee', borderRadius: '8px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fafafa', cursor: hasImg ? 'zoom-in' : 'default' }}>
                            ${hasImg
                                ? html`<img src="${imgSrc}" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} onError=${() => setImageError(true)} />`
                                : (imageError
                                    ? html`<div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: '#e6a700' }}><${AlertTriangle} size=${48} /><span style=${{ marginTop: 4, fontWeight: 'bold' }}>ERROR</span></div>`
                                    : html`<${Users} size=${64} color="#ccc" />`)
                            }
                        </div>
                        <div style=${{ marginTop: '10px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }} onClick=${() => {
                            const newStatus = actor.is_favorite ? 0 : 1;
                            try {
                                db.prepare('UPDATE actors SET is_favorite = ? WHERE id = ?').run(newStatus, actorId);
                                reloadActor();
                            } catch (e) { console.error(e); }
                        }}>
                            <${Star} size=${22} fill=${actor.is_favorite ? "#fbc02d" : "none"} color=${actor.is_favorite ? "#fbc02d" : "#ccc"} />
                            <span style=${{ marginLeft: '8px', color: actor.is_favorite ? '#fbc02d' : '#666', fontWeight: actor.is_favorite ? 'bold' : 'normal' }}>${actor.is_favorite ? '已關注' : '未關注'}</span>
                        </div>
                        ${actor.scrape_failed ? html`
                            <div style=${{ marginTop: '6px', display: 'inline-flex', alignItems: 'center', color: '#dc3545' }}>
                                <${AlertTriangle} size=${18} />
                                <span style=${{ marginLeft: '6px', fontWeight: 'bold' }}>資料抓取失敗</span>
                            </div>
                        ` : ''}
                    </div>
                    <div style=${{ flex: 1, minWidth: '280px' }}>
                        <div style=${{ fontSize: '30px', fontWeight: 'bold', color: '#222', marginBottom: '16px', lineHeight: 1.3 }}>
                            ${actor.name}${actor.name_reading && html`<span style=${{ fontSize: '16px', fontWeight: 'normal', color: '#888', marginLeft: '8px' }}>（${actor.name_reading}）</span>`}
                        </div>
                        <div>
                            <div style=${rowStyle}>
                                <span style=${labelStyle}>別名</span>
                                <div style=${{ flex: 1 }}>
                                    ${aliasList.length > 0
                                        ? aliasList.map((a, i) => html`<div key=${i} style=${{ marginBottom: i < aliasList.length - 1 ? '4px' : 0 }}>${a}</div>`)
                                        : html`<span style=${emptyStyle}>—</span>`}
                                </div>
                            </div>
                            <div style=${rowStyle}>
                                <span style=${labelStyle}>自訂別名</span>
                                <div style=${{ flex: 1 }}>
                                    ${customAliasList.length > 0
                                        ? customAliasList.map((a, i) => html`<div key=${i} style=${{ marginBottom: i < customAliasList.length - 1 ? '4px' : 0 }}>${a}</div>`)
                                        : html`<span style=${emptyStyle}>—</span>`}
                                </div>
                            </div>
                            <div style=${rowStyle}><span style=${labelStyle}>生年月日</span><div style=${{ flex: 1 }}>${actor.birthdate || html`<span style=${emptyStyle}>—</span>`}</div></div>
                            <div style=${rowStyle}><span style=${labelStyle}>サイズ</span><div style=${{ flex: 1 }}>${actor.sizes || html`<span style=${emptyStyle}>—</span>`}</div></div>
                            <div style=${rowStyle}><span style=${labelStyle}>AV出演期間</span><div style=${{ flex: 1 }}>${actor.av_period || html`<span style=${emptyStyle}>—</span>`}</div></div>
                            <div style=${rowStyle}>
                                <span style=${labelStyle}>タグ</span>
                                <div style=${{ flex: 1 }}>
                                    ${tagList.length > 0
                                        ? html`<div style=${{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                            ${tagList.map((t, i) => html`<span key=${i} style=${{ fontSize: '13px', padding: '2px 10px', borderRadius: '12px', backgroundColor: '#eef2f7', color: '#445' }}>${t}</span>`)}
                                        </div>`
                                        : html`<span style=${emptyStyle}>—</span>`}
                                </div>
                            </div>
                            <div style=${rowStyle}>
                                <span style=${labelStyle}>來源網址</span>
                                <div style=${{ flex: 1, wordBreak: 'break-all' }}>
                                    ${actor.source_url
                                        ? html`<a href="#" onClick=${(e) => { e.preventDefault(); shell.openExternal(actor.source_url); }} style=${{ color: '#2196F3' }} title="在瀏覽器中開啟">${actor.source_url}</a>`
                                        : html`<span style=${emptyStyle}>—</span>`}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div style=${{ padding: '0 20px 20px' }}>
                    <h3 style=${{ borderTop: '2px solid #eee', paddingTop: '16px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        出演作品 <span style=${{ fontSize: '14px', color: '#888', fontWeight: 'normal' }}>(共 ${totalWorks} 部)</span>
                    </h3>
                    ${works.length === 0
                        ? html`<div style=${{ color: '#999', padding: '40px 0', textAlign: 'center' }}>查無此演員的出演作品</div>`
                        : html`
                            <div className="card-grid">
                                ${works.map(w => html`<${WorkCard} key=${w.id} work=${w} onClick=${id => onNavigateToWorkDetails(id)} />`)}
                            </div>
                            <div style=${{ borderTop: '1px solid #eee', marginTop: '8px' }}>
                                <${Pagination} currentPage=${page} totalPages=${totalPages} onPageChange=${p => setPage(p)} />
                            </div>
                        `}
                </div>
            </div>
            ${viewingImage && html`<${ImageViewerModal} src=${viewingImage} onClose=${() => setViewingImage(null)} />`}
            ${editing && html`<${ActorEditModal} actorId=${actorId} setIsLoading=${setIsLoading} onClose=${() => setEditing(false)} onSaveSuccess=${reloadActor} />`}
            ${candidates && html`<${ScrapeCandidateModal} actorName=${actor.name} candidates=${candidates} onPick=${handlePickCandidate} onResearch=${handleResearch} onClose=${() => setCandidates(null)} />`}
        </div>`;
}

// 抓取候選清單選擇視窗 (搜尋結果多筆時, 讓使用者挑選或用別名重新搜尋)
function ScrapeCandidateModal({ actorName, candidates, onPick, onResearch, onClose }) {
    const fixThumb = (u) => u ? (u.startsWith('//') ? 'https:' + u : u) : '';
    const [query, setQuery] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    const q = query.trim().toLowerCase();
    const filtered = q ? candidates.filter(c => ((c.name || '') + ' ' + (c.info || '')).toLowerCase().indexOf(q) !== -1) : candidates;

    const doResearch = async () => {
        const kw = query.trim();
        if (!kw || busy) return;
        setBusy(true);
        try { await onResearch(kw); } catch (e) { alert('搜尋失敗: ' + e.message); }
        setBusy(false);
    };

    return html`
        <div className="modal-overlay" style=${{ zIndex: 2400 }}>
            <div className="modal-content" style=${{ maxWidth: '640px' }} onClick=${stopPropagation}>
                <div className="modal-header">
                    <span style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <${Globe} size=${20} color="#2196F3" /> 選擇要抓取的演員
                    </span>
                    <button className="btn-ghost" onClick=${onClose}><${X} size=${24} /></button>
                </div>
                <div className="modal-body" style=${{ padding: '12px 0' }}>
                    <div style=${{ fontSize: '13px', color: '#666', marginBottom: '8px' }}>
                        「${actorName}」找到 ${candidates.length} 位候選${q ? `, 篩選後 ${filtered.length} 位` : ''}, 請點選正確的一位:
                    </div>
                    <div style=${{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                        <input className="filter-input" style=${{ flex: 1 }} value=${query} disabled=${busy}
                            placeholder="輸入別名或關鍵字篩選 / 重新搜尋 (例如: 香川さくら)"
                            onInput=${e => setQuery(e.target.value)}
                            onKeyDown=${e => { if (e.key === 'Enter') doResearch(); }} />
                        <button className="btn-primary" onClick=${doResearch} disabled=${busy || !query.trim()} style=${{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                            ${busy ? html`<${Loader2} size=${15} className="spin-anim" />` : html`<${Search} size=${15} />`} 重新搜尋
                        </button>
                    </div>
                    <div style=${{ fontSize: '12px', color: '#999', marginBottom: '10px' }}>
                        提示: 上方輸入會即時篩選下方清單; 若找不到, 可按「重新搜尋」用此關鍵字 (例如別名) 重新查詢網站。
                    </div>
                    <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px', maxHeight: '380px', overflowY: 'auto' }}>
                        ${filtered.map(c => html`
                            <div key=${c.id} onClick=${() => onPick(c)} title="選擇此演員"
                                style=${{ border: '1px solid #eee', borderRadius: '8px', padding: '8px', cursor: 'pointer', display: 'flex', gap: '8px', alignItems: 'center', transition: 'background 0.15s' }}
                                onMouseOver=${(e) => e.currentTarget.style.background = '#f5f9ff'}
                                onMouseOut=${(e) => e.currentTarget.style.background = '#fff'}>
                                <div style=${{ width: '52px', height: '52px', flexShrink: 0, borderRadius: '6px', overflow: 'hidden', background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    ${c.thumb
                                        ? html`<img src=${fixThumb(c.thumb)} style=${{ width: '100%', height: '100%', objectFit: 'cover' }} onError=${(e) => { e.target.style.display = 'none'; }} />`
                                        : html`<${Users} size=${24} color="#ccc" />`}
                                </div>
                                <div style=${{ minWidth: 0 }}>
                                    <div style=${{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${c.name}</div>
                                    <div style=${{ fontSize: '11px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>${c.info}</div>
                                </div>
                            </div>
                        `)}
                        ${filtered.length === 0 && html`<div style=${{ gridColumn: '1 / -1', color: '#999', textAlign: 'center', padding: '20px 0' }}>目前清單沒有相符的, 試試按「重新搜尋」用此關鍵字查詢網站。</div>`}
                    </div>
                </div>
                <div className="modal-footer">
                    <button className="btn-block" onClick=${onClose} disabled=${busy}>取消</button>
                </div>
            </div>
        </div>`;
}

function ActorSystem({
    setIsLoading, onNavigateToWork, onNavigateToWorkDetails,
    uiFilters, setUiFilters,
    appliedFilters, setAppliedFilters,
    sortOrder, setSortOrder,
    viewMode, setViewMode,
    currentPage, setCurrentPage,
    contentRef, onContentScroll,
    canGoBack, onGoBack,
    pushHistory, isRestoringRef,
    detailActorId, setDetailActorId, isDetailFromExternalNav
}) {
    const ITEMS_PER_PAGE = 24;
    const [actors, setActors] = React.useState([]);

    const [editingActorId, setEditingActorId] = React.useState(null);
    const [mergingActor, setMergingActor] = React.useState(null);
    const [isModalOpen, setIsModalOpen] = React.useState(false);
    const [viewingImage, setViewingImage] = React.useState(null);
    const [totalItems, setTotalItems] = React.useState(0);
    const [totalPages, setTotalPages] = React.useState(1);
    const [scrapeProgress, setScrapeProgress] = React.useState(null); // null | { total, current, name, ok, fail, done, cancelled, failures }
    const [showScrapeMenu, setShowScrapeMenu] = React.useState(false);
    const scrapeCancelRef = React.useRef(false);
    const scrapeMenuRef = React.useRef(null);

    React.useEffect(() => {
        const handler = (e) => { if (scrapeMenuRef.current && !scrapeMenuRef.current.contains(e.target)) setShowScrapeMenu(false); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const loadActors = () => {
        if (!db) return;
        setIsLoading(true);
        setTimeout(() => {
            try {
                if (viewMode === 'duplicates') {
                    // 相似名稱搜尋模式
                    // 找出名字有包含關係的演員 (例如 "波多野" 和 "波多野結衣")
                    // 排除名字太短的 (小於2個字), 避免誤判
                    const baseCondition = `
                        is_deleted = 0 
                        AND length(name) >= 2
                        AND EXISTS (
                            SELECT 1 FROM actors b 
                            WHERE b.id != actors.id 
                            AND b.is_deleted = 0
                            AND length(b.name) >= 2
                            AND (actors.name LIKE '%' || b.name || '%' OR b.name LIKE '%' || actors.name || '%')
                        )
                    `;
                    
                    const countResult = db.prepare(`SELECT COUNT(*) as count FROM actors WHERE ${baseCondition}`).get();
                    const total = countResult ? countResult.count : 0;
                    setTotalItems(total);
                    
                    const totalP = Math.ceil(total / ITEMS_PER_PAGE) || 1;
                    setTotalPages(totalP);
                    let targetPage = Math.min(currentPage, totalP);
                    if (targetPage < 1) targetPage = 1;
                    const offset = (targetPage - 1) * ITEMS_PER_PAGE;
                    
                    // 強制依名字排序，讓相似的在一起
                    const rows = db.prepare(`
                        SELECT a.*, (SELECT COUNT(*) FROM work_actor_link wal WHERE wal.actor_id = a.id) as work_count 
                        FROM actors a 
                        WHERE ${baseCondition.replace(/actors\./g, 'a.')}
                        ORDER BY a.name ASC 
                        LIMIT ? OFFSET ?
                    `).all(ITEMS_PER_PAGE, offset);
                    
                    const timestamp = Date.now();
                    setActors(rows.map(r => ({ ...r, cacheBust: timestamp })));
                    // 這裡不使用 setCurrentPage(targetPage) 避免循環，只在需要時更新
                } else {
                    // 正常模式
                    const conditions = ['is_deleted = 0'];
                    const params = [];
                    if (appliedFilters.name) {
                        const terms = appliedFilters.name.trim().split(/\s+/);
                        const subConditions = [];
                        terms.forEach(term => {
                            subConditions.push(`(name LIKE ? OR aliases LIKE ? OR custom_aliases LIKE ?)`);
                            params.push(`%${term}%`, `%${term}%`, `%${term}%`);
                        });
                        if (subConditions.length > 0) {
                            conditions.push(`(${subConditions.join(' AND ')})`);
                        }
                    }
                    if (appliedFilters.code) {
                        const query = parseSearchQuery(appliedFilters.code, 'actor_number');
                        if (query.sql) {
                            conditions.push(query.sql.replace(/^\s*AND\s+/, ''));
                            params.push(...query.params);
                        }
                    }
                    if (appliedFilters.isFavorite) conditions.push("is_favorite = 1");
                    if (appliedFilters.scrapeFailed) conditions.push("scrape_failed = 1");

                    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
                    const total = db.prepare(`SELECT COUNT(*) as count FROM actors ${whereClause}`).get(...params).count;
                    setTotalItems(total);
                    const totalP = Math.ceil(total / ITEMS_PER_PAGE) || 1;
                    setTotalPages(totalP);
                    let targetPage = Math.min(currentPage, totalP);
                    if (targetPage < 1) targetPage = 1; 
                    const offset = (targetPage - 1) * ITEMS_PER_PAGE;

                    let orderBy = 'actor_number DESC';
                    switch (sortOrder) {
                        case 'number_asc': orderBy = 'actor_number ASC'; break;
                        case 'name_asc': orderBy = 'name ASC'; break;
                        case 'name_desc': orderBy = 'name DESC'; break;
                        case 'work_count_desc': orderBy = 'work_count DESC, actor_number DESC'; break;
                        case 'work_count_asc': orderBy = 'work_count ASC, actor_number DESC'; break;
                    }

                    const rows = db.prepare(`
                        SELECT a.*, (SELECT COUNT(*) FROM work_actor_link wal WHERE wal.actor_id = a.id) as work_count 
                        FROM actors a ${whereClause} 
                        ORDER BY ${orderBy} 
                        LIMIT ? OFFSET ?
                    `).all(...params, ITEMS_PER_PAGE, offset);

                    const timestamp = Date.now();
                    setActors(rows.map(r => ({ ...r, cacheBust: timestamp })));
                    // setCurrentPage(targetPage); // 由 useEffect 控制
                }
            } catch (err) {
                console.error(err);
                alert(`查詢錯誤: ${err.message}`); 
                setIsLoading(false);
            }
            setIsLoading(false);
        }, 50);
    };

    React.useEffect(() => {
        if (isRestoringRef && isRestoringRef.current) return;
        setCurrentPage(1);
    }, [appliedFilters, sortOrder, viewMode]);
    React.useEffect(() => { loadActors(); }, [currentPage, appliedFilters, sortOrder, viewMode]);

    // 從詳細頁返回列表時重新載入 (detailActorId 由有值變為 null),
    // 以反映在詳細頁對演員所做的變更 (更換圖片/名稱/關注狀態等), 並更新縮圖的 cacheBust
    const prevDetailIdRef = React.useRef(detailActorId);
    React.useEffect(() => {
        if (prevDetailIdRef.current && !detailActorId) loadActors();
        prevDetailIdRef.current = detailActorId;
    }, [detailActorId]);

    const handleApply = () => {
        pushHistory && pushHistory();
        setViewMode('normal');
        setAppliedFilters({ ...uiFilters });
    };

    const handleClear = () => {
        pushHistory && pushHistory();
        const empty = { name: '', code: '', isFavorite: false, scrapeFailed: false };
        setUiFilters(empty);
        setAppliedFilters(empty);
        setViewMode('normal');
    };

    const handleFindDuplicates = () => {
        pushHistory && pushHistory();
        // 清除其他篩選條件，專注於顯示重複項
        const empty = { name: '', code: '', isFavorite: false, scrapeFailed: false };
        setUiFilters(empty);
        setAppliedFilters(empty);
        setViewMode('duplicates');
    };

    const handleDelete = (id) => {
        if (!db || !confirm('此操作無法復原, 確定刪除此演員?')) return;
        try {
            const actor = db.prepare('SELECT image_path FROM actors WHERE id=?').get(id);
            if (actor && actor.image_path) {
                const imgPath = path.join(actorsImgDir, actor.image_path);
                if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
            }
            db.prepare('UPDATE actors SET is_deleted = 1, image_path = NULL WHERE id = ?').run(id);
            loadActors();
        } catch (e) { console.error(e); }
    };

    const handleToggleFavorite = (id, currentStatus) => {
        if (!db) return;
        const newStatus = currentStatus ? 0 : 1;
        try {
            db.prepare('UPDATE actors SET is_favorite = ? WHERE id=?').run(newStatus, id);
            setActors(prev => prev.map(a => a.id === id ? { ...a, is_favorite: newStatus } : a));
        } catch (e) {
            console.error(e);
            alert("更新失敗: " + e.message);
        }
    };

    // 批量抓取演員資訊 (minnano-av)
    // mode: 'all' 所有演員 / 'missing' 僅尚未有資訊的演員(全部) / 'missing_skip_failed' 僅尚未有資訊的演員(跳過失敗項目) / 'has_info' 僅已有資訊的演員(更新既有資料) / 'failed_only' 僅先前抓取失敗的演員(重新嘗試)
    const BATCH_SCRAPE_MODES = {
        all: {
            label: '所有演員',
            clause: '',
            emptyMessage: '沒有可抓取的演員。'
        },
        missing: {
            label: '「尚未有資訊」的演員 (全部)',
            // 生年月日/サイズ/AV出演期間/讀音 皆為空, 視為尚未有資訊
            clause: " AND (birthdate IS NULL OR birthdate = '') AND (sizes IS NULL OR sizes = '') AND (av_period IS NULL OR av_period = '') AND (name_reading IS NULL OR name_reading = '')",
            emptyMessage: '目前沒有「尚未有資訊」的演員需要抓取。'
        },
        missing_skip_failed: {
            label: '「尚未有資訊」的演員 (跳過先前抓取失敗項目)',
            clause: " AND (birthdate IS NULL OR birthdate = '') AND (sizes IS NULL OR sizes = '') AND (av_period IS NULL OR av_period = '') AND (name_reading IS NULL OR name_reading = '') AND (scrape_failed IS NULL OR scrape_failed = 0)",
            emptyMessage: '目前沒有「尚未有資訊」且尚未抓取失敗的演員需要抓取。'
        },
        has_info: {
            label: '「已有資訊」的演員 (更新既有資料)',
            // 至少一項已有資料, 視為已有資訊
            clause: " AND (COALESCE(birthdate,'') != '' OR COALESCE(sizes,'') != '' OR COALESCE(av_period,'') != '' OR COALESCE(name_reading,'') != '')",
            emptyMessage: '目前沒有「已有資訊」的演員可供更新。'
        },
        failed_only: {
            label: '先前抓取失敗的演員 (重新嘗試)',
            clause: " AND scrape_failed = 1",
            emptyMessage: '目前沒有標記為「抓取失敗」的演員。'
        }
    };

    const handleBatchScrape = async (mode = 'all') => {
        if (!db || scrapeProgress) return;
        const config = BATCH_SCRAPE_MODES[mode] || BATCH_SCRAPE_MODES.all;
        if (!confirm('將連線到 minnano-av.com 逐一抓取' + config.label + '的資訊。\n\n• 已有圖片的演員不會更換圖片\n• 別名/生年月日/サイズ/AV出演期間/タグ 會自動更新\n• 為避免被網站封鎖, 每位演員之間會稍作延遲, 整體可能需要較長時間\n\n確定要開始嗎?')) return;

        let rows;
        try {
            rows = db.prepare("SELECT * FROM actors WHERE is_deleted = 0" + config.clause + " ORDER BY actor_number ASC").all();
        } catch (e) { alert('讀取演員清單失敗: ' + e.message); return; }
        if (!rows.length) { alert(config.emptyMessage); return; }

        scrapeCancelRef.current = false;
        let ok = 0, fail = 0;
        const failures = [];
        setScrapeProgress({ total: rows.length, current: 0, name: '', ok, fail, done: false, failures: [] });

        for (let i = 0; i < rows.length; i++) {
            if (scrapeCancelRef.current) break;
            const actor = rows[i];
            setScrapeProgress({ total: rows.length, current: i + 1, name: actor.name, ok, fail, done: false, failures });
            let reason = '';
            try {
                const r = await scrapeAndUpdateActor(actor);
                if (r.status === 'updated') ok++;
                else { fail++; reason = r.message || (r.status === 'notfound' ? '找不到資料' : '抓取失敗'); }
            } catch (e) {
                fail++; reason = e.message || '例外錯誤';
                try { db.prepare('UPDATE actors SET scrape_failed = 1 WHERE id = ?').run(actor.id); } catch (e2) { }
            }
            if (reason) failures.push({ actor_number: actor.actor_number, name: actor.name, reason, is_favorite: actor.is_favorite ? 1 : 0 });
            setScrapeProgress({ total: rows.length, current: i + 1, name: actor.name, ok, fail, done: false, failures });
            // 隨機延遲 1.5~3.5 秒, 降低被判定為爬蟲的機率
            if (i < rows.length - 1 && !scrapeCancelRef.current) {
                await new Promise(resolve => setTimeout(resolve, 1500 + Math.floor(Math.random() * 2000)));
            }
        }

        setScrapeProgress({ total: rows.length, current: rows.length, name: '', ok, fail, done: true, cancelled: scrapeCancelRef.current, failures });
        loadActors();
    };

    // 女優詳細頁面 (點選卡片後顯示，非彈出視窗)
    if (detailActorId) {
        return html`<${ActorDetail}
            actorId=${detailActorId}
            onBack=${() => isDetailFromExternalNav ? onGoBack() : setDetailActorId(null)}
            onNavigateToWorkDetails=${onNavigateToWorkDetails}
            setIsLoading=${setIsLoading}
        />`;
    }

    return html`
        <div className="main-layout">
            <div className="sidebar" style=${{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style=${{ position: 'sticky', top: 0, zIndex: 10, backgroundColor: 'white', borderBottom: '1px solid #e0e0e0', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                    <h3 style=${{ margin: 0, flex: 1, fontSize: '15px' }}>演員篩選</h3>
                    <button className="btn-block" style=${{ padding: '4px 10px', fontSize: '12px' }} onClick=${handleApply} disabled=${viewMode === 'duplicates'}>套用篩選</button>
                    <button className="btn-block" style=${{ padding: '4px 10px', fontSize: '12px' }} onClick=${handleClear}>清除篩選</button>
                </div>
                <div style=${{ overflowY: 'auto', padding: '16px', flex: 1 }}>
                <div className="filter-group">
                    <label className="filter-label">演員姓名</label>
                    <input className="filter-input" value=${uiFilters.name} onInput=${e => setUiFilters({ ...uiFilters, name: e.target.value })} placeholder="搜尋姓名或別名..." disabled=${viewMode === 'duplicates'} />
                    ${viewMode !== 'duplicates' && html`<${SearchHelpText} />`}
                </div>
                <div className="filter-group">
                    <label className="filter-label">演員編號</label>
                    <input className="filter-input" value=${uiFilters.code} onInput=${e => setUiFilters({ ...uiFilters, code: e.target.value })} placeholder="例如: No.0001" disabled=${viewMode === 'duplicates'} />
                </div>
                <div className="filter-group">
                    <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked=${uiFilters.isFavorite} onChange=${e => setUiFilters({ ...uiFilters, isFavorite: e.target.checked })} style=${{ marginRight: 8 }} disabled=${viewMode === 'duplicates'} />
                        關注演員
                    </label>
                </div>
                <div className="filter-group">
                    <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked=${uiFilters.scrapeFailed} onChange=${e => setUiFilters({ ...uiFilters, scrapeFailed: e.target.checked })} style=${{ marginRight: 8 }} disabled=${viewMode === 'duplicates'} />
                        資料抓取失敗
                    </label>
                </div>
                <hr style=${{ margin: '16px 0', borderTop: '1px solid #eee' }} />

                <h4 style=${{ margin: '0 0 10px 0', fontSize: '14px', color: '#666' }}>進階功能</h4>
                <div className="sidebar-actions">
                    <button className=${viewMode === 'duplicates' ? "btn-primary" : "btn-block"} style=${{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick=${handleFindDuplicates} disabled=${viewMode === 'duplicates'}>
                        <${Zap} size=${16} style=${{ marginRight: 6 }} />
                        尋找相似名稱
                    </button>
                </div>
                </div>
            </div>
            <div className="content-area" ref=${contentRef} onScroll=${onContentScroll}>
                <div className="content-header">
                    <div className="result-info" style=${{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        ${canGoBack && html`
                            <button className="btn-ghost" onClick=${onGoBack} title="返回上一頁" style=${{ padding: '4px', display: 'flex', alignItems: 'center' }}>
                                <${ArrowLeft} size=${18} />
                            </button>
                        `}
                        ${viewMode === 'duplicates'
                            ? html`<span style=${{color: '#d32f2f', fontWeight: 'bold', display:'flex', alignItems:'center'}}><${AlertTriangle} size=${16} style=${{marginRight:6}}/> 相似名稱搜尋結果: ${totalItems} 位</span>`
                            : html`搜尋結果: 共${totalItems} 位`
                        }
                    </div>
                    <div style=${{ fontSize: '12px', color: '#666' }}>
                        ${viewMode === 'duplicates' 
                            ? html`模式: 潛在重複分析 (依名稱排序)` 
                            : html`條件: ${appliedFilters.name || appliedFilters.code || appliedFilters.isFavorite || appliedFilters.scrapeFailed ? '篩選中' : '所有演員'}`
                        }
                    </div>
                    <div style=${{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        ${viewMode === 'duplicates' && html`
                            <button className="btn-block" onClick=${handleClear} style=${{ marginRight: 8 }}>
                                <${RefreshCw} size=${16} style=${{ marginRight: 4 }} />
                                返回所有演員
                            </button>
                        `}
                        <button className="btn-primary" onClick=${() => { setEditingActorId(null); setIsModalOpen(true); }}><${Plus} size=${16} style=${{ marginRight: 4 }} /> 新增演員</button>
                        <div ref=${scrapeMenuRef} style=${{ position: 'relative' }}>
                            <button className="btn-block" onClick=${() => setShowScrapeMenu(s => !s)} disabled=${viewMode === 'duplicates' || !!scrapeProgress} title="從 minnano-av 抓取演員資訊" style=${{ display: 'flex', alignItems: 'center' }}>
                                <${Globe} size=${16} style=${{ marginRight: 4 }} /> 抓取資訊
                            </button>
                            ${showScrapeMenu && html`
                                <div style=${{ position: 'absolute', top: '100%', right: 0, marginTop: '4px', backgroundColor: '#fff', border: '1px solid #eee', borderRadius: '6px', boxShadow: '0 2px 10px rgba(0,0,0,0.12)', zIndex: 30, minWidth: '260px', overflow: 'hidden' }}>
                                    <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', fontSize: '14px', color: '#333', borderBottom: '1px solid #eee' }}
                                        onClick=${() => { setShowScrapeMenu(false); handleBatchScrape('all'); }}>
                                        抓取所有演員
                                    </div>
                                    <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', fontSize: '14px', color: '#333', borderBottom: '1px solid #eee' }}
                                        onClick=${() => { setShowScrapeMenu(false); handleBatchScrape('missing'); }}>
                                        只抓「尚未有資訊」的演員 (全部)
                                    </div>
                                    <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', fontSize: '14px', color: '#333', borderBottom: '1px solid #eee' }}
                                        onClick=${() => { setShowScrapeMenu(false); handleBatchScrape('missing_skip_failed'); }}>
                                        只抓「尚未有資訊」的演員 (跳過先前失敗)
                                    </div>
                                    <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', fontSize: '14px', color: '#333', borderBottom: '1px solid #eee' }}
                                        onClick=${() => { setShowScrapeMenu(false); handleBatchScrape('has_info'); }}>
                                        只抓「已有資訊」的演員 (更新既有資料)
                                    </div>
                                    <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', fontSize: '14px', color: '#333' }}
                                        onClick=${() => { setShowScrapeMenu(false); handleBatchScrape('failed_only'); }}>
                                        只抓「抓取失敗」的演員 (重新嘗試)
                                    </div>
                                </div>
                            `}
                        </div>
                        <button className="btn-ghost" onClick=${() => { pushHistory && pushHistory(); setSortOrder(toggleSortDirection(sortOrder)); }} title="反轉排序順序" disabled=${viewMode === 'duplicates'} style=${{ display: 'flex', alignItems: 'center', padding: '4px', marginRight: '4px' }}>
                            <${ArrowUpDown} size=${16} color="#666" />
                        </button>
                        <select className="filter-input" style=${{ width: 'auto', padding: '6px 12px' }} value=${sortOrder} onChange=${e => { pushHistory && pushHistory(); setSortOrder(e.target.value); }} disabled=${viewMode === 'duplicates'}>
                            <option value="number_desc">依編號 (由大到小)</option>
                            <option value="number_asc">依編號 (由小到大)</option>
                            <option value="name_asc">依名字 (由小到大)</option>
                            <option value="name_desc">依名字 (由大到小)</option>
                            <option value="work_count_desc">依作品數量 (多 → 少)</option>
                            <option value="work_count_asc">依作品數量 (少 → 多)</option>
                        </select>
                    </div>
                </div>
                <div className="card-grid" style=${{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                    ${actors.map(actor => html`
                        <${ActorCard} 
                            key=${actor.id} 
                            actor=${actor} 
                            onEdit=${(id) => { setEditingActorId(id); setIsModalOpen(true); }} 
                            onMerge=${(actor) => setMergingActor(actor)}
                            onDelete=${handleDelete}
                            onOpenDetail=${(id) => setDetailActorId(id)}
                            onToggleFavorite=${handleToggleFavorite}
                            onSearch=${onNavigateToWork} 
                        />
                    `)}
                </div>
                <div style=${{ marginTop: 'auto', borderTop: '1px solid #eee' }}>
                    <${Pagination} currentPage=${currentPage} totalPages=${totalPages} onPageChange=${p => { pushHistory && pushHistory(); setCurrentPage(p); }} />
                </div>
            </div>
            ${isModalOpen && html`<${ActorEditModal} actorId=${editingActorId} setIsLoading=${setIsLoading} onClose=${() => setIsModalOpen(false)} onSaveSuccess=${loadActors} />`}
            ${mergingActor && html`<${MergeActorModal} sourceActor=${mergingActor} onClose=${() => setMergingActor(null)} onMergeSuccess=${loadActors} />`}
            ${viewingImage && html`<${ImageViewerModal} src=${viewingImage} onClose=${() => setViewingImage(null)} />`}
            ${scrapeProgress && html`<${ScrapeProgressModal} progress=${scrapeProgress}
                onStop=${() => { scrapeCancelRef.current = true; }}
                onClose=${() => setScrapeProgress(null)} />`}
        </div>`;
}

// 失敗清單呈現 (分「關注演員 / 其他」兩區; 供進度視窗共用)
function FailureList({ items }) {
    if (!items || items.length === 0) {
        return html`<div style=${{ color: '#28a745', padding: '12px 0' }}>沒有失敗的項目 🎉</div>`;
    }
    const favs = items.filter(f => f.is_favorite);
    const others = items.filter(f => !f.is_favorite);

    const renderItem = (f, i, n) => html`
        <div key=${i} style=${{ padding: '8px 12px', borderBottom: i < n - 1 ? '1px solid #f2f2f2' : 'none', fontSize: '13px' }}>
            <div style=${{ fontWeight: 'bold' }}>${f.actor_number ? f.actor_number + ' ' : ''}${f.name}</div>
            <div style=${{ color: '#dc3545', fontSize: '12px', marginTop: '2px' }}>${f.reason || '失敗'}</div>
        </div>`;

    const renderSection = (title, list, withStar) => html`
        <div>
            <div style=${{ fontSize: '13px', fontWeight: 'bold', color: '#555', padding: '6px 10px', background: '#f5f5f5', display: 'flex', alignItems: 'center', gap: '6px', position: 'sticky', top: 0 }}>
                ${withStar ? html`<${Star} size=${14} fill="#fbc02d" color="#fbc02d" />` : ''} ${title} (${list.length})
            </div>
            ${list.length > 0
                ? list.map((f, i) => renderItem(f, i, list.length))
                : html`<div style=${{ padding: '8px 12px', color: '#bbb', fontSize: '12px' }}>（無）</div>`}
        </div>`;

    return html`
        <div style=${{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #eee', borderRadius: '6px' }}>
            ${renderSection('關注演員', favs, true)}
            ${renderSection('其他', others, false)}
        </div>`;
}

// 批量抓取進度視窗
function ScrapeProgressModal({ progress, onStop, onClose }) {
    const { total, current, name, ok, fail, done, cancelled } = progress;
    const failures = progress.failures || [];
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;

    return html`
        <div className="modal-overlay" style=${{ zIndex: 2300 }}>
            <div className="modal-content" style=${{ maxWidth: '520px' }} onClick=${stopPropagation}>
                <div className="modal-header">
                    <span style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <${Globe} size=${20} color="#2196F3" /> 批量抓取演員資訊
                    </span>
                    ${done && html`<button className="btn-ghost" onClick=${onClose}><${X} size=${24} /></button>`}
                </div>
                <div className="modal-body" style=${{ padding: '20px 0' }}>
                    <div style=${{ marginBottom: '12px', fontWeight: 'bold' }}>
                        ${done
                            ? (cancelled ? '已中止' : '抓取完成')
                            : html`處理中 (${current} / ${total})`}
                    </div>
                    <div style=${{ height: '14px', background: '#eee', borderRadius: '7px', overflow: 'hidden', marginBottom: '12px' }}>
                        <div style=${{ width: pct + '%', height: '100%', background: done ? '#28a745' : '#2196F3', transition: 'width 0.3s' }}></div>
                    </div>
                    ${!done && html`<div style=${{ fontSize: '13px', color: '#666', marginBottom: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>正在抓取: ${name || '...'}</div>`}
                    <div style=${{ display: 'flex', gap: '16px', fontSize: '14px', marginBottom: done ? '12px' : 0 }}>
                        <span style=${{ color: '#28a745' }}>成功更新: ${ok}</span>
                        <span style=${{ color: '#dc3545' }}>未更新/失敗: ${fail}</span>
                    </div>
                    ${done && html`
                        <div style=${{ fontWeight: 'bold', fontSize: '14px', marginBottom: '8px' }}>失敗清單</div>
                        <${FailureList} items=${failures} />
                    `}
                </div>
                <div className="modal-footer">
                    ${done
                        ? html`<button className="btn-primary" onClick=${onClose}>關閉</button>`
                        : html`<button className="btn-block" style=${{ display: 'flex', alignItems: 'center', gap: '4px' }} onClick=${onStop}><${StopCircle} size=${16} /> 中止</button>`}
                </div>
            </div>
        </div>`;
}

module.exports = { ActorSystem };