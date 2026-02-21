const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const path = require('path');
const fs = require('fs');
const { webUtils, ipcRenderer } = require('electron');
const {
    Search, ChevronDown, ChevronRight: ChevronRightIcon, X,
    Star, ArrowLeft, Edit, Film, AlertTriangle, Check,
    Save, Plus, Trash2, Download, PanelLeft, Bookmark
} = require('lucide-react');

const { db, worksImgDir, actorsImgDir } = require('../utils/db');
const {
    getFileUrl, parseSearchQuery, stopPropagation, getNewActorNumber, getOrCreateActorId
} = require('../utils/helpers');
const {
    ConfirmModal, ImageViewerModal, SearchHelpText
} = require('./Shared');
const { ScraperModal } = require('./Scraper');

// 5. 篩選與選擇元件 (Filter & Selector)

function TagFilterSidebar({ selectedTagIds, onChange }) {
    const [groups, setGroups] = React.useState([]);
    const [expandedGroups, setExpandedGroups] = React.useState({});

    React.useEffect(() => {
        if (!db) return;
        try {
            const g = db.prepare('SELECT * FROM tag_groups ORDER BY sort_order ASC').all();
            const t = db.prepare('SELECT * FROM tags WHERE is_visible = 1 ORDER BY sort_order ASC').all();
            setGroups(g.map(grp => ({ ...grp, tags: t.filter(tag => tag.group_id === grp.id) })));
        } catch (e) { console.error(e); }
    }, []);

    const toggleGroup = (groupId) => { setExpandedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] })); };

    const toggleTag = (tagId) => {
        if (selectedTagIds.includes(tagId)) onChange(selectedTagIds.filter(id => id !== tagId));
        else onChange([...selectedTagIds, tagId]);
    };

    return html`
        <div className="tag-filter-sidebar" style=${{ borderTop: '1px solid #eee', paddingTop: '16px' }}>
            <div style=${{ fontWeight: 'bold', marginBottom: '8px', color: '#666' }}>標籤篩選 (AND)</div>
            ${groups.map(group => {
                const selectedCount = group.tags.filter(t => selectedTagIds.includes(t.id)).length;
                const isExpanded = expandedGroups[group.id];
                const groupStyle = group.color ? { borderLeft: `4px solid ${group.color}` } : {};
                
                return html`
                <div key=${group.id} style=${{ marginBottom: '4px' }}>
                    <div onClick=${() => toggleGroup(group.id)} style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '6px', backgroundColor: '#f9f9f9', borderRadius: '4px', fontSize: '14px', ...groupStyle }}>
                        ${isExpanded ? html`<${ChevronDown} size=${14} />` : html`<${ChevronRightIcon} size=${14} />`}
                        <span style=${{ marginLeft: '4px', flex: 1 }}>${group.name}</span>
                        ${selectedCount > 0 && html`<span style=${{ backgroundColor: '#2196F3', color: 'white', borderRadius: '10px', padding: '2px 6px', fontSize: '10px' }}>${selectedCount}</span>`}
                    </div>
                    ${isExpanded && html`
                        <div style=${{ paddingLeft: '20px', paddingBottom: '8px' }}>
                            ${group.tags.map(tag => html`
                                <label key=${tag.id} style=${{ display: 'flex', alignItems: 'center', padding: '4px 0', cursor: 'pointer', fontSize: '13px' }}>
                                    <input type="checkbox" checked=${selectedTagIds.includes(tag.id)} onChange=${() => toggleTag(tag.id)} style=${{ marginRight: '6px' }} />
                                    <span style=${selectedTagIds.includes(tag.id) ? { color: '#2196F3', fontWeight: 'bold' } : {}}>${tag.name}</span>
                                </label>
                            `)}
                            ${group.tags.length === 0 && html`<div style=${{ fontSize: '12px', color: '#ccc', padding: '4px 0' }}>無標籤</div>`}
                        </div>
                    `}
                </div>`;
            })}
        </div>`;
}

function ActorFilter({ value, onChange }) {
    const [suggestions, setSuggestions] = React.useState([]);
    const [showSuggestions, setShowSuggestions] = React.useState(false);
    
    const currentMode = value?.mode || 'OR';
    const currentItems = value?.items || [];
    const inputValue = value?.inputValue || "";

    React.useEffect(() => {
        if (!db) return;
        if (!inputValue || !inputValue.trim()) { setSuggestions([]); return; }
        const timer = setTimeout(() => {
            const results = db.prepare('SELECT id, name, actor_number FROM actors WHERE is_deleted = 0 AND name LIKE ? LIMIT 10').all(`%${inputValue.trim()}%`);
            setSuggestions(results);
        }, 200);
        return () => clearTimeout(timer);
    }, [inputValue]);

    const addActor = (actorName, actorId = null) => {
        if (currentItems.find(i => i.name.toLowerCase() === actorName.toLowerCase())) return;
        onChange({ ...value, items: [...currentItems, { id: actorId, name: actorName }], inputValue: "" });
        setSuggestions([]);
        setShowSuggestions(false);
    };

    const removeActor = (index) => {
        const newItems = [...currentItems];
        newItems.splice(index, 1);
        onChange({ ...value, items: newItems });
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (!inputValue.trim()) return;
            const exactMatch = suggestions.find(s => s.name.toLowerCase() === inputValue.trim().toLowerCase());
            if (exactMatch) addActor(exactMatch.name, exactMatch.id);
            else addActor(inputValue.trim(), null);
        }
    };

    const toggleMode = () => { onChange({ ...value, mode: currentMode === 'OR' ? 'AND' : 'OR' }); };

    return html`
        <div className="actor-filter">
            <div style=${{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                <label className="filter-label" style=${{ marginBottom: 0, flex: 1 }}>演員</label>
                <div style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '12px' }} onClick=${toggleMode}>
                    <span style=${{ fontWeight: currentMode === 'AND' ? 'bold' : 'normal', color: currentMode === 'AND' ? '#2196F3' : '#ccc' }}>AND</span>
                    <div style=${{ width: 24, height: 12, backgroundColor: '#ddd', borderRadius: 6, margin: '0 4px', position: 'relative' }}>
                        <div style=${{ position: 'absolute', top: 1, left: currentMode === 'OR' ? 13 : 1, width: 10, height: 10, backgroundColor: '#fff', borderRadius: '50%', transition: 'left 0.2s' }} />
                    </div>
                    <span style=${{ fontWeight: currentMode === 'OR' ? 'bold' : 'normal', color: currentMode === 'OR' ? '#2196F3' : '#ccc' }}>OR</span>
                </div>
            </div>
            <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                ${currentItems.map((item, idx) => html`
                    <div key=${idx} className="pill" style=${{ fontSize: 12, padding: '2px 8px', backgroundColor: '#e3f2fd', color: '#0d47a1', borderRadius: '12px', display: 'flex', alignItems: 'center' }}>
                        ${item.name} <div style=${{ marginLeft: 4, cursor: 'pointer' }} onClick=${() => removeActor(idx)}><${X} size=${12}/></div>
                    </div>
                `)}
            </div>
            <div style=${{ position: 'relative' }}>
                <input className="filter-input" value=${inputValue} onInput=${e => { onChange({ ...value, inputValue: e.target.value }); setShowSuggestions(true); }} onFocus=${() => setShowSuggestions(true)} onKeyDown=${handleKeyDown} placeholder="搜尋演員..." />
                ${showSuggestions && inputValue && html`
                    <div style=${{ position: 'absolute', top: '100%', left: 0, width: '100%', zIndex: 100, backgroundColor: 'white', border: '1px solid #ccc', borderRadius: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                        ${suggestions.map(s => html`
                            <div key=${s.id} style=${{ padding: '6px 8px', cursor: 'pointer', borderBottom: '1px solid #eee' }} onMouseDown=${(e) => { e.preventDefault(); addActor(s.name, s.id); }}>
                                ${s.name} <span style=${{ color: '#888', fontSize: 12 }}>${s.actor_number}</span>
                            </div>
                        `)}
                        ${suggestions.length === 0 && html`<div style=${{ padding: 8, color: '#666', fontSize: 12 }}>無結果 按Enter 新增 "${inputValue}"</div>`}
                    </div>
                `}
            </div>
            <div style=${{ fontSize: 10, color: '#888', marginTop: 2 }}>目前邏輯: 符合${currentMode === 'AND' ? '所有' : '任一'}演員 (或直接點選套用進行文字搜尋)</div>
        </div>`;
}

function WorkSidebar({ uiFilters, setUiFilters, onApply, onClear }) {
    const actorFilterValue = typeof uiFilters.actor === 'string' ? { mode: 'OR', items: [], inputValue: "" } : uiFilters.actor;

    return html`
        <div className="sidebar">
            <h3 style=${{ marginTop: 0, marginBottom: '16px' }}>作品篩選</h3>
            
            <div className="filter-group">
                <label className="filter-label">作品名稱</label>
                <div style=${{ position: 'relative' }}>
                    <input className="filter-input" style=${{ paddingRight: '30px' }} value=${uiFilters.name} onInput=${e => setUiFilters({ ...uiFilters, name: e.target.value })} placeholder="搜尋名稱..." />
                    <div style=${{ position: 'absolute', right: 8, top: 10 }}><${Search} size=${16} color="#999" /></div>
                </div>
                <${SearchHelpText} />
            </div>

            <div className="filter-group">
                <label className="filter-label">識別碼</label>
                <input className="filter-input" value=${uiFilters.code} onInput=${e => setUiFilters({ ...uiFilters, code: e.target.value })} placeholder="例如: ABC-123" />
                <${SearchHelpText} />
            </div>

            <div className="filter-group">
                <${ActorFilter} value=${actorFilterValue} onChange=${newValue => setUiFilters({ ...uiFilters, actor: newValue })} />
            </div>

            <div className="filter-group">
                <label className="filter-label">評分 (最高5分, 大於或等於判定)</label>
                <input type="number" step="0.1" className="filter-input" value=${uiFilters.rating} onInput=${e => setUiFilters({ ...uiFilters, rating: e.target.value })} placeholder="例如: 4.0" />
            </div>

            <div className="filter-group">
                <label className="filter-label">導演</label>
                <input className="filter-input" value=${uiFilters.director} onInput=${e => setUiFilters({ ...uiFilters, director: e.target.value })} placeholder="搜尋導演..." />
                <${SearchHelpText} />
            </div>

            <div className="filter-group">
                <label className="filter-label">製作商</label>
                <input className="filter-input" value=${uiFilters.maker} onInput=${e => setUiFilters({ ...uiFilters, maker: e.target.value })} placeholder="搜尋製作商..." />
                <${SearchHelpText} />
            </div>

            <div className="filter-group">
                <label className="filter-label">發行商</label>
                <input className="filter-input" value=${uiFilters.publisher} onInput=${e => setUiFilters({ ...uiFilters, publisher: e.target.value })} placeholder="搜尋發行商..." />
                <${SearchHelpText} />
            </div>

            <div className="filter-group">
                <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked=${uiFilters.favoriteActor || false} onChange=${e => setUiFilters({ ...uiFilters, favoriteActor: e.target.checked })} style=${{ marginRight: 8 }} />
                    關注演員
                </label>
            </div>

            <div className="filter-group">
                <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked=${uiFilters.watchlist || false} onChange=${e => setUiFilters({ ...uiFilters, watchlist: e.target.checked })} style=${{ marginRight: 8 }} />
                    待看關注
                </label>
            </div>

            <${TagFilterSidebar} selectedTagIds=${uiFilters.tags} onChange=${newTags => setUiFilters({ ...uiFilters, tags: newTags })} />

            <div className="sidebar-actions" style=${{ display: 'flex', gap: '8px', marginTop: '24px', paddingBottom: '8px' }}>
                <button className="btn-block" style=${{ flex: 1 }} onClick=${onApply}>套用篩選</button>
                <button className="btn-block" style=${{ flex: 1 }} onClick=${onClear}>清除篩選</button>
            </div>
        </div>`;
}

function ActorSelector({ selectedActors, onChange, inputValue, onInputChange }) {
    const [suggestions, setSuggestions] = React.useState([]);
    const [showSuggestions, setShowSuggestions] = React.useState(false);

    React.useEffect(() => {
        if (!db) return;
        if (!inputValue || !inputValue.trim()) { setSuggestions([]); return; }
        const timer = setTimeout(() => {
            const results = db.prepare('SELECT id, name, actor_number FROM actors WHERE is_deleted = 0 AND name LIKE ? LIMIT 50').all(`%${inputValue.trim()}%`);
            setSuggestions(results);
        }, 200);
        return () => clearTimeout(timer);
    }, [inputValue]);

    const addActor = (actor) => {
        if (!selectedActors.find(a => a.name.toLowerCase() === actor.name.toLowerCase())) onChange([...selectedActors, actor]);
        if (onInputChange) onInputChange("");
        setSuggestions([]);
        setShowSuggestions(false);
    };

    const removeActor = (index) => {
        const newActors = [...selectedActors];
        newActors.splice(index, 1);
        onChange(newActors);
    };

    const createNewActorExplicitly = () => {
        if (!db || !inputValue || !inputValue.trim()) return;
        const trimmedName = inputValue.trim();
        const existing = db.prepare('SELECT id FROM actors WHERE name = ? AND is_deleted = 0').get(trimmedName);
        if (existing) return alert('已存在相同名稱的演員');
        
        const actorId = getOrCreateActorId(db, trimmedName);
        if (actorId) {
            const actorNumber = db.prepare('SELECT actor_number FROM actors WHERE id = ?').get(actorId).actor_number;
            addActor({ id: actorId, name: trimmedName, actor_number: actorNumber, isTextOnly: false });
            alert(`已建立演員卡片: 「${trimmedName}」`);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (!inputValue.trim()) return;
            const val = inputValue.trim();
            const exactMatch = suggestions.find(s => s.name.toLowerCase() === val.toLowerCase());
            if (exactMatch) addActor({ ...exactMatch, isTextOnly: false });
            else addActor({ id: null, name: val, actor_number: null, isTextOnly: true });
        }
    };

    return html`
        <div className="actor-selector" style=${{ position: 'relative' }}>
            <div className="pills-container">
                ${selectedActors.map((actor, idx) => html`
                    <div className="pill" key=${idx} style=${actor.isTextOnly ? { backgroundColor: '#f0f0f0', color: '#333', border: '1px solid #ccc' } : {}} title=${actor.isTextOnly ? '純文字 (未建立卡片)' : actor.actor_number}>
                        <span>${actor.name}</span>
                        <button onClick=${() => removeActor(idx)}><${X} size=${12}/></button>
                    </div>
                `)}
            </div>
            <input className="filter-input" value=${inputValue} onInput=${e => { if (onInputChange) onInputChange(e.target.value); setShowSuggestions(true); }} onFocus=${() => setShowSuggestions(true)} onKeyDown=${handleKeyDown} placeholder="輸入演員姓名... (Enter 設為純文字, 點選下方按鈕建立卡片)" />
            
            ${showSuggestions && inputValue && html`
                <div style=${{ position: 'absolute', top: '100%', left: 0, width: '100%', zIndex: 1000, backgroundColor: 'white', border: '1px solid #ccc', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto' }}>
                    <div style=${{ padding: '8px', cursor: 'pointer', color: '#2196F3', fontWeight: 'bold' }} onMouseDown=${(e) => { e.preventDefault(); createNewActorExplicitly(); }}>
                        <${Plus} size=${14} style=${{ marginRight: 4, verticalAlign: 'middle' }} /> 新增「${inputValue}」為演員卡片
                    </div>
                    ${suggestions.map(s => html`
                        <div key=${s.id} style=${{ padding: '6px 8px', cursor: 'pointer', borderBottom: '1px solid #eee' }} onMouseDown=${(e) => { e.preventDefault(); addActor({ ...s, isTextOnly: false }); }}>
                            <span>${s.name}</span> <span style=${{ color: '#888', fontSize: '12px' }}>${s.actor_number}</span>
                        </div>
                    `)}
                </div>
            `}
            ${showSuggestions && html`<div style=${{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 999 }} onClick=${() => setShowSuggestions(false)} />`}
        </div>`;
}

function TagSelector({ selectedTags, onChange }) {
    const [groups, setGroups] = React.useState([]);

    React.useEffect(() => {
        try {
            const g = db.prepare('SELECT * FROM tag_groups ORDER BY sort_order ASC').all();
            const t = db.prepare('SELECT * FROM tags WHERE is_visible = 1 ORDER BY sort_order ASC').all();
            setGroups(g.map(group => ({ ...group, tags: t.filter(tag => tag.group_id === group.id) })));
        } catch (e) { }
    }, []);

    const toggleTag = (tag) => {
        const exists = selectedTags.find(t => t.id === tag.id);
        if (exists) onChange(selectedTags.filter(t => t.id !== tag.id));
        else onChange([...selectedTags, tag]);
    };

    return html`
        <div className="tag-selector-container">
            ${groups.map(group => html`
                <div className="tag-selector-group" key=${group.id}>
                    <div className="group-title">${group.name}</div>
                    <div className="tag-chips">
                        ${group.tags.map(tag => {
                            const isSelected = selectedTags.some(t => t.id === tag.id);
                            const style = tag.color ? { backgroundColor: tag.color, color: '#fff', borderColor: tag.color } : {};
                            if (isSelected && tag.color) style.boxShadow = '0 0 2px #333';
                            return html`
                                <div className="tag-chip ${isSelected ? 'selected' : ''}" style=${style} onClick=${() => toggleTag(tag)}>
                                    ${tag.name}
                                    ${isSelected && html`<${Check} size=${12} style=${{ marginLeft: 4 }} />`}
                                </div>`;
                        })}
                        ${group.tags.length === 0 && html`<span style=${{ color: '#ccc', fontSize: 12 }}>無標籤</span>`}
                    </div>
                </div>
            `)}
        </div>`;
}
// 8. 作品系統元件 (Work System)

function WorkDetails({ workId, onBack, onEdit, uiFilters, setUiFilters, onApply, onClear }) {
    const [work, setWork] = React.useState(null);
    const [images, setImages] = React.useState([]);
    const [previewIndex, setPreviewIndex] = React.useState(0);
    const [viewingImage, setViewingImage] = React.useState(null);
    const [linkedActors, setLinkedActors] = React.useState([]);
    const [linkedTags, setLinkedTags] = React.useState([]);
    const [viewingActorImage, setViewingActorImage] = React.useState(null);
    // 新增: 篩選器側邊欄顯示狀態 (預設收闔)
    const [isFilterSidebarOpen, setIsFilterSidebarOpen] = React.useState(false);

    React.useEffect(() => {
        if (!db) return;
        try {
            setWork(db.prepare('SELECT * FROM works WHERE id=?').get(workId));
            
            // 修正: 讀取圖片後，主動將預覽索引設為封面圖片 (isCover=1)
            const loadedImages = db.prepare('SELECT * FROM work_images WHERE work_id = ? ORDER BY sort_order ASC').all(workId).map(row => ({
                id: row.id,
                url: getFileUrl(path.join(worksImgDir, row.file_name)),
                isCover: row.is_cover === 1
            }));
            
            setImages(loadedImages);
            
            // 自動查找封面索引
            const coverIndex = loadedImages.findIndex(img => img.isCover);
            if (coverIndex !== -1) {
                setPreviewIndex(coverIndex);
            } else {
                setPreviewIndex(0);
            }

            setLinkedActors(db.prepare(`SELECT CASE WHEN wal.actor_id IS NOT NULL THEN a.name ELSE wal.actor_name END as name, a.image_path, a.actor_number, CASE WHEN a.is_deleted = 0 THEN wal.actor_id ELSE NULL END as actor_id FROM work_actor_link wal LEFT JOIN actors a ON wal.actor_id = a.id WHERE wal.work_id = ? ORDER BY wal.sort_order ASC`).all(workId));
            setLinkedTags(db.prepare(`SELECT t.id, t.name, t.color, tg.name as group_name, tg.color as group_color FROM work_tag_link wtl JOIN tags t ON wtl.tag_id = t.id JOIN tag_groups tg ON t.group_id = tg.id WHERE wtl.work_id = ? ORDER BY tg.sort_order ASC, t.sort_order ASC`).all(workId));
        } catch (err) { console.error(err); }
    }, [workId]);

    // 中鍵處理邏輯: 演員
    const handleMiddleClickActor = (e, actor) => {
        if (e.button === 1) { // 1 = 滑鼠中鍵
            e.preventDefault();
            if (!actor.actor_id) return; // 僅處理已建立卡片的演員
            
            const currentActors = uiFilters.actor?.items || [];
            // 避免重複加入
            if (!currentActors.find(a => a.id === actor.actor_id)) {
                setUiFilters({
                    ...uiFilters,
                    actor: {
                        ...uiFilters.actor,
                        items: [...currentActors, { id: actor.actor_id, name: actor.name }]
                    }
                });
            }
            // 自動開啟篩選器側邊欄以便檢視
            setIsFilterSidebarOpen(true);
        }
    };

    // 中鍵處理邏輯: 標籤
    const handleMiddleClickTag = (e, tagId) => {
        if (e.button === 1) { // 1 = 滑鼠中鍵
            e.preventDefault();
            const currentTags = uiFilters.tags || [];
            // 避免重複加入
            if (!currentTags.includes(tagId)) {
                setUiFilters({
                    ...uiFilters,
                    tags: [...currentTags, tagId]
                });
            }
            // 自動開啟篩選器側邊欄以便檢視
            setIsFilterSidebarOpen(true);
        }
    };

    if (!work) return html`<div className="main-layout">載入中...</div>`;

    const groups = [];
    linkedTags.forEach(tag => {
        let group = groups.find(g => g.name === tag.group_name);
        if (!group) { group = { name: tag.group_name, color: tag.group_color, tags: [] }; groups.push(group); }
        group.tags.push(tag);
    });

    return html`
        <div className="main-layout">
            ${isFilterSidebarOpen && html`<${WorkSidebar} uiFilters=${uiFilters} setUiFilters=${setUiFilters} onApply=${onApply} onClear=${onClear} />`}
            
            <div className="sidebar" style=${{ width: '65%' }}>
                <div style=${{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                    <button className="btn-ghost" onClick=${() => setIsFilterSidebarOpen(!isFilterSidebarOpen)} title=${isFilterSidebarOpen ? "隱藏側邊欄" : "顯示側邊欄"} style=${{ marginRight: '8px', padding: '4px' }}>
                        <${PanelLeft} size=${20} />
                    </button>
                    <h3 style=${{ margin: 0 }}>作品預覽</h3>
                </div>
                <div className="main-preview" style=${{ flex: 3, backgroundColor: '#000', marginBottom: '10px' }}>
                    ${images[previewIndex] ? html`<img src="${images[previewIndex].url}" style=${{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'zoom-in' }} onClick=${() => setViewingImage(images[previewIndex].url)} />` : html`<div style=${{ color: '#666' }}>無圖片</div>`}
                </div>
                <div className="thumbnail-list" style=${{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                    ${images.map((img, idx) => html`<div className="thumbnail-item ${idx === previewIndex ? 'active' : ''}" style=${{ width: 160, height: 100, flexShrink: 0 }} onClick=${() => setPreviewIndex(idx)}><img src="${img.url}" /></div>`)}
                </div>
            </div>

            <div className="content-area">
                <div className="content-header">
                    <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div className="nav-btn" onClick=${onBack} style=${{ cursor: 'pointer' }}><${ArrowLeft} size=${24} /></div>
                    </div>
                    <div className="result-info" style=${{ flex: 1, marginLeft: '16px' }}>作品詳情</div>
                    <button className="btn-primary" onClick=${() => onEdit(workId)}><${Edit} size=${16} style=${{ marginRight: 6 }} /> 編輯作品</button>
                </div>

                <div style=${{ maxWidth: '800px' }}>
                    <div className="filter-group"><label className="filter-label">識別碼</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.work_number}</div></div>
                    <div className="filter-group"><label className="filter-label">作品名稱</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.name}</div></div>
                    <div className="filter-group"><label className="filter-label">發行日期</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.release_date || '未設定'}</div></div>
                    <div className="filter-group"><label className="filter-label">影片解析度</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.resolution || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">影片長度</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.duration || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">實際檔案長度</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.file_size || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">導演</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.director || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">製作商</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.maker || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">發行商</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.publisher || ''}</div></div>
                    
                    <div className="filter-group">
                        <label className="filter-label">演員</label>
                        <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '8px 0' }}>
                            ${linkedActors.map(actor => {
                                const isRealActor = !!actor.actor_id;
                                return html`<span 
                                    style=${{ padding: '4px 8px', borderRadius: '4px', backgroundColor: '#e3f2fd', color: isRealActor ? '#2196F3' : '#333', cursor: isRealActor ? 'pointer' : 'default', textDecoration: isRealActor ? 'underline' : 'none', fontWeight: isRealActor ? 'bold' : 'normal' }} 
                                    onClick=${() => isRealActor && actor.image_path && setViewingActorImage(getFileUrl(path.join(actorsImgDir, actor.image_path)))} 
                                    onMouseDown=${(e) => handleMiddleClickActor(e, actor)}
                                    title=${isRealActor ? `${actor.actor_number} (中鍵點擊加入篩選)` : '純文字標籤'}>
                                    ${actor.name}
                                </span>`;
                            })}
                            ${linkedActors.length === 0 && html`<span style=${{ color: '#999' }}>無關聯演員</span>`}
                        </div>
                    </div>

                    <div className="filter-group"><label className="filter-label">評分</label><div style=${{ display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 0', fontSize: '18px', fontWeight: 'bold', color: '#fbc02d' }}><${Star} size=${20} fill="#fbc02d" /> ${work.rating !== null && work.rating !== undefined ? work.rating : '尚未評分'}</div></div>

                    <div className="filter-group"><label className="filter-label">待看關注</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: '4px' }}>${work.is_watchlist ? html`<${Bookmark} size=${20} color="#e91e63" fill="#e91e63" /> <span style=${{ color: '#e91e63', fontWeight: 'bold' }}>已標記</span>` : html`<span style=${{ color: '#999' }}>未標記</span>`}</div></div>

                    <div className="filter-group">
                        <label className="filter-label">標籤</label>
                        <div style=${{ padding: '8px 0' }}>
                            ${groups.map(group => html`
                                <div style=${{ marginBottom: 8, display: 'flex', alignItems: 'center' }}>
                                    <span style=${{ display: 'inline-block', padding: '2px 8px', borderRadius: '4px', marginRight: 8, fontSize: '12px', fontWeight: 'bold', backgroundColor: group.color || '#eee', color: group.color ? '#fff' : '#333' }}>${group.name}</span>
                                    <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                        ${group.tags.map(tag => html`<span 
                                            className="tag-chip" 
                                            style=${tag.color ? { backgroundColor: tag.color, color: '#fff', borderColor: tag.color } : {}}
                                            onMouseDown=${(e) => handleMiddleClickTag(e, tag.id)}
                                            title="中鍵點擊加入篩選">
                                            ${tag.name}
                                        </span>`)}
                                    </div>
                                </div>
                            `)}
                            ${groups.length == 0 && html`<span style=${{ color: '#999' }}>無標籤</span>`}
                        </div>
                    </div>
                </div>
            </div>
            ${viewingImage && html`<${ImageViewerModal} src=${viewingImage} onClose=${() => setViewingImage(null)} />`}
            ${viewingActorImage && html`<${ImageViewerModal} src=${viewingActorImage} onClose=${() => setViewingActorImage(null)} />`}
        </div>`;
}

function WorkEditor({ initialWorkId, onCancel, onSaveSuccess, setIsLoading }) {
    const isEditMode = !!initialWorkId;
    const [formData, setFormData] = React.useState({ work_number: '', name: '', release_date: '', resolution: '', duration: '', file_size: '', director: '', maker: '', publisher: '', rating: '', is_watchlist: 0 });
    const [images, setImages] = React.useState([]);
    const [deletedImageIds, setDeletedImageIds] = React.useState([]);
    const [previewIndex, setPreviewIndex] = React.useState(0);
    const [dragOver, setDragOver] = React.useState(false);
    const [draggingIndex, setDraggingIndex] = React.useState(null);
    const fileInputRef = React.useRef(null);
    const [selectedActors, setSelectedActors] = React.useState([]);
    const [selectedTags, setSelectedTags] = React.useState([]);
    const [actorInputValue, setActorInputValue] = React.useState("");
    const [initialState, setInitialState] = React.useState(null);
    const [showDirtyWarning, setShowDirtyWarning] = React.useState(false);
    // 新增狀態: 自動抓取
    const [isScraperOpen, setIsScraperOpen] = React.useState(false);

    React.useEffect(() => {
        if (!db) return;
        if (isEditMode) {
            try {
                const work = db.prepare('SELECT * FROM works WHERE id=?').get(initialWorkId);
                if (work) setFormData({ ...work, rating: work.rating != null ? String(work.rating) : '', is_watchlist: work.is_watchlist || 0 });

                const loadedImages = db.prepare('SELECT * FROM work_images WHERE work_id = ? ORDER BY sort_order ASC').all(initialWorkId).map(row => ({
                    id: Date.now() + Math.random(),
                    dbId: row.id,
                    previewUrl: getFileUrl(path.join(worksImgDir, row.file_name)),
                    filePath: path.join(worksImgDir, row.file_name),
                    isStored: true,
                    isCover: row.is_cover === 1
                }));
                setImages(loadedImages);

                const linkedA = db.prepare(`SELECT wal.actor_id as id, CASE WHEN wal.actor_id IS NOT NULL THEN a.name ELSE wal.actor_name END as name, a.actor_number FROM work_actor_link wal LEFT JOIN actors a ON wal.actor_id = a.id WHERE wal.work_id = ? ORDER BY wal.sort_order ASC`).all(initialWorkId).map(a => ({ ...a, isTextOnly: !a.id }));
                setSelectedActors(linkedA);

                const linkedT = db.prepare('SELECT t.id, t.name, t.color, t.group_id FROM work_tag_link wtl JOIN tags t ON wtl.tag_id = t.id WHERE wtl.work_id = ?').all(initialWorkId);
                setSelectedTags(linkedT);

                setInitialState({ formData: { ...work, rating: work.rating !== null ? String(work.rating) : '', is_watchlist: work.is_watchlist || 0 }, images: JSON.stringify(loadedImages.map(i => i.dbId || i.filePath)), actors: JSON.stringify(linkedA), tags: JSON.stringify(linkedT) });
            } catch (err) { }
        } else {
            setInitialState({ formData: { work_number: '', name: '', release_date: '', resolution: '', duration: '', file_size: '', director: '', maker: '', publisher: '', rating: '', is_watchlist: 0 }, images: '[]', actors: '[]', tags: '[]' });
        }
    }, [initialWorkId]);

    const handleChange = (field, value) => setFormData(prev => ({ ...prev, [field]: value }));

    const processNewFiles = async (fileList) => {
        const files = Array.from(fileList);
        const newImages = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            let realPath = file.path;
            if (!realPath) try { realPath = webUtils.getPathForFile(file); } catch (err) { }
            if (!realPath) continue;

            // 判斷是否為影片檔案 (基於 MIME type 或副檔名)
            const isVideo = file.type.startsWith('video/') || ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv'].includes(path.extname(realPath).toLowerCase());
            
            if (isVideo) {
                // 處理影片: 讀取 Metadata
                setIsLoading(true);
                try {
                    const metadata = await ipcRenderer.invoke('get-video-metadata', realPath);
                    setFormData(prev => ({
                        ...prev,
                        resolution: metadata.resolution,
                        file_size: metadata.duration // 這裡將 duration 寫入 file_size 欄位 (實際檔案長度)
                    }));
                    // alert(`已讀取影片資訊:\n解析度: ${metadata.resolution}\n長度: ${metadata.duration}`);
                } catch (err) {
                    console.error("Video metadata error:", err);
                    alert("無法讀取影片資訊: " + err.message);
                } finally {
                    setIsLoading(false);
                }
            } else if (['image/jpeg', 'image/png'].includes(file.type)) {
                // 處理圖片: 加入預覽列表
                newImages.push({
                    id: Date.now() + Math.random() + i,
                    previewUrl: URL.createObjectURL(file),
                    filePath: realPath,
                    isStored: false
                });
            }
        }
        if (newImages.length > 0) setImages(prev => [...prev, ...newImages]);
    };

    const handleDropUpload = (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); if (e.dataTransfer.files.length > 0) processNewFiles(e.dataTransfer.files); };
    const handleSortDrop = (e, targetIndex) => {
        // 修正: 增加 stopPropagation 防止事件冒泡導致與上傳邏輯衝突
        e.preventDefault(); 
        e.stopPropagation(); 
        if (draggingIndex === null || draggingIndex === targetIndex) return;
        setImages(prev => { const newList = [...prev]; const [moved] = newList.splice(draggingIndex, 1); newList.splice(targetIndex, 0, moved); return newList; });
        setDraggingIndex(null);
    };

    const handleDeleteImage = (index, e) => {
        e.stopPropagation(); if (!confirm('移除此圖片?')) return;
        const img = images[index]; if (img.isStored) setDeletedImageIds(p => [...p, img.dbId]);
        setImages(p => p.filter((_, i) => i !== index));
    };

    const isDirty = () => {
        if (!initialState) return false;
        return JSON.stringify(formData) !== JSON.stringify(initialState.formData) || JSON.stringify(selectedActors) !== initialState.actors || JSON.stringify(selectedTags) !== initialState.tags || JSON.stringify(images.map(i => i.dbId || i.filePath)) !== initialState.images;
    };

    const attemptCancel = () => { if (isDirty()) setShowDirtyWarning(true); else onCancel(); };

    // 處理抓取結果
    const handleScrapeResult = (newData) => {
        // 1. 更新基本欄位
        setFormData(prev => ({
            ...prev,
            name: newData.name || prev.name || '',
            release_date: newData.release_date || prev.release_date || '',
            duration: newData.duration || prev.duration || '',
            director: newData.director || prev.director || '',
            maker: newData.maker || prev.maker || '',
            publisher: newData.publisher || prev.publisher || ''
        }));

        // 2. 處理演員資料
        if (newData.actors && Array.isArray(newData.actors)) {
            let currentSelectedActors = [...selectedActors];
            const timestamp = Date.now();
            try {
                db.transaction(() => {
                    newData.actors.forEach(actorName => {
                        const trimmedName = actorName.trim();
                        if (!trimmedName) return;
                        if (currentSelectedActors.some(a => a.name === trimmedName)) return;

                        let actor = db.prepare('SELECT id, actor_number FROM actors WHERE name = ? AND is_deleted = 0').get(trimmedName);
                        let info;
                        let newNumber;
                        
                        if (!actor) {
                            newNumber = getNewActorNumber(db);
                            info = db.prepare('INSERT INTO actors (actor_number, name, created_at, is_favorite) VALUES (?, ?, ?, 0)').run(newNumber, trimmedName, timestamp);
                            actor = { id: info.lastInsertRowid, actor_number: newNumber };
                        }

                        currentSelectedActors.push({
                            id: actor.id,
                            name: trimmedName,
                            actor_number: actor.actor_number,
                            isTextOnly: false
                        });
                    });
                })();
                setTimeout(() => {
                    setSelectedActors(currentSelectedActors);
                }, 100);
            } catch (error) {
                console.error("Auto-create actors failed:", error);
                alert("自動建立演員資料失敗: " + error.message);
            }
        }
        setIsScraperOpen(false);
        alert(`抓取成功!\n名稱: ${newData.name}\n日期: ${newData.release_date}\n演員: ${newData.actors ? newData.actors.length : 0}位`);
    };

    const handleSave = () => {
        if (!db) return;
        if (!formData.work_number || !formData.name) return alert('編號與名稱必填');

        const ratingVal = formData.rating.trim() === '' ? null : parseFloat(formData.rating);

        setIsLoading(true);
        setTimeout(() => {
            try {
                db.transaction(() => {
                    let workId = initialWorkId;
                    const saveData = { ...formData, rating: ratingVal };

                    if (isEditMode) {
                        db.prepare(`UPDATE works SET work_number=@work_number, name=@name, release_date=@release_date, resolution=@resolution, duration=@duration, file_size=@file_size, director=@director, maker=@maker, publisher=@publisher, rating=@rating, is_watchlist=@is_watchlist WHERE id=@id`).run({ ...saveData, id: workId });
                    } else {
                        workId = db.prepare(`INSERT INTO works (work_number, name, release_date, resolution, duration, file_size, director, maker, publisher, rating, is_watchlist, created_at) VALUES (@work_number, @name, @release_date, @resolution, @duration, @file_size, @director, @maker, @publisher, @rating, @is_watchlist, @created_at)`).run({ ...saveData, created_at: Date.now() }).lastInsertRowid;
                    }

                    if (deletedImageIds.length > 0) {
                        const delStmt = db.prepare('SELECT file_name FROM work_images WHERE id = ?');
                        const delExec = db.prepare('DELETE FROM work_images WHERE id = ?');
                        deletedImageIds.forEach(id => {
                            const row = delStmt.get(id);
                            if (row && fs.existsSync(path.join(worksImgDir, row.file_name)))
                                fs.unlinkSync(path.join(worksImgDir, row.file_name));
                            delExec.run(id);
                        });
                    }

                    // 修正: 移除 currentMaxSeq 的計數器依賴，避免與現有檔案衝突
                    const insertImg = db.prepare('INSERT INTO work_images (work_id, file_name, sort_order, is_cover) VALUES (?, ?, ?, ?)');
                    const updateImg = db.prepare('UPDATE work_images SET sort_order = ?, is_cover = ? WHERE id = ?');

                    images.forEach((img, idx) => {
                        const isCover = idx === 0 ? 1 : 0;
                        if (img.isStored) {
                            updateImg.run(idx + 1, isCover, img.dbId);
                        } else {
                            // 修正: 改用時間戳記+亂數命名，確保檔案名稱唯一，絕對不會覆蓋舊檔
                            const ext = path.extname(img.filePath);
                            const timestamp = Date.now();
                            const randomSuffix = Math.floor(Math.random() * 10000);
                            const newName = `works_${formData.work_number}_${timestamp}_${randomSuffix}${ext}`;
                            
                            fs.copyFileSync(img.filePath, path.join(worksImgDir, newName));
                            insertImg.run(workId, newName, idx + 1, isCover);
                        }
                    });

                    db.prepare('DELETE FROM work_actor_link WHERE work_id = ?').run(workId);
                    const insActor = db.prepare('INSERT INTO work_actor_link (work_id, actor_id, actor_name, sort_order) VALUES (?, ?, ?, ?)');
                    selectedActors.forEach((a, idx) => insActor.run(workId, a.id, a.isTextOnly ? a.name : null, idx + 1));

                    db.prepare('DELETE FROM work_tag_link WHERE work_id = ?').run(workId);
                    const insTag = db.prepare('INSERT INTO work_tag_link (work_id, tag_id) VALUES (?, ?)');
                    selectedTags.forEach(t => insTag.run(workId, t.id));

                })();
                setTimeout(() => {
                    setIsLoading(false);
                    onSaveSuccess();
                }, 100);
            } catch (err) { setIsLoading(false); alert(err.message); }
        }, 100);
    };

    const handleDeleteWork = () => {
        if (!confirm('確定永久刪除?')) return;
        setIsLoading(true);
        setTimeout(() => {
            try {
                db.transaction(() => {
                    const imgs = db.prepare('SELECT file_name FROM work_images WHERE work_id = ?').all(initialWorkId);
                    imgs.forEach(i => { try { fs.unlinkSync(path.join(worksImgDir, i.file_name)); } catch (e) { } });
                    db.prepare('DELETE FROM work_images WHERE work_id = ?').run(initialWorkId);
                    db.prepare('DELETE FROM work_actor_link WHERE work_id = ?').run(initialWorkId);
                    db.prepare('DELETE FROM work_tag_link WHERE work_id = ?').run(initialWorkId);
                    db.prepare('DELETE FROM works WHERE id = ?').run(initialWorkId);
                })();
                setTimeout(() => {
                    setIsLoading(false);
                    onSaveSuccess();
                }, 100);
            } catch (e) { setIsLoading(false); alert(e.message); }
        }, 100);
    };

    const stopProp = (e) => { e.stopPropagation(); };

    return html`
        ${showDirtyWarning && html`<${ConfirmModal} title="尚未儲存的變更" message="您有尚未儲存的變更, 確定要捨棄嗎?" confirmText="繼續編輯" cancelText="放棄變更" onConfirm=${() => setShowDirtyWarning(false)} onCancel=${onCancel} />`}
        ${isScraperOpen && html`<${ScraperModal} defaultUrl=${formData.work_number || ""} onConfirm=${handleScrapeResult} onClose=${() => setIsScraperOpen(false)} />`}
        <div className="main-layout">
            <div className="sidebar" style=${{ width: '50%' }}>
                <div className="editor-gallery ${dragOver ? 'drag-over' : ''}" onDragOver=${e => { e.preventDefault(); setDragOver(true); }} onDragLeave=${() => setDragOver(false)} onDrop=${handleDropUpload}>
                    <h3 style=${{ margin: '0 0 10px 0' }}>圖片管理 (${images.length})</h3>
                    <div className="main-preview" style=${{ flex: 3, backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '10px' }}>
                        ${images[previewIndex] ? html`<img src="${images[previewIndex].previewUrl}" style=${{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />` : html`<div style=${{ color: '#666' }}>無圖片</div>`}
                    </div>
                    <div className="thumbnail-list" style=${{ flex: 1, minHeight: '120px', gridTemplateColumns: 'repeat(auto-fill, 160px)', overflowY: 'auto' }}>
                        ${images.map((img, idx) => html`
                            <div key=${img.id} className="thumbnail-item ${idx === previewIndex ? 'active' : ''}" draggable="true" onDragStart=${() => setDraggingIndex(idx)} onDragOver=${e => e.preventDefault()} onDrop=${e => handleSortDrop(e, idx)} onClick=${() => setPreviewIndex(idx)} style=${{ height: '100px', width: '160px' }}>
                                <img src="${img.previewUrl}" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                <button className="delete-btn" onClick=${e => handleDeleteImage(idx, e)}><${Trash2} size=${16}/></button>
                            </div>
                        `)}
                        <div className="thumbnail-item add-btn" style=${{ display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px dashed #ccc', height: '100px', width: '160px', cursor: 'pointer' }} onClick=${() => fileInputRef.current.click()}>
                            <${Plus} size=${48} color="#ccc" />
                            <input ref=${fileInputRef} style=${{ display: 'none' }} type="file" accept=".jpg, .png, .mp4, .mkv, .avi, .mov, .wmv, .flv" multiple onChange=${e => processNewFiles(e.target.files)} />
                        </div>
                    </div>
                </div>
            </div>
            <div className="content-area">
                <div className="content-header">
                    <div className="result-info">${isEditMode ? '編輯作品' : '新增作品'}</div>
                    <div style=${{ display: 'flex', gap: '8px' }}>
                        <button className="btn-primary" onClick=${handleSave}><${Save} size=${16} style=${{ marginRight: 4 }} /> 儲存</button>
                        <button className="nav-btn" onClick=${attemptCancel}><${X} size=${16} style=${{ marginRight: 4 }} /> 取消</button>
                    </div>
                </div>

                <div className="editor-form">
                    <div className="filter-group">
                        <label className="filter-label">識別碼</label>
                        <div style=${{ display: 'flex', gap: '8px' }}>
                            <input className="filter-input" style=${{ flex: 1 }} value=${formData.work_number || ''} onInput=${e => handleChange('work_number', e.target.value)} onMouseDown=${stopProp} />
                            <button className="btn-primary" onClick=${() => setIsScraperOpen(true)} style=${{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: '#17a2b8' }}>
                                <${Download} size=${16} /> 自動抓取
                            </button>
                        </div>
                    </div>
                    <div className="filter-group"><label className="filter-label">作品名稱</label><input className="filter-input" value=${formData.name || ''} onInput=${e => handleChange('name', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">發行日期</label><input type="date" className="filter-input" value=${formData.release_date || ''} onInput=${e => handleChange('release_date', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">影片解析度</label><input className="filter-input" value=${formData.resolution || ''} onInput=${e => handleChange('resolution', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">影片長度</label><input className="filter-input" value=${formData.duration || ''} onInput=${e => handleChange('duration', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">實際檔案長度</label><input className="filter-input" value=${formData.file_size || ''} onInput=${e => handleChange('file_size', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">導演</label><input className="filter-input" value=${formData.director || ''} onInput=${e => handleChange('director', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">製作商</label><input className="filter-input" value=${formData.maker || ''} onInput=${e => handleChange('maker', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">發行商</label><input className="filter-input" value=${formData.publisher || ''} onInput=${e => handleChange('publisher', e.target.value)} onMouseDown=${stopProp} /></div>
                    
                    <div className="filter-group" style=${{ borderTop: '1px solid #eee', paddingTop: 20 }}>
                        <label className="filter-label">演員</label>
                        <${ActorSelector} selectedActors=${selectedActors} onChange=${setSelectedActors} inputValue=${actorInputValue} onInputChange=${setActorInputValue} />
                    </div>
                    <div className="filter-group"><label className="filter-label">評分 (最高5分)</label><input type="number" step="0.1" className="filter-input" value=${formData.rating || ''} onInput=${e => handleChange('rating', e.target.value)} onMouseDown=${stopProp} placeholder="請輸入評分 (例如 4.5)" /></div>
                    
                    <div className="filter-group" style=${{ padding: '8px 0', marginBottom: '8px' }}>
                        <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer', margin: 0 }}>
                            <input type="checkbox" checked=${!!formData.is_watchlist} onChange=${e => handleChange('is_watchlist', e.target.checked ? 1 : 0)} style=${{ marginRight: 8 }} />
                            待看關注
                        </label>
                    </div>

                    <div className="filter-group" style=${{ borderTop: '1px solid #eee', paddingTop: 20 }}>
                        <${TagSelector} selectedTags=${selectedTags} onChange=${setSelectedTags} />
                    </div>

                    ${isEditMode && html`
                        <div style=${{ marginTop: 40, borderTop: '1px solid #eee', paddingTop: 20 }}>
                            <button className="btn-block" onClick=${handleDeleteWork} style=${{ color: '#dc3545', fontWeight: 'bold' }}><${Trash2} size=${16} style=${{ marginRight: 6 }}/> 永久刪除此作品</button>
                        </div>
                    `}
                </div>
            </div>
        </div>`;
}

function WorkCard({ work, onClick }) {
    let coverUrl = work.cover_image ? getFileUrl(path.join(worksImgDir, work.cover_image)) : null;
    const [imageError, setImageError] = React.useState(false);

    React.useEffect(() => { setImageError(false); }, [work.id, work.cover_image]);

    return html`
        <div className="work-card" onClick=${() => onClick(work.id)}>
            <div className="card-cover">
                ${coverUrl && !imageError ?
                    html`<img src="${coverUrl}" onError=${() => setImageError(true)} />` :
                    (imageError ?
                        html`<div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#e6a700', textAlign: 'center', height: '100%' }}><${AlertTriangle} size=${48} /><span style=${{ fontWeight: 'bold' }}>ERROR</span></div>` :
                        html`<${Film} size=${48} />`
                    )
                }
            </div>
            <div className="card-info">
                <div style=${{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginBottom: '4px', height: '56px', overflow: 'hidden' }}>
                    <div style=${{ display: 'flex', flexDirection: 'column' }}>
                        <div className="card-id" style=${{ flexShrink: 0, marginTop: '4px' }}>${work.work_number || '[NO ID]'}</div>
                        <div style=${{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                            ${work.has_favorite_actor ? html`<${Star} size=${14} color="#fbc02d" fill="#fbc02d" title="包含關注演員" />` : null}
                            ${work.is_watchlist ? html`<${Bookmark} size=${14} color="#e91e63" fill="#e91e63" title="待看關注" />` : null}
                        </div>
                    </div>
                    <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'flex-end', alignContent: 'flex-start' }}>
                        ${work.tags && work.tags.map(t => html`
                            <span style=${{ fontSize: '12px', padding: '2px 6px', borderRadius: '4px', backgroundColor: t.color || '#eee', color: t.color ? '#fff' : '#333', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', height: '26px' }}>
                                ${t.name}
                            </span>
                        `)}
                    </div>
                </div>
                <div className="card-title" title=${work.name}>${work.name || '[未命名]'}</div>
                ${work.rating !== null && work.rating !== undefined && html`
                    <div className="card-rating" style=${{ fontSize: '14px', fontWeight: 'bold', color: '#fbc02d', marginTop: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <${Star} size=${14} fill="#fbc02d" />
                        <span style=${{ fontWeight: 'bold', paddingTop: '2px' }}>${work.rating}</span>
                    </div>
                `}
            </div>
        </div>`;
}

module.exports = {
    TagFilterSidebar,
    ActorFilter,
    WorkSidebar,
    ActorSelector,
    TagSelector,
    WorkDetails,
    WorkEditor,
    WorkCard
};