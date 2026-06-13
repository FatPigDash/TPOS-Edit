const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const path = require('path');
const fs = require('fs');
const { webUtils } = require('electron');
const {
    MoreVertical, Edit, Trash2, Users, AlertTriangle, Star,
    Upload, Plus, Search, X, GitMerge, ArrowRight, Zap, RefreshCw, Wand2, ArrowLeft,
    Globe, Loader2, StopCircle
} = require('lucide-react');

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

        // 名稱: 移除括號內的別名 (別名已存於別名欄位); 若清理後為空則保留原名
        const cleanedName = cleanSearchName(actor.name) || actor.name;

        db.prepare('UPDATE actors SET name = ?, aliases = ?, birthdate = ?, sizes = ?, av_period = ?, name_reading = ?, tags = ? WHERE id = ?')
            .run(cleanedName, aliasesStr, birthdate, sizes, avPeriod, nameReading, tagsStr, actor.id);

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

// 自動抓取並寫入 (供批量抓取與失敗清單重新掃描使用; 多筆結果時自動比對/略過, 不互動)
// 回傳 { status: 'updated' | 'notfound' | 'error', message?, imageUpdated? }
async function scrapeAndUpdateActor(actor) {
    let res;
    try {
        res = await scrapeActorByName(actor.name);
    } catch (e) {
        return { status: 'error', message: e.message };
    }
    if (!res.success) return { status: 'notfound', message: res.message };
    return applyScrapedData(actor, res.data);
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
                ${actor.aliases && html`<div style=${{ fontSize: '11px', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>(${actor.aliases})</div>`}
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
    const [aliasItems, setAliasItems] = React.useState([""]);
    const [birthdate, setBirthdate] = React.useState("");
    const [sizes, setSizes] = React.useState("");
    const [avPeriod, setAvPeriod] = React.useState("");
    const [tags, setTags] = React.useState("");
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
                setAliasItems(splitAliases(actor.aliases));
                setBirthdate(actor.birthdate || "");
                setSizes(actor.sizes || "");
                setAvPeriod(actor.av_period || "");
                setTags(actor.tags || "");
                setActorNumber(actor.actor_number);
                let imgState = null;
                if (actor.image_path) {
                    const url = getFileUrl(path.join(actorsImgDir, actor.image_path));
                    imgState = { preview: url, isStored: true, path: actor.image_path };
                }
                setImage(imgState);
                setOriginalImage(actor.image_path);
                setIsFavorite(actor.is_favorite || 0);
                setInitialState({ name: actor.name, aliases: cleanAliases(splitAliases(actor.aliases)).join(','), birthdate: actor.birthdate || "", sizes: actor.sizes || "", avPeriod: actor.av_period || "", tags: actor.tags || "", image: imgState, isFavorite: actor.is_favorite || 0 });
            }
        } else {
            const num = getNewActorNumber(db);
            setActorNumber(num);
            setIsFavorite(0);
            setAliasItems([""]);
            setTags("");
            setInitialState({ name: '', aliases: '', birthdate: '', sizes: '', avPeriod: '', tags: '', image: null, isFavorite: 0 });
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
        return name !== initialState.name || cleanAliases(aliasItems).join(',') !== initialState.aliases || birthdate !== initialState.birthdate || sizes !== initialState.sizes || avPeriod !== initialState.avPeriod || tags !== initialState.tags || isFavorite !== initialState.isFavorite || JSON.stringify(image) !== JSON.stringify(initialState.image);
    };

    const attemptClose = () => { if (isDirty()) setShowDirtyWarning(true); else onClose(); };

    const handleSave = () => {
        if (!db) return;
        const rawName = name.trim();
        if (!rawName) return alert('請輸入姓名');

        // Feature: 自動解析名稱中的括號內容
        // 修改: 僅提取別名，保留名字中的括號顯示
        const parsed = parseNameWithAliases(rawName);
        const finalName = rawName; // 使用原始名稱 (包含括號)
        const extractedAliases = parsed.aliases;

        // 合併現有的別名輸入與提取出的別名
        const currentAliases = cleanAliases(aliasItems);
        // 使用 Set 去重
        const mergedAliases = [...new Set([...currentAliases, ...extractedAliases])].join(',');

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
                    if (isEdit) {
                        db.prepare('UPDATE actors SET name = ?, aliases = ?, is_favorite = ?, birthdate = ?, sizes = ?, av_period = ?, tags = ? WHERE id = ?').run(finalName, mergedAliases, isFavorite, bd, sz, avp, tg, actorId);
                    } else {
                        const info = db.prepare('INSERT INTO actors (actor_number, name, aliases, created_at, is_favorite, birthdate, sizes, av_period, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(actorNumber, finalName, mergedAliases, Date.now(), isFavorite, bd, sz, avp, tg);
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
                    <small style=${{color: '#888', display: 'block', marginTop: '4px'}}>* 提示: 若輸入 "姓名 (別名)"，儲存時別名會自動加入別名欄位，且顯示名稱保留括號。</small>
                </div>
                <div className="filter-group">
                    <label className="filter-label">別名 / 舊藝名 <span style=${{fontSize:'12px', color:'#888', fontWeight:'normal'}}>(可新增多筆)</span></label>
                    ${aliasItems.map((val, idx) => html`
                        <div key=${idx} style=${{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                            <input className="filter-input" style=${{ flex: 1 }} value=${val} onInput=${e => updateAlias(idx, e.target.value)} placeholder=${`別名 ${idx + 1}`} />
                            <button type="button" className="btn-ghost" title="移除此別名" style=${{ padding: '6px', flexShrink: 0, opacity: aliasItems.length <= 1 ? 0.3 : 1 }} disabled=${aliasItems.length <= 1} onClick=${() => removeAlias(idx)}>
                                <${Trash2} size=${16} />
                            </button>
                        </div>
                    `)}
                    <button type="button" className="btn-block" style=${{ width: 'auto', padding: '6px 12px', display: 'inline-flex', alignItems: 'center' }} onClick=${addAlias}>
                        <${Plus} size=${14} style=${{ marginRight: 4 }} /> 新增別名
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
                WHERE (name LIKE ? OR aliases LIKE ?) 
                AND id != ? AND is_deleted = 0
                LIMIT 10
            `).all(`%${searchQuery.trim()}%`, `%${searchQuery.trim()}%`, sourceActor.id);
            setCandidates(rows);
            setTargetActor(null);
        }
    };

    const executeMerge = () => {
        if (!targetActor) return;
        if (!confirm(`確定要將「${sourceActor.name}」合併至「${targetActor.name}」嗎？\n此操作無法復原，${sourceActor.name} 將會被刪除。`)) return;

        try {
            db.transaction(() => {
                // 1. 處理別名：將來源的名稱和別名都加入目標的別名清單
                let targetAliases = targetActor.aliases ? targetActor.aliases.split(',').map(s => s.trim()).filter(s=>s) : [];
                const sourceAliases = sourceActor.aliases ? sourceActor.aliases.split(',').map(s => s.trim()).filter(s=>s) : [];
                
                // 加入來源的本名
                if (!targetAliases.includes(sourceActor.name)) targetAliases.push(sourceActor.name);
                // 加入來源的別名
                sourceAliases.forEach(a => {
                    if (!targetAliases.includes(a)) targetAliases.push(a);
                });

                const newAliasesStr = targetAliases.join(',');
                db.prepare('UPDATE actors SET aliases = ? WHERE id = ?').run(newAliasesStr, targetActor.id);

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
                                    <div style=${{ fontSize: '12px', color: '#666' }}>ID: ${c.actor_number} | 別名: ${c.aliases || '無'}</div>
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
                                <li>${sourceActor.name} 將自動加入別名</li>
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
    const [scraping, setScraping] = React.useState(false);
    const [editing, setEditing] = React.useState(false);
    const [candidates, setCandidates] = React.useState(null); // null | [{id,name,url,thumb,info}]

    const reloadActor = () => {
        try {
            const a = db.prepare('SELECT * FROM actors WHERE id = ?').get(actorId);
            if (a) { setActor(a); setImageError(false); }
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

    // 抓取此演員資訊 (minnano-av); 多筆候選時讓使用者選擇
    const handleScrapeThis = async () => {
        if (!actor || scraping) return;
        setScraping(true);
        try {
            const res = await lookupActress(actor.name);
            if (res.type === 'none') {
                alert('在 minnano-av 找不到此演員的資料。');
            } else if (res.type === 'single') {
                const r = await applyScrapedData(actor, parseProfile(res.body));
                if (r.status === 'updated') reloadActor();
                else alert('抓取失敗: ' + (r.message || '未知錯誤'));
            } else if (res.type === 'multiple') {
                setCandidates(res.candidates);
            }
        } catch (e) {
            alert('抓取失敗: ' + e.message);
        }
        setScraping(false);
    };

    // 使用者從候選清單選定一位後抓取
    const handlePickCandidate = async (c) => {
        setCandidates(null);
        if (!actor) return;
        setScraping(true);
        try {
            const r = await scrapeActressUrl(c.url);
            const applied = await applyScrapedData(actor, r.data);
            if (applied.status === 'updated') reloadActor();
            else alert('抓取失敗: ' + (applied.message || '未知錯誤'));
        } catch (e) {
            alert('抓取失敗: ' + e.message);
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
    if (actor.image_path) imgSrc = getFileUrl(path.join(actorsImgDir, actor.image_path));
    const hasImg = imgSrc && !imageError;

    const aliasList = actor.aliases ? actor.aliases.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
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
            ${candidates && html`<${ScrapeCandidateModal} actorName=${actor.name} candidates=${candidates} onPick=${handlePickCandidate} onClose=${() => setCandidates(null)} />`}
        </div>`;
}

// 抓取候選清單選擇視窗 (搜尋結果多筆時, 讓使用者挑選正確的演員)
function ScrapeCandidateModal({ actorName, candidates, onPick, onClose }) {
    const fixThumb = (u) => u ? (u.startsWith('//') ? 'https:' + u : u) : '';
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
                    <div style=${{ fontSize: '13px', color: '#666', marginBottom: '10px' }}>
                        「${actorName}」找到 ${candidates.length} 位候選, 請點選正確的一位:
                    </div>
                    <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px', maxHeight: '420px', overflowY: 'auto' }}>
                        ${candidates.map(c => html`
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
                    </div>
                </div>
                <div className="modal-footer">
                    <button className="btn-block" onClick=${onClose}>取消</button>
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
    pushHistory, isRestoringRef
}) {
    const ITEMS_PER_PAGE = 24;
    const [actors, setActors] = React.useState([]);

    const [editingActorId, setEditingActorId] = React.useState(null);
    const [detailActorId, setDetailActorId] = React.useState(null);
    const [mergingActor, setMergingActor] = React.useState(null);
    const [isModalOpen, setIsModalOpen] = React.useState(false);
    const [viewingImage, setViewingImage] = React.useState(null);
    const [totalItems, setTotalItems] = React.useState(0);
    const [totalPages, setTotalPages] = React.useState(1);
    const [scrapeProgress, setScrapeProgress] = React.useState(null); // null | { total, current, name, ok, fail, done, cancelled, failures }
    const [showFailures, setShowFailures] = React.useState(false);
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
                            subConditions.push(`(name LIKE ? OR aliases LIKE ?)`);
                            params.push(`%${term}%`, `%${term}%`);
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
                    if (appliedFilters.noImage) conditions.push("(image_path IS NULL OR image_path = '')");
                    if (appliedFilters.isFavorite) conditions.push("is_favorite = 1");

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

    const handleApply = () => {
        pushHistory && pushHistory();
        setViewMode('normal');
        setAppliedFilters({ ...uiFilters });
    };

    const handleClear = () => {
        pushHistory && pushHistory();
        const empty = { name: '', code: '', noImage: false, isFavorite: false };
        setUiFilters(empty);
        setAppliedFilters(empty);
        setViewMode('normal');
    };

    const handleFindDuplicates = () => {
        pushHistory && pushHistory();
        // 清除其他篩選條件，專注於顯示重複項
        const empty = { name: '', code: '', noImage: false, isFavorite: false };
        setUiFilters(empty);
        setAppliedFilters(empty);
        setViewMode('duplicates');
    };

    // 新增: 批次處理名稱 (僅提取別名，保留名字)
    const handleBatchCleanNames = () => {
        if (!db) return;
        if (!confirm('確定要執行「自動提取別名」嗎？\n\n系統將掃描所有演員：\n1. 將「名字 (別名)」中的別名提取到別名欄位\n2. 演員的顯示名稱將【維持不變】\n\n此操作涉及大量資料修改。')) return;

        setIsLoading(true);
        setTimeout(() => {
            try {
                let updatedCount = 0;
                db.transaction(() => {
                    const allActors = db.prepare('SELECT id, name, aliases FROM actors WHERE is_deleted = 0').all();
                    
                    for (const actor of allActors) {
                        const parsed = parseNameWithAliases(actor.name);
                        
                        // 如果有提取出別名 (parsed.aliases 長度 > 0)
                        if (parsed.aliases.length > 0) {
                            const currentAliases = actor.aliases ? actor.aliases.split(/[,\uff0c]/).map(s => s.trim()).filter(s => s) : [];
                            // 計算合併後的別名清單
                            const mergedAliasesList = [...new Set([...currentAliases, ...parsed.aliases])];
                            
                            // 只有當別名數量增加時才更新 (避免重複執行浪費資源)
                            if (mergedAliasesList.length > currentAliases.length) {
                                const mergedAliases = mergedAliasesList.join(',');
                                // 只更新別名，不變更名字
                                db.prepare('UPDATE actors SET aliases = ? WHERE id = ?').run(mergedAliases, actor.id);
                                updatedCount++;
                            }
                        }
                    }
                })();
                
                alert(`處理完成！共更新了 ${updatedCount} 位演員的別名資料。`);
                loadActors(); // 重新整理列表
            } catch (e) {
                console.error(e);
                alert('處理失敗: ' + e.message);
            } finally {
                setIsLoading(false);
            }
        }, 100);
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

    // 批量抓取所有演員資訊 (minnano-av)
    const handleBatchScrape = async (onlyMissing = false) => {
        if (!db || scrapeProgress) return;
        const scopeText = onlyMissing ? '尚未有資訊的演員' : '所有演員';
        if (!confirm('將連線到 minnano-av.com 逐一抓取' + scopeText + '的資訊。\n\n• 已有圖片的演員不會更換圖片\n• 別名/生年月日/サイズ/AV出演期間/タグ 會自動更新\n• 為避免被網站封鎖, 每位演員之間會稍作延遲, 整體可能需要較長時間\n\n確定要開始嗎?')) return;

        let rows;
        try {
            // 「尚未有資訊」: 生年月日/サイズ/AV出演期間/讀音 皆為空的演員
            const missingClause = onlyMissing
                ? " AND (birthdate IS NULL OR birthdate = '') AND (sizes IS NULL OR sizes = '') AND (av_period IS NULL OR av_period = '') AND (name_reading IS NULL OR name_reading = '')"
                : '';
            rows = db.prepare("SELECT * FROM actors WHERE is_deleted = 0" + missingClause + " ORDER BY actor_number ASC").all();
        } catch (e) { alert('讀取演員清單失敗: ' + e.message); return; }
        if (!rows.length) { alert(onlyMissing ? '沒有「尚未有資訊」的演員需要抓取。' : '沒有可抓取的演員。'); return; }

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
            } catch (e) { fail++; reason = e.message || '例外錯誤'; }
            if (reason) failures.push({ actor_number: actor.actor_number, name: actor.name, reason, is_favorite: actor.is_favorite ? 1 : 0 });
            setScrapeProgress({ total: rows.length, current: i + 1, name: actor.name, ok, fail, done: false, failures });
            // 隨機延遲 1.5~3.5 秒, 降低被判定為爬蟲的機率
            if (i < rows.length - 1 && !scrapeCancelRef.current) {
                await new Promise(resolve => setTimeout(resolve, 1500 + Math.floor(Math.random() * 2000)));
            }
        }

        // 保留失敗清單 (存入 localStorage, 重開軟體仍可查看)
        try {
            localStorage.setItem('actorScrapeFailures', JSON.stringify({ time: Date.now(), items: failures }));
        } catch (e) { }

        setScrapeProgress({ total: rows.length, current: rows.length, name: '', ok, fail, done: true, cancelled: scrapeCancelRef.current, failures });
        loadActors();
    };

    // 女優詳細頁面 (點選卡片後顯示，非彈出視窗)
    if (detailActorId) {
        return html`<${ActorDetail}
            actorId=${detailActorId}
            onBack=${() => setDetailActorId(null)}
            onNavigateToWorkDetails=${onNavigateToWorkDetails}
            setIsLoading=${setIsLoading}
        />`;
    }

    return html`
        <div className="main-layout">
            <div className="sidebar">
                <h3 style=${{ marginTop: 0, marginBottom: '16px' }}>演員篩選</h3>
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
                        <input type="checkbox" checked=${uiFilters.noImage} onChange=${e => setUiFilters({ ...uiFilters, noImage: e.target.checked })} style=${{ marginRight: 8 }} disabled=${viewMode === 'duplicates'} />
                        尚缺圖片
                    </label>
                </div>
                <div className="sidebar-actions">
                    <button className="btn-block" style=${{ flex: 1 }} onClick=${handleApply} disabled=${viewMode === 'duplicates'}>套用篩選</button>
                    <button className="btn-block" style=${{ flex: 1 }} onClick=${handleClear}>清除篩選</button>
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
                            : html`條件: ${appliedFilters.name || appliedFilters.code || appliedFilters.noImage || appliedFilters.isFavorite ? '篩選中' : '所有演員'}`
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
                                <div style=${{ position: 'absolute', top: '100%', right: 0, marginTop: '4px', backgroundColor: '#fff', border: '1px solid #eee', borderRadius: '6px', boxShadow: '0 2px 10px rgba(0,0,0,0.12)', zIndex: 30, minWidth: '240px', overflow: 'hidden' }}>
                                    <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', fontSize: '14px', color: '#333', borderBottom: '1px solid #eee' }}
                                        onClick=${() => { setShowScrapeMenu(false); handleBatchScrape(false); }}>
                                        批量抓取 (所有演員)
                                    </div>
                                    <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', fontSize: '14px', color: '#333' }}
                                        onClick=${() => { setShowScrapeMenu(false); handleBatchScrape(true); }}>
                                        只抓尚未有資訊的演員
                                    </div>
                                </div>
                            `}
                        </div>
                        <button className="btn-block" onClick=${() => setShowFailures(true)} title="查看上次批量抓取的失敗清單" style=${{ display: 'flex', alignItems: 'center' }}>
                            <${AlertTriangle} size=${16} style=${{ marginRight: 4 }} /> 失敗清單
                        </button>
                        <select className="filter-input" style=${{ width: 'auto', padding: '6px 12px' }} value=${sortOrder} onChange=${e => { pushHistory && pushHistory(); setSortOrder(e.target.value); }} disabled=${viewMode === 'duplicates'}>
                            <option value="number_desc">依編號 (由大到小)</option>
                            <option value="number_asc">依編號 (由小到大)</option>
                            <option value="name_asc">依名字 (由小到大)</option>
                            <option value="name_desc">依名字 (由大到小)</option>
                            <option value="work_count_desc">依作品數量 (多 → 少)</option>
                            <option value="work_count_asc">依作品數量 (少 → 多)</option>
                        </select>
                        <button className="btn-ghost" title="批次提取別名 (不修改顯示名稱)" style=${{ padding: '6px' }} onClick=${handleBatchCleanNames} disabled=${viewMode === 'duplicates'}>
                            <${Wand2} size=${20} />
                        </button>
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
            ${showFailures && html`<${ScrapeFailuresModal} onClose=${() => setShowFailures(false)} onUpdated=${loadActors} />`}
        </div>`;
}

// 將失敗清單組成可複製的純文字 (分關注演員 / 其他)
function formatFailuresText(items, time) {
    const favs = items.filter(f => f.is_favorite);
    const others = items.filter(f => !f.is_favorite);
    const fmt = (list) => list.length ? list.map((f, i) => `${i + 1}. ${f.actor_number || ''} ${f.name}　-　${f.reason || ''}`).join('\n') : '（無）';
    const header = '抓取失敗清單' + (time ? ' (' + new Date(time).toLocaleString() + ')' : '') + '\n共 ' + items.length + ' 位';
    return header + '\n\n【關注演員】(' + favs.length + ')\n' + fmt(favs) + '\n\n【其他】(' + others.length + ')\n' + fmt(others);
}

// 複製失敗清單到剪貼簿
function copyFailuresToClipboard(items, time) {
    const text = formatFailuresText(items, time);
    try {
        const { clipboard } = require('electron');
        clipboard.writeText(text);
        return true;
    } catch (e) {
        try { navigator.clipboard.writeText(text); return true; } catch (e2) { return false; }
    }
}

// 失敗清單呈現 (分「關注演員 / 其他」兩區; 供進度視窗與獨立視窗共用)
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
    const [copied, setCopied] = React.useState(false);

    const handleCopy = () => {
        if (copyFailuresToClipboard(failures, Date.now())) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } else {
            alert('複製失敗, 請手動選取。');
        }
    };

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
                        <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <div style=${{ fontWeight: 'bold', fontSize: '14px' }}>失敗清單</div>
                            ${failures.length > 0 && html`<button className="btn-block" style=${{ padding: '4px 10px', fontSize: '13px' }} onClick=${handleCopy}>${copied ? '已複製!' : '複製清單'}</button>`}
                        </div>
                        <${FailureList} items=${failures} />
                        ${failures.length > 0 && html`<div style=${{ fontSize: '12px', color: '#888', marginTop: '8px' }}>此清單已自動保存, 可於演員資料庫上方「失敗清單」按鈕再次查看。</div>`}
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

// 已保存的失敗清單視窗 (從 localStorage 讀取)
function ScrapeFailuresModal({ onClose, onUpdated }) {
    const [data, setData] = React.useState({ time: null, items: [] });
    const [copied, setCopied] = React.useState(false);
    const [scanning, setScanning] = React.useState(false);
    const [scanProgress, setScanProgress] = React.useState(null); // null | { current, total, name }
    const [lastRemoved, setLastRemoved] = React.useState(null); // null | number
    const cancelRef = React.useRef(false);

    React.useEffect(() => {
        try {
            const raw = localStorage.getItem('actorScrapeFailures');
            if (raw) {
                const parsed = JSON.parse(raw);
                setData({ time: parsed.time || null, items: parsed.items || [] });
            }
        } catch (e) { }
    }, []);

    const handleCopy = () => {
        if (copyFailuresToClipboard(data.items, data.time)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } else { alert('複製失敗, 請手動選取。'); }
    };

    const handleClear = () => {
        if (!confirm('確定要清除已保存的失敗清單嗎?')) return;
        try { localStorage.removeItem('actorScrapeFailures'); } catch (e) { }
        setData({ time: null, items: [] });
        setLastRemoved(null);
    };

    // 重新掃描失敗項目: 重抓一次, 成功者自清單移除, 仍失敗者保留
    const handleRescan = async () => {
        if (scanning || !db || data.items.length === 0) return;
        if (!confirm('將重新抓取清單中的 ' + data.items.length + ' 位演員, 已成功的會自動從清單移除。\n\n為避免被封鎖會稍作延遲, 確定要開始嗎?')) return;

        setScanning(true);
        setLastRemoved(null);
        cancelRef.current = false;
        const items = data.items;
        const stillFail = [];

        for (let i = 0; i < items.length; i++) {
            if (cancelRef.current) {
                // 中止: 將尚未掃描的項目原樣保留
                for (let j = i; j < items.length; j++) stillFail.push(items[j]);
                break;
            }
            const item = items[i];
            setScanProgress({ current: i + 1, total: items.length, name: item.name });

            let actor = null;
            try {
                if (item.actor_number) actor = db.prepare("SELECT * FROM actors WHERE actor_number = ? AND is_deleted = 0").get(item.actor_number);
                if (!actor && item.name) actor = db.prepare("SELECT * FROM actors WHERE name = ? AND is_deleted = 0").get(item.name);
            } catch (e) { }

            // 演員已不存在 (例如已刪除) -> 視為移除
            if (!actor) continue;

            let reason = '';
            try {
                const r = await scrapeAndUpdateActor(actor);
                if (r.status !== 'updated') reason = r.message || (r.status === 'notfound' ? '找不到資料' : '抓取失敗');
            } catch (e) { reason = e.message || '例外錯誤'; }

            if (reason) stillFail.push({ actor_number: item.actor_number, name: actor.name || item.name, reason, is_favorite: actor.is_favorite ? 1 : 0 });

            if (i < items.length - 1 && !cancelRef.current) {
                await new Promise(resolve => setTimeout(resolve, 1500 + Math.floor(Math.random() * 2000)));
            }
        }

        const removed = items.length - stillFail.length;
        const newData = { time: Date.now(), items: stillFail };
        try { localStorage.setItem('actorScrapeFailures', JSON.stringify(newData)); } catch (e) { }
        setData(newData);
        setScanProgress(null);
        setScanning(false);
        setLastRemoved(removed);
        if (removed > 0 && onUpdated) onUpdated();
    };

    return html`
        <div className="modal-overlay" style=${{ zIndex: 2300 }}>
            <div className="modal-content" style=${{ maxWidth: '520px' }} onClick=${stopPropagation}>
                <div className="modal-header">
                    <span style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <${AlertTriangle} size=${20} color="#dc3545" /> 抓取失敗清單
                    </span>
                    ${!scanning && html`<button className="btn-ghost" onClick=${onClose}><${X} size=${24} /></button>`}
                </div>
                <div className="modal-body" style=${{ padding: '16px 0' }}>
                    <div style=${{ fontSize: '13px', color: '#666', marginBottom: '10px' }}>
                        ${data.time ? '最後更新: ' + new Date(data.time).toLocaleString() : '尚無保存的失敗紀錄'}
                        ${data.items.length > 0 ? html`　(共 ${data.items.length} 位)` : ''}
                    </div>
                    ${scanning && scanProgress && html`
                        <div style=${{ marginBottom: '10px' }}>
                            <div style=${{ fontSize: '13px', color: '#2196F3', fontWeight: 'bold', marginBottom: '6px' }}>
                                重新掃描中 (${scanProgress.current} / ${scanProgress.total})
                            </div>
                            <div style=${{ height: '10px', background: '#eee', borderRadius: '5px', overflow: 'hidden' }}>
                                <div style=${{ width: Math.round((scanProgress.current / scanProgress.total) * 100) + '%', height: '100%', background: '#2196F3', transition: 'width 0.3s' }}></div>
                            </div>
                            <div style=${{ fontSize: '12px', color: '#666', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>正在抓取: ${scanProgress.name || '...'}</div>
                        </div>
                    `}
                    ${!scanning && lastRemoved !== null && html`
                        <div style=${{ marginBottom: '10px', fontSize: '13px', color: lastRemoved > 0 ? '#28a745' : '#666', fontWeight: 'bold' }}>
                            ${lastRemoved > 0 ? '已移除 ' + lastRemoved + ' 位成功抓取的演員。' : '本次掃描沒有新增成功的項目。'}
                        </div>
                    `}
                    <${FailureList} items=${data.items} />
                </div>
                <div className="modal-footer" style=${{ justifyContent: 'space-between', gap: '8px' }}>
                    ${scanning
                        ? html`<button className="btn-block" style=${{ display: 'flex', alignItems: 'center', gap: '4px' }} onClick=${() => { cancelRef.current = true; }}><${StopCircle} size=${16} /> 中止掃描</button>`
                        : html`
                            <button className="btn-block" onClick=${handleClear} disabled=${data.items.length === 0}>清除紀錄</button>
                            <div style=${{ display: 'flex', gap: '8px' }}>
                                <button className="btn-block" onClick=${handleCopy} disabled=${data.items.length === 0}>${copied ? '已複製!' : '複製清單'}</button>
                                <button className="btn-primary" style=${{ display: 'flex', alignItems: 'center', gap: '4px' }} onClick=${handleRescan} disabled=${data.items.length === 0}>
                                    <${RefreshCw} size=${16} /> 重新掃描
                                </button>
                            </div>
                        `}
                </div>
            </div>
        </div>`;
}

module.exports = { ActorSystem };