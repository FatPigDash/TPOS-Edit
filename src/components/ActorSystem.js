const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const path = require('path');
const fs = require('fs');
const { webUtils } = require('electron');
const {
    MoreVertical, Edit, Trash2, Users, AlertTriangle, Star,
    Upload, Plus, Search, X
} = require('lucide-react');

const { db, actorsImgDir } = require('../utils/db');
const {
    getFileUrl, getNewActorNumber, parseSearchQuery, stopPropagation
} = require('../utils/helpers');
const {
    ConfirmModal, Modal, ImageViewerModal, Pagination, SearchHelpText
} = require('./Shared');

// 6. 演員系統元件 (Actor System)

function ActorCard({ actor, onEdit, onDelete, onImageClick, onToggleFavorite }) {
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
                    <div className="kebab-menu" style=${{ position: 'absolute', top: '100%', right: 0, backgroundColor: '#fff', border: '1px solid #eee', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', zIndex: 20, minWidth: '100px', overflow: 'hidden' }}>
                        <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid #eee', fontSize: '14px', color: '#333', backgroundColor: '#fff' }} onClick=${(e) => { e.stopPropagation(); setShowMenu(false); onEdit(actor.id); }}>
                            <${Edit} size=${16} /> 編輯
                        </div>
                        <div className="menu-item" style=${{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', color: '#dc3545', fontSize: '14px', backgroundColor: '#fff' }} onClick=${(e) => { e.stopPropagation(); setShowMenu(false); onDelete(actor.id); }}>
                            <${Trash2} size=${16} /> 刪除
                        </div>
                    </div>
                `}
            </div>
            <div style=${{ padding: '8px', fontSize: '12px', color: '#666', fontWeight: 'bold' }}>${actor.actor_number}</div>
            <div className="card-cover" onClick=${() => imgSrc && !imageError && onImageClick(imgSrc)} style=${{ cursor: imgSrc && !imageError ? 'zoom-in' : 'default', height: '180px' }}>
                ${imgSrc && !imageError ? html`<img src="${imgSrc}" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} onError=${handleImageError} />` : (imageError ? html`<div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#e6a700' }}><${AlertTriangle} size=${48} /><span style=${{ marginTop: 4, fontWeight: 'bold' }}>ERROR</span></div>` : html`<${Users} size=${48} color="#ccc" />`)}
            </div>
            <div className="card-info">
                <div className="card-title" title=${actor.name}>${actor.name}</div>
                <div style=${{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>作品: ${actor.work_count || 0}部</div>
                <div style=${{ marginTop: '4px', cursor: 'pointer', display: 'inline-block' }} onClick=${(e) => { e.stopPropagation(); onToggleFavorite(actor.id, actor.is_favorite); }}>
                    <${Star} size=${16} fill=${actor.is_favorite ? "#fbc02d" : "none"} color=${actor.is_favorite ? "#fbc02d" : "#ccc"} />
                </div>
            </div>
        </div>`;
}

function ActorEditModal({ actorId, onClose, onSaveSuccess, setIsLoading }) {
    const isEdit = !!actorId;
    const [name, setName] = React.useState("");
    const [actorNumber, setActorNumber] = React.useState("");
    const [image, setImage] = React.useState(null);
    const [originalImage, setOriginalImage] = React.useState(null);
    const [isFavorite, setIsFavorite] = React.useState(0);
    const fileInputRef = React.useRef(null);
    const [initialState, setInitialState] = React.useState(null);
    const [showDirtyWarning, setShowDirtyWarning] = React.useState(false);

    React.useEffect(() => {
        if (!db) return;
        if (isEdit) {
            const actor = db.prepare('SELECT * FROM actors WHERE id=?').get(actorId);
            if (actor) {
                setName(actor.name);
                setActorNumber(actor.actor_number);
                let imgState = null;
                if (actor.image_path) {
                    const url = getFileUrl(path.join(actorsImgDir, actor.image_path));
                    imgState = { preview: url, isStored: true, path: actor.image_path };
                }
                setImage(imgState);
                setOriginalImage(actor.image_path);
                setIsFavorite(actor.is_favorite || 0);
                setInitialState({ name: actor.name, image: imgState, isFavorite: actor.is_favorite || 0 });
            }
        } else {
            const num = getNewActorNumber(db);
            setActorNumber(num);
            setIsFavorite(0);
            setInitialState({ name: '', image: null, isFavorite: 0 });
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
        return name !== initialState.name || isFavorite !== initialState.isFavorite || JSON.stringify(image) !== JSON.stringify(initialState.image);
    };

    const attemptClose = () => { if (isDirty()) setShowDirtyWarning(true); else onClose(); };

    const handleSave = () => {
        if (!db) return;
        if (!name.trim()) return alert('請輸入姓名');
        const existing = db.prepare('SELECT id FROM actors WHERE name = ? AND is_deleted = 0 AND id != ?').get(name.trim(), isEdit ? actorId : -1);
        if (existing) return alert('已存在相同名稱的演員');

        setIsLoading(true);
        setTimeout(() => {
            try {
                db.transaction(() => {
                    let currentId = actorId;
                    if (isEdit) {
                        db.prepare('UPDATE actors SET name = ?, is_favorite = ? WHERE id = ?').run(name.trim(), isFavorite, actorId);
                    } else {
                        const info = db.prepare('INSERT INTO actors (actor_number, name, created_at, is_favorite) VALUES (?, ?, ?, ?)').run(actorNumber, name.trim(), Date.now(), isFavorite);
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
                    
                    // 自動關聯文字連結 (Auto-link text-only records)
                    db.prepare('UPDATE work_actor_link SET actor_id = ?, actor_name = NULL WHERE actor_id IS NULL AND actor_name = ?').run(currentId, name.trim());
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
                </div>
                <div className="filter-group">
                    <label className="filter-label">我的最愛</label>
                    <div style=${{ cursor: 'pointer', display: 'inline-block' }} onClick=${() => setIsFavorite(isFavorite ? 0 : 1)}>
                        <${Star} size=${24} fill=${isFavorite ? "#fbc02d" : "none"} color=${isFavorite ? "#fbc02d" : "#ccc"} />
                        <span style=${{ marginLeft: '8px', verticalAlign: 'middle', color: isFavorite ? '#fbc02d' : '#666', fontWeight: isFavorite ? 'bold' : 'normal' }}>${isFavorite ? '已加入最愛' : '未加入最愛'}</span>
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

function ActorSystem({ setIsLoading }) {
    const ITEMS_PER_PAGE = 24;
    const [actors, setActors] = React.useState([]);
    // 新增 isFavorite 篩選條件
    const [uiFilters, setUiFilters] = React.useState({ name: "", code: "", noImage: false, isFavorite: false });
    const [appliedFilters, setAppliedFilters] = React.useState({ name: "", code: "", noImage: false, isFavorite: false });
    const [sortOrder, setSortOrder] = React.useState('number_desc');
    const [editingActorId, setEditingActorId] = React.useState(null);
    const [isModalOpen, setIsModalOpen] = React.useState(false);
    const [viewingImage, setViewingImage] = React.useState(null);
    const [currentPage, setCurrentPage] = React.useState(1);
    const [totalItems, setTotalItems] = React.useState(0);
    const [totalPages, setTotalPages] = React.useState(1);

    const loadActors = () => {
        if (!db) return;
        setIsLoading(true);
        setTimeout(() => {
            try {
                // 使用陣列收集條件, 最後用 join(' AND ') 組合確保 SQL 語法絕對正確
                const conditions = ['is_deleted = 0'];
                const params = [];
                if (appliedFilters.name) {
                    const query = parseSearchQuery(appliedFilters.name, 'name');
                    if (query.sql) {
                        // 去掉可能包含的 AND 開頭, 避免重複
                        conditions.push(query.sql.replace(/^\s*AND\s+/, ''));
                        params.push(...query.params);
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
                const offset = (targetPage - 1) * ITEMS_PER_PAGE;

                let orderBy = 'actor_number DESC';
                switch (sortOrder) {
                    case 'number_asc': orderBy = 'actor_number ASC'; break;
                    case 'name_asc': orderBy = 'name ASC'; break;
                    case 'name_desc': orderBy = 'name DESC'; break;
                }

                // 修改: 增加子查詢計算作品數量 (work_count)
                const rows = db.prepare(`
                    SELECT a.*, (SELECT COUNT(*) FROM work_actor_link wal WHERE wal.actor_id = a.id) as work_count 
                    FROM actors a ${whereClause} 
                    ORDER BY ${orderBy} 
                    LIMIT ? OFFSET ?
                `).all(...params, ITEMS_PER_PAGE, offset);

                const timestamp = Date.now();
                setActors(rows.map(r => ({ ...r, cacheBust: timestamp })));
            } catch (err) {
                console.error(err);
                alert(`查詢錯誤: ${err.message}`); // 顯式提示錯誤, 方便除錯
                setIsLoading(false);
            }
            setIsLoading(false);
        }, 50);
    };

    React.useEffect(() => { setCurrentPage(1); }, [appliedFilters, sortOrder]);
    React.useEffect(() => { loadActors(); }, [currentPage, appliedFilters, sortOrder]);

    const handleApply = () => { setAppliedFilters({ ...uiFilters }); };
    const handleClear = () => {
        const empty = { name: '', code: '', noImage: false, isFavorite: false };
        setUiFilters(empty);
        setAppliedFilters(empty);
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

    // 新增: 處理最愛切換
    const handleToggleFavorite = (id, currentStatus) => {
        if (!db) return;
        const newStatus = currentStatus ? 0 : 1;
        try {
            db.prepare('UPDATE actors SET is_favorite = ? WHERE id=?').run(newStatus, id);
            // 本地更新狀態, 無需重新讀取整個列表, 提升效能
            setActors(prev => prev.map(a => a.id === id ? { ...a, is_favorite: newStatus } : a));
        } catch (e) {
            console.error(e);
            alert("更新失敗: " + e.message);
        }
    };

    return html`
        <div className="main-layout">
            <div className="sidebar">
                <h3 style=${{ marginTop: 0, marginBottom: '16px' }}>演員篩選</h3>
                <div className="filter-group">
                    <label className="filter-label">演員姓名</label>
                    <input className="filter-input" value=${uiFilters.name} onInput=${e => setUiFilters({ ...uiFilters, name: e.target.value })} placeholder="搜尋姓名..." />
                    <${SearchHelpText} />
                </div>
                <div className="filter-group">
                    <label className="filter-label">演員編號</label>
                    <input className="filter-input" value=${uiFilters.code} onInput=${e => setUiFilters({ ...uiFilters, code: e.target.value })} placeholder="例如: No.0001" />
                    <${SearchHelpText} />
                </div>
                <div className="filter-group">
                    <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked=${uiFilters.isFavorite} onChange=${e => setUiFilters({ ...uiFilters, isFavorite: e.target.checked })} style=${{ marginRight: 8 }} />
                        我的最愛
                    </label>
                </div>
                <div className="filter-group">
                    <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked=${uiFilters.noImage} onChange=${e => setUiFilters({ ...uiFilters, noImage: e.target.checked })} style=${{ marginRight: 8 }} />
                        尚缺圖片
                    </label>
                </div>
                <div className="sidebar-actions">
                    <button className="btn-block" style=${{ flex: 1 }} onClick=${handleApply}>套用篩選</button>
                    <button className="btn-block" style=${{ flex: 1 }} onClick=${handleClear}>清除篩選</button>
                </div>
            </div>
            <div className="content-area">
                <div className="content-header">
                    <div className="result-info">搜尋結果: 共${totalItems} 位</div>
                    <div style=${{ fontSize: '12px', color: '#666' }}>條件: ${appliedFilters.name || appliedFilters.code || appliedFilters.noImage || appliedFilters.isFavorite ? '篩選中' : '所有演員'}</div>
                    <div style=${{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button className="btn-primary" onClick=${() => { setEditingActorId(null); setIsModalOpen(true); }}><${Plus} size=${16} style=${{ marginRight: 4 }} /> 新增演員</button>
                        <select className="filter-input" style=${{ width: 'auto', padding: '6px 12px' }} value=${sortOrder} onChange=${e => setSortOrder(e.target.value)}>
                            <option value="number_desc">依編號 (由大到小)</option>
                            <option value="number_asc">依編號 (由小到大)</option>
                            <option value="name_asc">依名字 (由小到大)</option>
                            <option value="name_desc">依名字 (由大到小)</option>
                        </select>
                    </div>
                </div>
                <div className="card-grid" style=${{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                    ${actors.map(actor => html`<${ActorCard} key=${actor.id} actor=${actor} onEdit=${(id) => { setEditingActorId(id); setIsModalOpen(true); }} onDelete=${handleDelete} onImageClick=${(src) => setViewingImage(src)} onToggleFavorite=${handleToggleFavorite} />`)}
                </div>
                <div style=${{ marginTop: 'auto', borderTop: '1px solid #eee' }}>
                    <${Pagination} currentPage=${currentPage} totalPages=${totalPages} onPageChange=${p => setCurrentPage(p)} />
                </div>
            </div>
            ${isModalOpen && html`<${ActorEditModal} actorId=${editingActorId} setIsLoading=${setIsLoading} onClose=${() => setIsModalOpen(false)} onSaveSuccess=${loadActors} />`}
            ${viewingImage && html`<${ImageViewerModal} src=${viewingImage} onClose=${() => setViewingImage(null)} />`}
        </div>`;
}

module.exports = { ActorSystem };