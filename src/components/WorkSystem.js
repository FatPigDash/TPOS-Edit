const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const path = require('path');
const fs = require('fs');
const { webUtils, ipcRenderer } = require('electron');
const {
    Search, ChevronDown, ChevronRight: ChevronRightIcon, ChevronLeft: ChevronLeftIcon, X,
    Star, ArrowLeft, Edit, Film, AlertTriangle, Check,
    Save, Plus, Trash2, Download, PanelLeft, Bookmark, Play, FolderInput, Folder
} = require('lucide-react');

const { db, worksImgDir, actorsImgDir } = require('../utils/db');
const {
    getFileUrl, parseSearchQuery, stopPropagation, getNewActorNumber, getOrCreateActorId, getContrastYIQ
} = require('../utils/helpers');
const {
    ConfirmModal, ImageViewerModal, SearchHelpText, CodeSearchHelpText
} = require('./Shared');
const { ScraperModal } = require('./Scraper');

// 自動資料庫結構升級: 確保 works 表有 notes 欄位
let migrationDone = false;
const ensureNotesColumn = () => {
    if (!db || migrationDone) return;
    try {
        const columns = db.prepare('PRAGMA table_info(works)').all();
        if (!columns.some(c => c.name === 'notes')) {
            db.prepare('ALTER TABLE works ADD COLUMN notes TEXT DEFAULT ""').run();
        }
        migrationDone = true;
    } catch (e) {
        console.error("Migration error:", e);
    }
};

// 5. 篩選與選擇元件 (Filter & Selector)

function TagFilterSidebar({ selectedTagIds, onChange }) {
    const [groups, setGroups] = React.useState([]);
    const [expandedGroups, setExpandedGroups] = React.useState({});

    const loadTags = React.useCallback(() => {
        if (!db) return;
        try {
            const g = db.prepare('SELECT * FROM tag_groups ORDER BY sort_order ASC').all();
            const t = db.prepare(`
                SELECT tags.*, (SELECT COUNT(*) FROM work_tag_link wtl WHERE wtl.tag_id = tags.id) as usage_count
                FROM tags WHERE is_visible = 1 ORDER BY sort_order ASC
            `).all();
            setGroups(g.map(grp => ({ ...grp, tags: t.filter(tag => tag.group_id === grp.id) })));
        } catch (e) { console.error(e); }
    }, []);

    React.useEffect(() => {
        loadTags();
        // 分頁切換僅以 CSS 顯示/隱藏, 元件不會卸載, 故需監聽標籤系統的變更事件才能即時同步
        window.addEventListener('tags-changed', loadTags);
        return () => window.removeEventListener('tags-changed', loadTags);
    }, [loadTags]);

    const toggleGroup = (groupId) => { setExpandedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] })); };

    // 三態切換: 未選 -> 包含(include) -> 排除(exclude) -> 未選
    const toggleTag = (tagId) => {
        const existing = selectedTagIds.find(t => t.id === tagId);
        if (!existing) {
            // 未選 -> 包含
            onChange([...selectedTagIds, { id: tagId, mode: 'include' }]);
        } else if (existing.mode === 'include') {
            // 包含 -> 排除
            onChange(selectedTagIds.map(t => t.id === tagId ? { id: tagId, mode: 'exclude' } : t));
        } else {
            // 排除 -> 未選
            onChange(selectedTagIds.filter(t => t.id !== tagId));
        }
    };

    // 自訂三態核取方塊元件
    const TriStateCheckbox = ({ tagId }) => {
        const entry = selectedTagIds.find(t => t.id === tagId);
        const mode = entry ? entry.mode : 'none';

        const boxStyle = {
            width: '16px', height: '16px', minWidth: '16px',
            border: '2px solid',
            borderColor: mode === 'include' ? '#2196F3' : (mode === 'exclude' ? '#e53935' : '#bbb'),
            borderRadius: '3px',
            backgroundColor: mode === 'include' ? '#2196F3' : (mode === 'exclude' ? '#e53935' : 'white'),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', marginRight: '6px', flexShrink: 0,
            fontSize: '11px', fontWeight: 'bold', color: 'white', lineHeight: 1,
            userSelect: 'none'
        };

        const symbol = mode === 'include' ? '✓' : (mode === 'exclude' ? '−' : '');
        return html`<div style=${boxStyle} onClick=${(e) => { e.preventDefault(); toggleTag(tagId); }}>${symbol}</div>`;
    };

    return html`
        <div className="tag-filter-sidebar" style=${{ borderTop: '1px solid #eee', paddingTop: '16px' }}>
            <div style=${{ fontWeight: 'bold', marginBottom: '8px', color: '#666' }}>標籤篩選</div>
            ${groups.map(group => {
        const includeCount = group.tags.filter(t => selectedTagIds.find(s => s.id === t.id && s.mode === 'include')).length;
        const excludeCount = group.tags.filter(t => selectedTagIds.find(s => s.id === t.id && s.mode === 'exclude')).length;
        const isExpanded = expandedGroups[group.id];
        const groupStyle = group.color ? { borderLeft: `4px solid ${group.color}` } : {};

        return html`
                <div key=${group.id} style=${{ marginBottom: '4px' }}>
                    <div onClick=${() => toggleGroup(group.id)} style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '6px', backgroundColor: '#f9f9f9', borderRadius: '4px', fontSize: '14px', ...groupStyle }}>
                        ${isExpanded ? html`<${ChevronDown} size=${14} />` : html`<${ChevronRightIcon} size=${14} />`}
                        <span style=${{ marginLeft: '4px', flex: 1 }}>${group.name}</span>
                        ${includeCount > 0 && html`<span style=${{ backgroundColor: '#2196F3', color: 'white', borderRadius: '10px', padding: '2px 6px', fontSize: '10px', marginLeft: '4px' }}>${includeCount}</span>`}
                        ${excludeCount > 0 && html`<span style=${{ backgroundColor: '#e53935', color: 'white', borderRadius: '10px', padding: '2px 6px', fontSize: '10px', marginLeft: '2px' }}>${excludeCount}</span>`}
                    </div>
                    ${isExpanded && html`
                        <div style=${{ paddingLeft: '20px', paddingBottom: '8px' }}>
                            ${group.tags.map(tag => {
            const entry = selectedTagIds.find(s => s.id === tag.id);
            const mode = entry ? entry.mode : 'none';
            const textStyle = mode === 'include' ? { color: '#2196F3', fontWeight: 'bold' } :
                (mode === 'exclude' ? { color: '#e53935', fontWeight: 'bold', textDecoration: 'line-through' } : {});
            return html`
                                <label key=${tag.id} style=${{ display: 'flex', alignItems: 'center', padding: '4px 0', cursor: 'pointer', fontSize: '13px' }} onClick=${(e) => { e.preventDefault(); toggleTag(tag.id); }}>
                                    <${TriStateCheckbox} tagId=${tag.id} />
                                    <span style=${textStyle}>${tag.name} (${tag.usage_count || 0})</span>
                                </label>`;
        })}
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
    const [showAdvanced, setShowAdvanced] = React.useState(false);

    return html`
        <div className="sidebar" style=${{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
            <div style=${{ position: 'sticky', top: 0, zIndex: 10, backgroundColor: 'white', borderBottom: '1px solid #e0e0e0', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                <h3 style=${{ margin: 0, flex: 1, fontSize: '15px' }}>作品篩選</h3>
                <button className="btn-block" style=${{ padding: '4px 10px', fontSize: '12px' }} onClick=${onApply}>套用篩選</button>
                <button className="btn-block" style=${{ padding: '4px 10px', fontSize: '12px' }} onClick=${onClear}>清除篩選</button>
            </div>

            <div style=${{ overflowY: 'auto', padding: '16px', flex: 1 }}>
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
                    <${CodeSearchHelpText} />
                </div>

                <div className="filter-group">
                    <${ActorFilter} value=${actorFilterValue} onChange=${newValue => setUiFilters({ ...uiFilters, actor: newValue })} />
                </div>

                <div className="filter-group">
                    <div style=${{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                        <label className="filter-label" style=${{ marginBottom: 0, flex: 1 }}>評分 (最高5分)</label>
                        <div style=${{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #ddd', fontSize: 12 }}>
                            <button
                                onClick=${() => setUiFilters({ ...uiFilters, ratingMode: 'gte' })}
                                style=${{ padding: '2px 8px', border: 'none', cursor: 'pointer', backgroundColor: (uiFilters.ratingMode !== 'eq') ? '#2196F3' : '#f5f5f5', color: (uiFilters.ratingMode !== 'eq') ? 'white' : '#555', fontWeight: (uiFilters.ratingMode !== 'eq') ? 'bold' : 'normal', transition: 'background 0.15s' }}
                                title="大於或等於">≥</button>
                            <button
                                onClick=${() => setUiFilters({ ...uiFilters, ratingMode: 'eq' })}
                                style=${{ padding: '2px 8px', border: 'none', borderLeft: '1px solid #ddd', cursor: 'pointer', backgroundColor: (uiFilters.ratingMode === 'eq') ? '#2196F3' : '#f5f5f5', color: (uiFilters.ratingMode === 'eq') ? 'white' : '#555', fontWeight: (uiFilters.ratingMode === 'eq') ? 'bold' : 'normal', transition: 'background 0.15s' }}
                                title="等於">=</button>
                        </div>
                    </div>
                    <input type="number" step="0.1" className="filter-input" value=${uiFilters.rating} onInput=${e => setUiFilters({ ...uiFilters, rating: e.target.value })} placeholder="例如: 4.0" />
                </div>

                <div className="filter-group" style=${{ padding: 0 }}>
                    <div
                        onClick=${() => setShowAdvanced(v => !v)}
                        style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '6px 0', userSelect: 'none', color: '#555' }}>
                        ${showAdvanced ? html`<${ChevronDown} size=${15} />` : html`<${ChevronRightIcon} size=${15} />`}
                        <span style=${{ marginLeft: 4, fontSize: '13px', fontWeight: 'bold' }}>進階搜尋</span>
                        ${(uiFilters.director || uiFilters.maker || uiFilters.publisher) && html`<span style=${{ marginLeft: 6, width: 7, height: 7, borderRadius: '50%', backgroundColor: '#2196F3', display: 'inline-block' }} title="已有進階篩選條件" />`}
                    </div>
                    ${showAdvanced && html`
                        <div style=${{ paddingLeft: 4 }}>
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
                        </div>
                    `}
                </div>

                <div className="filter-group">
                    <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked=${uiFilters.hasFavActor || false} onChange=${e => setUiFilters({ ...uiFilters, hasFavActor: e.target.checked })} style=${{ marginRight: 8 }} />
                        關注演員
                    </label>
                </div>

                <div className="filter-group">
                    <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked=${uiFilters.isWatchLater || false} onChange=${e => setUiFilters({ ...uiFilters, isWatchLater: e.target.checked })} style=${{ marginRight: 8 }} />
                        待看關注
                    </label>
                </div>

                <${TagFilterSidebar} selectedTagIds=${uiFilters.tags} onChange=${newTags => setUiFilters({ ...uiFilters, tags: newTags })} />
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
            <div className="tag-rows">
            ${groups.map(group => html`
                <div className="tag-row" key=${group.id}>
                    <div className="tag-row-name" style=${group.color ? { backgroundColor: group.color, color: getContrastYIQ(group.color) } : {}}>${group.name}</div>
                    <div className="tag-row-tags">
                        ${group.tags.map(tag => {
        const isSelected = selectedTags.some(t => t.id === tag.id);
        const style = tag.color ? { backgroundColor: tag.color, color: getContrastYIQ(tag.color), borderColor: tag.color } : {};
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
            </div>
        </div>`;
}

// 8. 作品系統元件 (Work System)

// 時間字串解析 (支援 HH:MM:SS、MM:SS 格式，以及純數字視為分鐘；回傳秒數，無法解析回傳 null)
function parseTimeToSeconds(timeStr) {
    if (!timeStr && timeStr !== 0) return null;
    const s = String(timeStr).trim();
    if (!s) return null;
    // HH:MM:SS 或 MM:SS 格式
    if (s.includes(':')) {
        const parts = s.split(':').map(p => parseFloat(p));
        if (parts.some(isNaN)) return null;
        if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
        if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
    }
    // 純數字: 視為分鐘
    const num = parseFloat(s);
    if (!isNaN(num)) return Math.round(num * 60);
    return null;
}

// 影片播放共用邏輯: 依識別碼於根目錄比對影片並以 PotPlayer 播放
// 多筆且無法唯一判定時, 將候選清單放入 videoCandidates 供 UI 顯示選擇
function useVideoPlayer() {
    const [isPlaying, setIsPlaying] = React.useState(false);
    const [videoCandidates, setVideoCandidates] = React.useState(null);

    // 以 PotPlayer 播放指定路徑 (可傳單一路徑或路徑陣列; 多段時依序播放)
    const playPath = async (absPathOrList) => {
        try {
            const r = await ipcRenderer.invoke('play-video', absPathOrList);
            if (!r || !r.ok) {
                if (r && r.reason === 'notfound') {
                    alert('找不到 PotPlayer。\n請確認已安裝 PotPlayer，或於軟體根目錄的 app.config.json 設定 "potplayerPath" 指向 PotPlayer 執行檔。');
                } else {
                    alert('播放失敗: ' + ((r && r.message) || '未知錯誤'));
                }
                return;
            }
            setVideoCandidates(null);
        } catch (e) {
            alert('播放失敗: ' + e.message);
        }
    };

    // 依識別碼比對根目錄影片: 單一版本 (含多段) 直接依序播放, 多版本則交由 UI 選擇
    const findAndPlay = async (workNumber, name) => {
        if (!workNumber) {
            alert('此作品沒有識別碼，無法比對影片。');
            return;
        }
        setIsPlaying(true);
        try {
            const res = await ipcRenderer.invoke('find-work-videos', { workNumber, name });
            const groups = (res && res.groups) || [];
            if (groups.length === 0) {
                alert(`在軟體根目錄內找不到識別碼為「${workNumber}」的影片檔。`);
                return;
            }
            if (groups.length === 1) {
                // 只有一個版本 (可能為多段) → 把所有分段丟給 PotPlayer 依序播放
                await playPath(groups[0].paths);
                return;
            }
            // 多個版本 → 交由 UI 選擇, 每個項目播放該版本的全部分段
            setVideoCandidates(groups);
        } catch (e) {
            alert('搜尋影片失敗: ' + e.message);
        } finally {
            setIsPlaying(false);
        }
    };

    return { isPlaying, videoCandidates, setVideoCandidates, playPath, findAndPlay };
}

function WorkDetails({ workId, onEdit, uiFilters, setUiFilters, onApply, onClear, canGoBack, onGoBack, onNavigateToActor }) {
    const [work, setWork] = React.useState(null);
    const [images, setImages] = React.useState([]);
    const [previewIndex, setPreviewIndex] = React.useState(0);
    const [viewingImage, setViewingImage] = React.useState(null);
    const [linkedActors, setLinkedActors] = React.useState([]);
    const [linkedTags, setLinkedTags] = React.useState([]);
    const [isFilterSidebarOpen, setIsFilterSidebarOpen] = React.useState(false);
    const { isPlaying, videoCandidates, setVideoCandidates, playPath, findAndPlay } = useVideoPlayer();

    React.useEffect(() => {
        ensureNotesColumn(); // 確保資料庫有 notes 欄位
        if (!db) return;
        try {
            setWork(db.prepare('SELECT * FROM works WHERE id=?').get(workId));

            const loadedImages = db.prepare('SELECT * FROM work_images WHERE work_id = ? ORDER BY sort_order ASC').all(workId).map(row => ({
                id: row.id,
                url: getFileUrl(path.join(worksImgDir, row.file_name)),
                isCover: row.is_cover === 1
            }));

            setImages(loadedImages);

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

    const handlePrevImage = (e) => {
        stopPropagation(e);
        if (images.length <= 1) return;
        setPreviewIndex(prev => (prev === 0 ? images.length - 1 : prev - 1));
    };

    const handleNextImage = (e) => {
        stopPropagation(e);
        if (images.length <= 1) return;
        setPreviewIndex(prev => (prev === images.length - 1 ? 0 : prev + 1));
    };

    const handleMiddleClickActor = (e, actor) => {
        if (e.button === 1) {
            e.preventDefault();
            if (!actor.actor_id) return;

            const currentActors = uiFilters.actor?.items || [];
            if (!currentActors.find(a => a.id === actor.actor_id)) {
                setUiFilters({
                    ...uiFilters,
                    actor: {
                        ...uiFilters.actor,
                        items: [...currentActors, { id: actor.actor_id, name: actor.name }]
                    }
                });
            }
            setIsFilterSidebarOpen(true);
        }
    };

    const handleMiddleClickTag = (e, tagId) => {
        if (e.button === 1) {
            e.preventDefault();
            const currentTags = uiFilters.tags || [];
            if (!currentTags.find(t => t.id === tagId)) {
                setUiFilters({
                    ...uiFilters,
                    tags: [...currentTags, { id: tagId, mode: 'include' }]
                });
            }
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
                <div className="main-preview" style=${{ flex: 3, backgroundColor: '#000', marginBottom: '10px', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    ${images[previewIndex] ? html`
                        <img src="${images[previewIndex].url}" style=${{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'zoom-in' }} onClick=${() => setViewingImage(images[previewIndex].url)} />
                        ${images.length > 1 && html`
                            <div className="preview-nav-btn prev" onClick=${handlePrevImage} style=${{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', backgroundColor: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', padding: '8px', cursor: 'pointer' }}>
                                <${ChevronLeftIcon} size=${24} />
                            </div>
                            <div className="preview-nav-btn next" onClick=${handleNextImage} style=${{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', backgroundColor: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', padding: '8px', cursor: 'pointer' }}>
                                <${ChevronRightIcon} size=${24} />
                            </div>
                        `}
                    ` : html`<div style=${{ color: '#666' }}>無圖片</div>`}
                </div>
                <div className="thumbnail-list" style=${{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                    ${images.map((img, idx) => html`<div className="thumbnail-item ${idx === previewIndex ? 'active' : ''}" style=${{ width: 160, height: 100, flexShrink: 0 }} onClick=${() => setPreviewIndex(idx)}><img src="${img.url}" /></div>`)}
                </div>
            </div>

            <div className="content-area">
                <div className="content-header" style=${{ position: 'sticky', top: 0, backgroundColor: '#fff', zIndex: 2 }}>
                    ${canGoBack && html`
                        <button className="btn-ghost" onClick=${onGoBack} title="返回上一頁" style=${{ marginRight: '8px', padding: '4px', display: 'flex', alignItems: 'center' }}>
                            <${ArrowLeft} size=${20} />
                        </button>
                    `}
                    <div className="result-info" style=${{ flex: 1 }}>作品詳情</div>
                    <button className="btn-primary" onClick=${() => findAndPlay(work.work_number, work.name)} disabled=${isPlaying} style=${{ marginRight: 8, backgroundColor: '#28a745', borderColor: '#28a745', opacity: isPlaying ? 0.6 : 1 }} title="以 PotPlayer 播放此作品影片">
                        <${Play} size=${16} style=${{ marginRight: 6 }} /> ${isPlaying ? '搜尋中...' : '播放影片'}
                    </button>
                    <button className="btn-primary" onClick=${() => onEdit(workId)}><${Edit} size=${16} style=${{ marginRight: 6 }} /> 編輯作品</button>
                </div>

                <div style=${{ maxWidth: '800px' }}>
                    <div className="filter-group"><label className="filter-label">識別碼</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.work_number}</div></div>
                    <div className="filter-group"><label className="filter-label">作品名稱</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.name}</div></div>
                    <div className="filter-group"><label className="filter-label">發行日期</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.release_date || '未設定'}</div></div>
                    <div className="filter-group"><label className="filter-label">影片解析度</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.resolution || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">影片長度</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.duration || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">實際檔案長度</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: '10px' }}>${work.file_size || ''}${(() => { const dSec = parseTimeToSeconds(work.duration); const fSec = parseTimeToSeconds(work.file_size); return (dSec !== null && fSec !== null && (dSec - fSec) >= 900) ? html`<span style=${{ color: '#dc3545', fontWeight: 'bold', fontSize: '13px' }}>⚠ 影片長度不足</span>` : null; })()}</div></div>
                    <div className="filter-group"><label className="filter-label">導演</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.director || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">製作商</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.maker || ''}</div></div>
                    <div className="filter-group"><label className="filter-label">發行商</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee' }}>${work.publisher || ''}</div></div>
                    
                    <div className="filter-group">
                        <label className="filter-label">演員</label>
                        <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '8px 0' }}>
                            ${linkedActors.map(actor => {
        const isRealActor = !!actor.actor_id;
        const isMissingImage = isRealActor && !actor.image_path;

        return html`<span
                                    style=${{
                padding: '4px 8px',
                borderRadius: '4px',
                backgroundColor: '#e3f2fd',
                color: isRealActor ? '#2196F3' : '#333',
                cursor: isRealActor ? 'pointer' : 'default',
                textDecoration: isRealActor ? 'underline' : 'none',
                fontWeight: isRealActor ? 'bold' : 'normal',
                display: 'inline-flex',
                alignItems: 'center'
            }}
                                    onClick=${() => isRealActor && onNavigateToActor && onNavigateToActor(actor.actor_id)}
                                    onMouseDown=${(e) => handleMiddleClickActor(e, actor)}
                                    title=${isRealActor ? `${actor.actor_number} ${isMissingImage ? '(無圖片) ' : ''}(中鍵點擊加入篩選)` : '純文字標籤'}>
                                    ${actor.name}
                                </span>`;
    })}
                            ${linkedActors.length === 0 && html`<span style=${{ color: '#999' }}>無關聯演員</span>`}
                        </div>
                    </div>

                    <div className="filter-group"><label className="filter-label">評分</label><div style=${{ display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 0', fontSize: '18px', fontWeight: 'bold', color: '#fbc02d' }}><${Star} size=${20} fill="#fbc02d" /> ${work.rating !== null && work.rating !== undefined ? work.rating : '尚未評分'}</div></div>

                    <div className="filter-group"><label className="filter-label">待看關注</label><div style=${{ padding: '8px 0', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: '4px' }}>${work.is_favorite ? html`<${Bookmark} size=${20} color="#e91e63" fill="#e91e63" /> <span style=${{ color: '#e91e63', fontWeight: 'bold' }}>已標記</span>` : html`<span style=${{ color: '#999' }}>未標記</span>`}</div></div>

                    <div className="filter-group">
                        <label className="filter-label">標籤</label>
                        <div style=${{ padding: '8px 0' }}>
                            ${groups.length === 0
                ? html`<span style=${{ color: '#999' }}>無標籤</span>`
                : html`<div className="tag-rows">
                                ${groups.map(group => html`
                                    <div className="tag-row" key=${group.name}>
                                        <div className="tag-row-name" style=${group.color ? { backgroundColor: group.color, color: getContrastYIQ(group.color) } : {}}>${group.name}</div>
                                        <div className="tag-row-tags">
                                            ${group.tags.map(tag => html`<span
                                                className="tag-chip"
                                                key=${tag.id}
                                                style=${tag.color ? { backgroundColor: tag.color, color: getContrastYIQ(tag.color), borderColor: tag.color } : {}}
                                                onMouseDown=${(e) => handleMiddleClickTag(e, tag.id)}
                                                title="中鍵點擊加入篩選">
                                                ${tag.name}
                                            </span>`)}
                                        </div>
                                    </div>
                                `)}
                            </div>`}
                        </div>
                    </div>

                    <div className="filter-group">
                        <label className="filter-label">註解</label>
                        <div style=${{ padding: '8px 0', borderBottom: '1px solid #eee', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.6' }}>
                            ${work.notes || html`<span style=${{ color: '#999' }}>無</span>`}
                        </div>
                    </div>
                </div>
            </div>
            ${viewingImage && html`<${ImageViewerModal} src=${viewingImage} onClose=${() => setViewingImage(null)} />`}
            ${videoCandidates && html`
                <div style=${{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }} onClick=${() => setVideoCandidates(null)}>
                    <div style=${{ backgroundColor: 'white', borderRadius: '8px', padding: '20px', width: '600px', maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick=${e => e.stopPropagation()}>
                        <div style=${{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
                            <h3 style=${{ margin: 0, flex: 1 }}>找到多個符合「${work.work_number}」的版本，請選擇要播放的版本</h3>
                            <button className="btn-ghost" onClick=${() => setVideoCandidates(null)}><${X} size=${20} /></button>
                        </div>
                        <div style=${{ overflowY: 'auto', flex: 1 }}>
                            ${videoCandidates.map((g, idx) => html`
                                <div key=${idx} onClick=${() => playPath(g.paths)}
                                    style=${{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 8px', borderBottom: '1px solid #eee', cursor: 'pointer' }}
                                    title=${g.files.map(f => f.absolutePath).join('\n')}>
                                    <${Play} size=${16} color="#28a745" style=${{ flexShrink: 0 }} />
                                    <div style=${{ minWidth: 0 }}>
                                        <div style=${{ fontWeight: 'bold', wordBreak: 'break-all' }}>${g.files[0].fileName}${g.isMultiPart ? html` <span style=${{ color: '#2196F3', fontWeight: 'normal', fontSize: '13px' }}>(共 ${g.files.length} 段, 依序播放)</span>` : ''}</div>
                                        <div style=${{ fontSize: '12px', color: '#888', wordBreak: 'break-all' }}>${g.files[0].relativePath}</div>
                                    </div>
                                </div>
                            `)}
                        </div>
                    </div>
                </div>
            `}
        </div>`;
}

function WorkEditor({ initialWorkId, onCancel, onSaveSuccess, setIsLoading }) {
    const isEditMode = !!initialWorkId;
    const [formData, setFormData] = React.useState({ work_number: '', name: '', release_date: '', resolution: '', duration: '', file_size: '', director: '', maker: '', publisher: '', rating: '', is_favorite: 0, notes: '' });
    const [images, setImages] = React.useState([]);
    const [deletedImageIds, setDeletedImageIds] = React.useState([]);
    const [selectedImageIds, setSelectedImageIds] = React.useState([]);
    const [previewIndex, setPreviewIndex] = React.useState(0);
    const [dragOver, setDragOver] = React.useState(false);
    const [draggingIndex, setDraggingIndex] = React.useState(null);
    const fileInputRef = React.useRef(null);
    const [selectedActors, setSelectedActors] = React.useState([]);
    const [selectedTags, setSelectedTags] = React.useState([]);
    const [actorInputValue, setActorInputValue] = React.useState("");
    const [initialState, setInitialState] = React.useState(null);
    const [showDirtyWarning, setShowDirtyWarning] = React.useState(false);
    const [isScraperOpen, setIsScraperOpen] = React.useState(false);
    const { isPlaying, videoCandidates, setVideoCandidates, playPath, findAndPlay } = useVideoPlayer();
    // 移動實體檔案: moveState 為 null 或 { root, files: [{ absolutePath, relativePath, fileName, checked }] }
    const [moveState, setMoveState] = React.useState(null);
    const [isMoving, setIsMoving] = React.useState(false);

    // 開啟「移動檔案」視窗: 依識別碼比對根目錄影片, 列出可移動的檔案供勾選
    const openMoveFiles = async () => {
        if (!formData.work_number) { alert('此作品沒有識別碼，無法比對影片。'); return; }
        setIsMoving(true);
        try {
            const res = await ipcRenderer.invoke('find-work-videos', { workNumber: formData.work_number, name: formData.name });
            const candidates = (res && res.candidates) || [];
            if (candidates.length === 0) {
                alert(`在軟體根目錄內找不到識別碼為「${formData.work_number}」的影片檔。`);
                return;
            }
            setMoveState({
                root: res.root,
                files: candidates.map(c => ({ absolutePath: c.absolutePath, relativePath: c.relativePath, fileName: c.fileName, checked: true }))
            });
        } catch (e) {
            alert('搜尋影片失敗: ' + e.message);
        } finally {
            setIsMoving(false);
        }
    };

    // 選擇目的資料夾 (限根目錄範圍內) 並執行移動
    const handleConfirmMove = async () => {
        if (!moveState) return;
        const selected = moveState.files.filter(f => f.checked);
        if (selected.length === 0) { alert('請至少選擇一個檔案'); return; }

        const { dialog } = require('@electron/remote');
        const result = await dialog.showOpenDialog({
            title: '選擇移動目的地 (需在軟體根目錄範圍內)',
            defaultPath: moveState.root,
            properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || !result.filePaths || !result.filePaths[0]) return;

        const r = await ipcRenderer.invoke('move-work-files', {
            paths: selected.map(f => f.absolutePath),
            targetDir: result.filePaths[0]
        });

        if (!r || (r.message && (!r.moved || r.moved.length === 0))) {
            alert('移動失敗: ' + ((r && r.message) || '未知錯誤'));
            return;
        }

        const movedCount = (r.moved || []).length;
        const skippedCount = (r.skipped || []).length;
        const errs = r.errors || [];
        let msg = `已移動 ${movedCount} 個檔案到:\n${r.targetDir}`;
        if (skippedCount > 0) msg += `\n(${skippedCount} 個檔案原本就在目的資料夾, 已略過)`;
        if (errs.length > 0) msg += `\n\n下列檔案移動失敗:\n` + errs.map(e => `・${e.file}: ${e.message}`).join('\n');
        alert(msg);
        setMoveState(null);
    };

    React.useEffect(() => {
        ensureNotesColumn(); // 確保資料庫有 notes 欄位
        if (!db) return;
        if (isEditMode) {
            try {
                const work = db.prepare('SELECT * FROM works WHERE id=?').get(initialWorkId);
                if (work) setFormData({ ...work, rating: work.rating != null ? String(work.rating) : '', is_favorite: work.is_favorite || 0, notes: work.notes || '' });

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

                setInitialState({ formData: { ...work, rating: work.rating !== null ? String(work.rating) : '', is_favorite: work.is_favorite || 0, notes: work.notes || '' }, images: JSON.stringify(loadedImages.map(i => i.dbId || i.filePath)), actors: JSON.stringify(linkedA), tags: JSON.stringify(linkedT) });
            } catch (err) { }
        } else {
            setInitialState({ formData: { work_number: '', name: '', release_date: '', resolution: '', duration: '', file_size: '', director: '', maker: '', publisher: '', rating: '', is_favorite: 0, notes: '' }, images: '[]', actors: '[]', tags: '[]' });
        }
    }, [initialWorkId]);

    const handlePrevImage = (e) => {
        stopPropagation(e);
        if (images.length <= 1) return;
        setPreviewIndex(prev => (prev === 0 ? images.length - 1 : prev - 1));
    };

    const handleNextImage = (e) => {
        stopPropagation(e);
        if (images.length <= 1) return;
        setPreviewIndex(prev => (prev === images.length - 1 ? 0 : prev + 1));
    };

    const handleChange = (field, value) => setFormData(prev => ({ ...prev, [field]: value }));

    const processNewFiles = async (fileList) => {
        const files = Array.from(fileList);
        const newImages = [];
        let hasUnsupported = false;
        // 本批次影片的長度加總 (支援一次拖入多段影片), 解析度取批次中最後一段
        let batchDuration = 0;
        let batchResolution = '';
        let batchHasVideo = false;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            let realPath = file.path;
            if (!realPath) try { realPath = webUtils.getPathForFile(file); } catch (err) { }
            if (!realPath) continue;

            const ext = path.extname(realPath).toLowerCase();
            const isVideo = file.type.startsWith('video/') || ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv'].includes(ext);

            if (isVideo) {
                setIsLoading(true);
                try {
                    const metadata = await ipcRenderer.invoke('get-video-metadata', realPath);
                    batchHasVideo = true;
                    if (metadata) {
                        if (metadata.resolution) batchResolution = metadata.resolution;
                        if (metadata.duration != null) batchDuration += Number(metadata.duration) || 0;
                    }
                } catch (err) {
                    console.error("Video metadata error:", err);
                    alert("無法讀取影片資訊: " + err.message);
                } finally {
                    setIsLoading(false);
                }
            } else if (['image/jpeg', 'image/png'].includes(file.type) || ['.jpg', '.jpeg', '.png'].includes(ext)) {
                newImages.push({
                    id: Date.now() + Math.random() + i,
                    previewUrl: URL.createObjectURL(file),
                    filePath: realPath,
                    isStored: false
                });
            } else {
                hasUnsupported = true;
            }
        }

        if (batchHasVideo) {
            setFormData(prev => ({
                ...prev,
                resolution: batchResolution || prev.resolution,
                file_size: String(batchDuration)
            }));
        }

        if (hasUnsupported) {
            alert('上傳失敗：圖片格式不支援');
        }

        if (newImages.length > 0) setImages(prev => [...prev, ...newImages]);
    };

    const handleDropUpload = (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); if (e.dataTransfer.files.length > 0) processNewFiles(e.dataTransfer.files); };
    const handleSortDrop = (e, targetIndex) => {
        e.preventDefault();
        e.stopPropagation();
        if (draggingIndex === null || draggingIndex === targetIndex) return;
        setImages(prev => { const newList = [...prev]; const [moved] = newList.splice(draggingIndex, 1); newList.splice(targetIndex, 0, moved); return newList; });
        setDraggingIndex(null);
    };

    const handleDeleteImage = (index, e) => {
        e.stopPropagation();
        if (!confirm('移除此圖片?')) return;
        const img = images[index];
        if (img.isStored) setDeletedImageIds(p => [...p, img.dbId]);
        setImages(p => p.filter((_, i) => i !== index));
        setSelectedImageIds(p => p.filter(id => id !== img.id));
    };

    const handleDeleteSelected = (e) => {
        e.stopPropagation();
        if (selectedImageIds.length === 0) return;
        if (!confirm(`確定移除選取的 ${selectedImageIds.length} 張圖片?`)) return;

        const imagesToDelete = images.filter(img => selectedImageIds.includes(img.id));
        const storedIdsToDelete = imagesToDelete.filter(img => img.isStored).map(img => img.dbId);

        if (storedIdsToDelete.length > 0) {
            setDeletedImageIds(p => [...p, ...storedIdsToDelete]);
        }

        setImages(p => p.filter(img => !selectedImageIds.includes(img.id)));
        setSelectedImageIds([]);
        setPreviewIndex(0);
    };

    const isDirty = () => {
        if (!initialState) return false;
        return JSON.stringify(formData) !== JSON.stringify(initialState.formData) || JSON.stringify(selectedActors) !== initialState.actors || JSON.stringify(selectedTags) !== initialState.tags || JSON.stringify(images.map(i => i.dbId || i.filePath)) !== initialState.images;
    };

    const attemptCancel = () => { if (isDirty()) setShowDirtyWarning(true); else onCancel(); };

    const handleScrapeResult = (newData) => {
        setFormData(prev => ({
            ...prev,
            name: newData.name || prev.name || '',
            release_date: newData.release_date || prev.release_date || '',
            duration: newData.duration || prev.duration || '',
            director: newData.director || prev.director || '',
            maker: newData.maker || prev.maker || '',
            publisher: newData.publisher || prev.publisher || ''
        }));

        if (newData.actors && Array.isArray(newData.actors)) {
            let currentSelectedActors = [...selectedActors];
            try {
                db.transaction(() => {
                    newData.actors.forEach(actorName => {
                        const trimmedName = actorName.trim();
                        if (!trimmedName) return;

                        const actorId = getOrCreateActorId(db, trimmedName);
                        if (actorId) {
                            const actorInfo = db.prepare('SELECT id, name, actor_number FROM actors WHERE id = ?').get(actorId);
                            if (actorInfo) {
                                if (!currentSelectedActors.some(a => a.id === actorInfo.id)) {
                                    currentSelectedActors.push({
                                        id: actorInfo.id,
                                        name: actorInfo.name,
                                        actor_number: actorInfo.actor_number,
                                        isTextOnly: false
                                    });
                                }
                            }
                        }
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
        if (ratingVal !== null && isNaN(ratingVal)) return alert('評分格式不正確，請輸入數字 (例如: 3 或 4.5)');

        setIsLoading(true);
        setTimeout(() => {
            try {
                db.transaction(() => {
                    let workId = initialWorkId;
                    const saveData = { ...formData, rating: ratingVal };

                    if (isEditMode) {
                        db.prepare(`UPDATE works SET work_number=@work_number, name=@name, release_date=@release_date, resolution=@resolution, duration=@duration, file_size=@file_size, director=@director, maker=@maker, publisher=@publisher, rating=@rating, is_favorite=@is_favorite, notes=@notes WHERE id=@id`).run({ ...saveData, id: workId });
                    } else {
                        workId = db.prepare(`INSERT INTO works (work_number, name, release_date, resolution, duration, file_size, director, maker, publisher, rating, is_favorite, notes, created_at) VALUES (@work_number, @name, @release_date, @resolution, @duration, @file_size, @director, @maker, @publisher, @rating, @is_favorite, @notes, @created_at)`).run({ ...saveData, created_at: Date.now() }).lastInsertRowid;
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

                    const insertImg = db.prepare('INSERT INTO work_images (work_id, file_name, sort_order, is_cover) VALUES (?, ?, ?, ?)');
                    const updateImg = db.prepare('UPDATE work_images SET sort_order = ?, is_cover = ? WHERE id = ?');

                    images.forEach((img, idx) => {
                        const isCover = idx === 0 ? 1 : 0;
                        if (img.isStored) {
                            updateImg.run(idx + 1, isCover, img.dbId);
                        } else {
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
        ${videoCandidates && html`
            <div className="modal-overlay" onClick=${() => setVideoCandidates(null)}>
                <div className="modal-box" onClick=${e => e.stopPropagation()} style=${{ maxWidth: '500px', width: '90%' }}>
                    <div className="modal-header"><h3 style=${{ margin: 0, fontSize: '16px' }}>選擇版本</h3></div>
                    <div style=${{ padding: '8px 0', maxHeight: '300px', overflowY: 'auto' }}>
                        ${videoCandidates.map((g, i) => html`
                            <div key=${i} onClick=${() => { playPath(g.paths); setVideoCandidates(null); }}
                                style=${{ padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: '13px' }}
                                title=${g.files.map(f => f.absolutePath).join('\n')}
                                onMouseEnter=${e => e.currentTarget.style.backgroundColor = '#f5f5f5'}
                                onMouseLeave=${e => e.currentTarget.style.backgroundColor = ''}>
                                ${g.files[0].fileName}${g.isMultiPart ? html` <span style=${{ color: '#2196F3' }}>(共 ${g.files.length} 段)</span>` : ''}
                            </div>
                        `)}
                    </div>
                    <div className="modal-footer"><button className="btn-secondary" onClick=${() => setVideoCandidates(null)}>取消</button></div>
                </div>
            </div>
        `}
        ${moveState && html`
            <div className="modal-overlay" onClick=${() => setMoveState(null)}>
                <div className="modal-box" onClick=${e => e.stopPropagation()} style=${{ maxWidth: '560px', width: '90%' }}>
                    <div className="modal-header"><h3 style=${{ margin: 0, fontSize: '16px' }}>移動作品檔案</h3></div>
                    <div style=${{ padding: '8px 0', fontSize: '13px', color: '#666', lineHeight: 1.5 }}>
                        勾選要移動的影片檔 (將連同旁邊同主檔名的封面圖等一起移動)，接著選擇軟體根目錄範圍內的目的資料夾：
                    </div>
                    <div style=${{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #eee', borderRadius: 4 }}>
                        ${moveState.files.map((f, i) => html`
                            <label key=${i} style=${{ display: 'flex', gap: '8px', padding: '8px 12px', borderBottom: '1px solid #f5f5f5', cursor: 'pointer', alignItems: 'flex-start' }}>
                                <input type="checkbox" checked=${f.checked} onChange=${() => setMoveState(prev => ({ ...prev, files: prev.files.map((x, j) => j === i ? { ...x, checked: !x.checked } : x) }))} style=${{ marginTop: 3, flexShrink: 0 }} />
                                <div style=${{ minWidth: 0 }}>
                                    <div style=${{ wordBreak: 'break-all' }}>${f.fileName}</div>
                                    <div style=${{ fontSize: '12px', color: '#888', wordBreak: 'break-all' }}>${f.relativePath}</div>
                                </div>
                            </label>
                        `)}
                    </div>
                    <div className="modal-footer" style=${{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                        <button className="btn-secondary" onClick=${() => setMoveState(null)}>取消</button>
                        <button className="btn-primary" onClick=${handleConfirmMove}><${FolderInput} size=${16} style=${{ marginRight: 6 }} />選擇目的資料夾並移動</button>
                    </div>
                </div>
            </div>
        `}
        <div className="main-layout">
            <div className="sidebar" style=${{ width: '50%' }}>
                <div className="editor-gallery ${dragOver ? 'drag-over' : ''}" onDragOver=${e => { e.preventDefault(); setDragOver(true); }} onDragLeave=${() => setDragOver(false)} onDrop=${handleDropUpload}>
                    <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <h3 style=${{ margin: 0 }}>圖片管理 (${images.length})</h3>
                        ${selectedImageIds.length > 0 && html`
                            <button className="btn-block" onClick=${handleDeleteSelected} style=${{ backgroundColor: '#dc3545', color: 'white', padding: '4px 12px', border: 'none', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', fontSize: '13px' }}>
                                <${Trash2} size=${14} style=${{ marginRight: '6px' }} /> 刪除已選擇 (${selectedImageIds.length})
                            </button>
                        `}
                    </div>
                    <div className="main-preview" style=${{ flex: 3, backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '10px', position: 'relative' }}>
                        ${images[previewIndex] ? html`
                            <img src="${images[previewIndex].previewUrl}" style=${{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                            ${images.length > 1 && html`
                                <div className="preview-nav-btn prev" onClick=${handlePrevImage} style=${{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', backgroundColor: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', padding: '8px', cursor: 'pointer' }}>
                                    <${ChevronLeftIcon} size=${24} />
                                </div>
                                <div className="preview-nav-btn next" onClick=${handleNextImage} style=${{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', backgroundColor: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', padding: '8px', cursor: 'pointer' }}>
                                    <${ChevronRightIcon} size=${24} />
                                </div>
                            `}
                        ` : html`<div style=${{ color: '#666' }}>無圖片</div>`}
                    </div>
                    <div className="thumbnail-list" style=${{ flex: 1, minHeight: '120px', gridTemplateColumns: 'repeat(auto-fill, 160px)', overflowY: 'auto' }}>
                        ${images.map((img, idx) => html`
                            <div key=${img.id} className="thumbnail-item ${idx === previewIndex ? 'active' : ''}" draggable="true" onDragStart=${() => setDraggingIndex(idx)} onDragOver=${e => e.preventDefault()} onDrop=${e => handleSortDrop(e, idx)} onClick=${() => setPreviewIndex(idx)} style=${{ height: '100px', width: '160px', position: 'relative' }}>
                                <input type="checkbox" checked=${selectedImageIds.includes(img.id)} onChange=${e => { e.stopPropagation(); setSelectedImageIds(prev => prev.includes(img.id) ? prev.filter(id => id !== img.id) : [...prev, img.id]); }} onClick=${e => e.stopPropagation()} style=${{ position: 'absolute', top: '6px', left: '6px', zIndex: 10, cursor: 'pointer', width: '18px', height: '18px', accentColor: '#e91e63' }} />
                                <img src="${img.previewUrl}" style=${{ width: '100%', height: '100%', objectFit: 'cover', opacity: selectedImageIds.includes(img.id) ? 0.7 : 1 }} />
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
                <div className="content-header" style=${{ position: 'sticky', top: 0, backgroundColor: '#fff', zIndex: 2 }}>
                    <div className="result-info">${isEditMode ? '編輯作品' : '新增作品'}</div>
                    <div style=${{ display: 'flex', gap: '8px' }}>
                        <button className="btn-primary" onClick=${() => findAndPlay(formData.work_number, formData.name)} disabled=${isPlaying} style=${{ backgroundColor: '#28a745', borderColor: '#28a745', opacity: isPlaying ? 0.6 : 1 }}><${Play} size=${16} style=${{ marginRight: 6 }} />${isPlaying ? '搜尋中...' : '播放影片'}</button>
                        <button className="btn-primary" onClick=${openMoveFiles} disabled=${isMoving} style=${{ backgroundColor: '#6f42c1', borderColor: '#6f42c1', opacity: isMoving ? 0.6 : 1 }}><${FolderInput} size=${16} style=${{ marginRight: 6 }} />${isMoving ? '搜尋中...' : '移動檔案'}</button>
                        <button className="btn-primary" onClick=${handleSave}><${Save} size=${16} style=${{ marginRight: 6 }} /> 儲存</button>
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
                    <div className="filter-group"><div style=${{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}><label className="filter-label" style=${{ margin: 0 }}>實際檔案長度</label>${(() => { const dSec = parseTimeToSeconds(formData.duration); const fSec = parseTimeToSeconds(formData.file_size); return (dSec !== null && fSec !== null && (dSec - fSec) >= 900) ? html`<span style=${{ color: '#dc3545', fontWeight: 'bold', fontSize: '13px', whiteSpace: 'nowrap' }}>⚠ 影片長度不足</span>` : null; })()}</div><input className="filter-input" value=${formData.file_size || ''} onInput=${e => handleChange('file_size', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">導演</label><input className="filter-input" value=${formData.director || ''} onInput=${e => handleChange('director', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">製作商</label><input className="filter-input" value=${formData.maker || ''} onInput=${e => handleChange('maker', e.target.value)} onMouseDown=${stopProp} /></div>
                    <div className="filter-group"><label className="filter-label">發行商</label><input className="filter-input" value=${formData.publisher || ''} onInput=${e => handleChange('publisher', e.target.value)} onMouseDown=${stopProp} /></div>
                    
                    <div className="filter-group" style=${{ borderTop: '1px solid #eee', paddingTop: 20 }}>
                        <label className="filter-label">演員</label>
                        <${ActorSelector} selectedActors=${selectedActors} onChange=${setSelectedActors} inputValue=${actorInputValue} onInputChange=${setActorInputValue} />
                    </div>
                    <div className="filter-group"><label className="filter-label">評分 (最高5分)</label><input type="text" inputMode="decimal" className="filter-input" value=${formData.rating || ''} onInput=${e => handleChange('rating', e.target.value)} onMouseDown=${stopProp} placeholder="請輸入評分 (例如 4.5)" /></div>
                    
                    <div className="filter-group" style=${{ padding: '8px 0', marginBottom: '8px' }}>
                        <label className="filter-label" style=${{ display: 'flex', alignItems: 'center', cursor: 'pointer', margin: 0 }}>
                            <input type="checkbox" checked=${!!formData.is_favorite} onChange=${e => handleChange('is_favorite', e.target.checked ? 1 : 0)} style=${{ marginRight: 8 }} />
                            待看關注
                        </label>
                    </div>

                    <div className="filter-group" style=${{ borderTop: '1px solid #eee', paddingTop: 20 }}>
                        <${TagSelector} selectedTags=${selectedTags} onChange=${setSelectedTags} />
                    </div>

                    <div className="filter-group" style=${{ borderTop: '1px solid #eee', paddingTop: 20 }}>
                        <label className="filter-label">註解</label>
                        <textarea 
                            className="filter-input" 
                            style=${{ minHeight: '120px', resize: 'vertical', width: '100%', lineHeight: '1.5', fontFamily: 'inherit' }} 
                            value=${formData.notes || ''} 
                            onInput=${e => handleChange('notes', e.target.value)} 
                            onMouseDown=${stopProp}
                            placeholder="請輸入註解..." 
                        />
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

    // 分離第一組標籤與其他標籤 (以全域第一組的 sort_order 為固定基準)
    const allTags = work.tags || [];
    const firstGroupOrder = work.firstGroupOrder ?? null;
    const firstGroupTags = firstGroupOrder !== null ? allTags.filter(t => t.group_sort_order === firstGroupOrder) : [];
    const otherTags = firstGroupOrder !== null ? allTags.filter(t => t.group_sort_order !== firstGroupOrder) : allTags;

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
                    <div style=${{ display: 'flex', flexDirection: 'column', minWidth: 0, flexShrink: 0, maxWidth: '65%' }}>
                        <div className="card-id" style=${{ flexShrink: 0, marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title=${work.work_number || ''}>${work.work_number || '[NO ID]'}</div>
                        <div style=${{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                            ${work.fav_actor_count > 0 ? html`<${Star} size=${14} color="#fbc02d" fill="#fbc02d" title="包含關注演員" />` : null}
                            ${work.is_favorite ? html`<${Bookmark} size=${14} color="#e91e63" fill="#e91e63" title="待看關注" />` : null}
                        </div>
                    </div>
                    <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'flex-end', alignContent: 'flex-start', flex: 1, minWidth: 0 }}>
                        ${otherTags.map(t => html`
                            <span style=${{ fontSize: '12px', padding: '2px 6px', borderRadius: '4px', backgroundColor: t.color || '#eee', color: t.color ? getContrastYIQ(t.color) : '#333', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', height: '26px' }}>
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
                ${firstGroupTags.length > 0 && html`
                    <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '4px', borderTop: '1px solid #f0f0f0', paddingTop: '4px' }}>
                        ${firstGroupTags.map(t => html`
                            <span style=${{ fontSize: '12px', padding: '2px 6px', borderRadius: '4px', backgroundColor: t.color || '#eee', color: t.color ? getContrastYIQ(t.color) : '#333', whiteSpace: 'nowrap' }}>
                                ${t.name}
                            </span>
                        `)}
                    </div>
                `}
                ${work.folderNames !== undefined && (() => {
        const folders = work.folderNames || [];
        const label = folders.length > 0 ? folders.join('、') : '找不到檔案';
        return html`
                        <div style=${{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px', fontSize: '12px', color: folders.length > 0 ? '#666' : '#bbb', minWidth: 0 }} title=${label}>
                            <${Folder} size=${12} style=${{ flexShrink: 0 }} />
                            <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${label}</span>
                        </div>`;
    })()}
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