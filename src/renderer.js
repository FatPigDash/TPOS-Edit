/*
• TPOS (The Pile of Shame) 軟體開發 - Renderer Process
• 版本: V1.5.6 (新增作品名稱排序)
*/
const React = require('react');
const ReactDOM = require('react-dom/client');
const htm = require('htm');
const html = htm.bind(React.createElement);
const {
    Database, Tag, Users, Plus, PanelLeft, ArrowUpDown, FileText, FolderCog, FolderInput
} = require('lucide-react');

const { fullTitle } = require('./version');
const { db } = require('./utils/db');
const { parseSearchQuery, parseCodeSearchQuery } = require('./utils/helpers');
const {
    ErrorBoundary, LoadingOverlay, Pagination
} = require('./components/Shared');
const {
    WorkSidebar, WorkCard, WorkEditor, WorkDetails
} = require('./components/WorkSystem');
const { TagSystem } = require('./components/TagSystem');
const { ActorSystem } = require('./components/ActorSystem');
const { FileOrganizerSystem } = require('./components/FileOrganizer');
const { VideoImportSystem } = require('./components/VideoImport');

// 9. 主程式進入點 (App & Main)

function App() {
    const ITEMS_PER_PAGE = 15;
    const [activeTab, setActiveTab] = React.useState('works');
    const [viewMode, setViewMode] = React.useState('list');
    const [selectedWorkId, setSelectedWorkId] = React.useState(null);
    const [works, setWorks] = React.useState([]);

    // 列表頁面的側邊欄狀態 (預設開啟)
    const [isSidebarOpen, setIsSidebarOpen] = React.useState(true);

    // 排序狀態: created_desc (預設), code_asc, rating_desc, name_asc
    const [sortOrder, setSortOrder] = React.useState('created_desc');

    // V2.2.x: 新增 hasFavActor 與 isWatchLater 狀態
    const [uiFilters, setUiFilters] = React.useState({ name: "", code: "", director: "", maker: "", publisher: "", rating: "", ratingMode: 'gte', actor: { mode: 'OR', items: [], inputValue: "" }, tags: [], hasFavActor: false, isWatchLater: false });
    const [appliedFilters, setAppliedFilters] = React.useState({ name: "", code: "", director: "", maker: "", publisher: "", rating: "", ratingMode: 'gte', actor: { mode: 'OR', items: [], inputValue: "" }, tags: [], hasFavActor: false, isWatchLater: false });
    const [currentPage, setCurrentPage] = React.useState(1);
    const [totalItems, setTotalItems] = React.useState(0);
    const [totalPages, setTotalPages] = React.useState(1);
    const [isLoading, setIsLoading] = React.useState(false);

    const loadWorks = () => {
        if (!db) return;
        setIsLoading(true);
        setTimeout(() => {
            try {
                let whereClauses = [];
                const params = [];
                let joinClause = 'LEFT JOIN work_images wi ON w.id = wi.work_id AND wi.is_cover = 1';
                let groupBy = '';
                let having = '';

                // 修正: 將 \s+ 改為 \s*, 允許開頭無空白, 解決 "WHERE AND (...)" 的語法錯誤
                if (appliedFilters.name) { const q = parseSearchQuery(appliedFilters.name, 'w.name'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.code) { const q = parseCodeSearchQuery(appliedFilters.code, 'w.work_number'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.director) { const q = parseSearchQuery(appliedFilters.director, 'w.director'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.maker) { const q = parseSearchQuery(appliedFilters.maker, 'w.maker'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.publisher) { const q = parseSearchQuery(appliedFilters.publisher, 'w.publisher'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.rating && appliedFilters.rating.trim() !== '') { const rVal = parseFloat(appliedFilters.rating); if (!isNaN(rVal)) { const rOp = appliedFilters.ratingMode === 'eq' ? '=' : '>='; whereClauses.push(`w.rating ${rOp} ?`); params.push(rVal); } }

                // 新增: 待看關注篩選
                if (appliedFilters.isWatchLater) {
                    whereClauses.push('w.is_favorite = 1');
                }

                // 新增: 關注演員篩選 (使用 EXISTS 子查詢)
                if (appliedFilters.hasFavActor) {
                    whereClauses.push('EXISTS (SELECT 1 FROM work_actor_link wal JOIN actors a ON wal.actor_id = a.id WHERE wal.work_id = w.id AND a.is_favorite = 1)');
                }

                const af = appliedFilters.actor;
                if (af?.items?.length > 0) {
                    const names = af.items.map(i => i.name);
                    if (af.mode === 'OR') {
                        const placeholders = names.map(() => '?').join(',');
                        whereClauses.push(`w.id IN (SELECT wal.work_id FROM work_actor_link wal LEFT JOIN actors a ON wal.actor_id = a.id WHERE a.name IN (${placeholders}) OR wal.actor_name IN (${placeholders}))`);
                        params.push(...names, ...names);
                    } else {
                        names.forEach(name => {
                            whereClauses.push(`EXISTS (SELECT 1 FROM work_actor_link wal LEFT JOIN actors a ON wal.actor_id = a.id WHERE wal.work_id = w.id AND (a.name = ? OR wal.actor_name = ?))`);
                            params.push(name, name);
                        });
                    }
                } else if (af?.inputValue && af.inputValue.trim()) {
                    const text = af.inputValue.trim();
                    whereClauses.push(`w.id IN (SELECT wal.work_id FROM work_actor_link wal LEFT JOIN actors a ON wal.actor_id = a.id WHERE a.name LIKE ? OR wal.actor_name LIKE ?)`);
                    params.push(`%${text}%`, `%${text}%`);
                }

                if (appliedFilters.tags?.length > 0) {
                    const includeTags = appliedFilters.tags.filter(t => t.mode === 'include');
                    const excludeTags = appliedFilters.tags.filter(t => t.mode === 'exclude');

                    if (includeTags.length > 0) {
                        // 包含標籤: AND 邏輯，作品必須包含所有指定標籤
                        joinClause += ' JOIN work_tag_link wtl ON w.id = wtl.work_id';
                        whereClauses.push(`wtl.tag_id IN (${includeTags.map(() => '?').join(',')})`);
                        params.push(...includeTags.map(t => t.id));
                        groupBy = 'GROUP BY w.id';
                        having = `HAVING COUNT(DISTINCT wtl.tag_id) = ${includeTags.length}`;
                    }

                    if (excludeTags.length > 0) {
                        // 排除標籤: 作品必須不包含任何一個排除標籤
                        excludeTags.forEach(t => {
                            whereClauses.push(`NOT EXISTS (SELECT 1 FROM work_tag_link etl WHERE etl.work_id = w.id AND etl.tag_id = ?)`);
                            params.push(t.id);
                        });
                    }
                }

                const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
                const countSql = groupBy ? `SELECT COUNT(*) as count FROM (SELECT w.id FROM works w ${joinClause} ${whereSql} ${groupBy} ${having})` : `SELECT COUNT(*) as count FROM works w ${whereSql}`;

                const countResult = db.prepare(countSql).get(...params);
                const currentTotal = countResult ? countResult.count : 0;
                setTotalItems(currentTotal);
                const totalP = Math.ceil(currentTotal / ITEMS_PER_PAGE) || 1;
                setTotalPages(totalP);

                let targetPage = Math.min(currentPage, totalP);
                const offset = (targetPage - 1) * ITEMS_PER_PAGE;

                // 決定排序方式
                let orderByClause = 'w.created_at DESC'; // 預設: 新增時間(新到舊)
                if (sortOrder === 'code_asc') {
                    orderByClause = 'w.work_number ASC';
                } else if (sortOrder === 'rating_desc') {
                    orderByClause = 'w.rating DESC, w.created_at DESC';
                } else if (sortOrder === 'name_asc') {
                    orderByClause = 'w.name ASC';
                }

                // 修改查詢: 增加 fav_actor_count 欄位，用於判斷是否顯示「關注演員」圖示
                const selectFields = `w.*, wi.file_name as cover_image, (SELECT COUNT(*) FROM work_actor_link wal JOIN actors a ON wal.actor_id = a.id WHERE wal.work_id = w.id AND a.is_favorite = 1) as fav_actor_count`;
                // 使用動態 orderByClause
                const rows = db.prepare(`SELECT ${selectFields} FROM works w ${joinClause} ${whereSql} ${groupBy} ${having} ORDER BY ${orderByClause} LIMIT ? OFFSET ?`).all(...params, ITEMS_PER_PAGE, offset);

                const firstGroupOrderResult = db.prepare('SELECT MIN(sort_order) as min_order FROM tag_groups').get();
                const globalFirstGroupOrder = firstGroupOrderResult ? firstGroupOrderResult.min_order : null;

                rows.forEach(row => {
                    try {
                        row.tags = db.prepare(`SELECT t.name, t.color, tg.sort_order as group_sort_order FROM work_tag_link wtl JOIN tags t ON wtl.tag_id = t.id JOIN tag_groups tg ON t.group_id = tg.id WHERE wtl.work_id = ? ORDER BY tg.sort_order ASC, t.sort_order ASC`).all(row.id);
                        row.firstGroupOrder = globalFirstGroupOrder;
                    } catch (e) { row.tags = []; row.firstGroupOrder = null; }
                });

                setWorks(rows);
            } catch (err) { console.error(err); }
            setIsLoading(false);
        }, 50);
    };

    // 處理識別碼移至尾端的邏輯
    const handleBatchMoveId = () => {
        if (!db) return;
        if (!confirm("⚠️ 批量名稱格式化警告\n\n此功能會掃描所有作品，若「作品名稱」開頭包含「識別碼」，會將識別碼移至名稱的最後方。\n\n例如:\n「ABC-123 作品範例」 → 「作品範例 ABC-123」\n\n確定要執行嗎？")) return;

        setIsLoading(true);
        setTimeout(() => {
            try {
                let updatedCount = 0;
                db.transaction(() => {
                    // 撈出所有作品進行檢查
                    const allWorks = db.prepare("SELECT id, name, work_number FROM works").all();
                    const updateStmt = db.prepare("UPDATE works SET name = ? WHERE id = ?");

                    allWorks.forEach(w => {
                        if (!w.work_number || !w.name) return;

                        // 檢查名稱是否以識別碼開頭 (忽略大小寫與空白)
                        // 使用 trim() 去除前後空白，toLowerCase() 忽略大小寫
                        const cleanName = w.name.trim();
                        const cleanNumber = w.work_number.trim();

                        if (cleanName.toLowerCase().startsWith(cleanNumber.toLowerCase())) {
                            // 移除開頭的識別碼 (長度為識別碼長度)
                            // 並 trim() 去除移除後可能殘留的開頭空白
                            let newNameBody = cleanName.slice(cleanNumber.length).trim();

                            // 組合成新名稱: [內容] [識別碼]
                            // 若移除後內容是空的 (代表原名只有識別碼)，則保留原狀或僅顯示識別碼
                            let finalName;
                            if (!newNameBody) {
                                finalName = cleanNumber; // 原本就只有號碼，不變動或僅正規化
                            } else {
                                finalName = `${newNameBody} ${cleanNumber}`;
                            }

                            // 只有在名稱真的有改變時才更新 (避免重複執行導致空白變多等問題)
                            if (finalName !== w.name) {
                                updateStmt.run(finalName, w.id);
                                updatedCount++;
                            }
                        }
                    });
                })();

                alert(`處理完成！\n已更新 ${updatedCount} 筆作品的名稱格式。`);
                loadWorks(); // 重新載入列表以顯示變更

            } catch (err) {
                console.error(err);
                alert("處理失敗: " + err.message);
            }
            setIsLoading(false);
        }, 100);
    };

    React.useEffect(() => { setCurrentPage(1); }, [appliedFilters]);
    // 監聽 sortOrder 的變化來重新載入
    React.useEffect(() => { loadWorks(); }, [activeTab, viewMode, currentPage, appliedFilters, sortOrder]);

    const getSearchConditions = () => {
        const conds = [];
        if (appliedFilters.name) conds.push(`名稱: ${appliedFilters.name}`);
        if (appliedFilters.code) conds.push(`識別碼: ${appliedFilters.code}`);
        if (appliedFilters.rating) conds.push(`評分 ${appliedFilters.ratingMode === 'eq' ? '=' : '>='} ${appliedFilters.rating}`);
        if (appliedFilters.director) conds.push(`導演: ${appliedFilters.director}`);
        if (appliedFilters.maker) conds.push(`製作商: ${appliedFilters.maker}`);
        if (appliedFilters.publisher) conds.push(`發行商: ${appliedFilters.publisher}`);
        if (appliedFilters.hasFavActor) conds.push(`包含關注演員`);
        if (appliedFilters.isWatchLater) conds.push(`待看關注`);
        const af = appliedFilters.actor;
        if (af?.items?.length > 0) {
            const names = af.items.map(i => i.name).join(af.mode === 'AND' ? ' + ' : ' | ');
            conds.push(`演員: ${names}`);
        } else if (af?.inputValue && af.inputValue.trim()) {
            conds.push(`演員包含: ${af.inputValue.trim()}`);
        }
        if (appliedFilters.tags?.length > 0 && db) {
            try {
                const includeTags = appliedFilters.tags.filter(t => t.mode === 'include');
                const excludeTags = appliedFilters.tags.filter(t => t.mode === 'exclude');
                const allIds = appliedFilters.tags.map(t => t.id);
                const nameRows = db.prepare(`SELECT id, name FROM tags WHERE id IN (${allIds.map(() => '?').join(',')})`).all(...allIds);
                const nameMap = {};
                nameRows.forEach(r => { nameMap[r.id] = r.name; });
                if (includeTags.length > 0) conds.push(`包含標籤: ${includeTags.map(t => nameMap[t.id] || t.id).join(' + ')}`);
                if (excludeTags.length > 0) conds.push(`排除標籤: ${excludeTags.map(t => nameMap[t.id] || t.id).join(' + ')}`);
            } catch (e) { conds.push(`標籤: ${appliedFilters.tags.length}個`); }
        }
        return conds;
    };

    const handleClearFilter = () => {
        const empty = { name: '', code: '', director: '', maker: '', publisher: '', rating: '', ratingMode: 'gte', actor: { mode: 'OR', items: [], inputValue: "" }, tags: [], hasFavActor: false, isWatchLater: false };
        setUiFilters(empty);
        setAppliedFilters(empty);
    };

    const handleActorQuickSearch = (actor) => {
        const actorFilter = { mode: 'OR', items: [{ id: actor.id, name: actor.name }], inputValue: "" };
        const newFilters = {
            name: "", code: "", director: "", maker: "", publisher: "", rating: "", ratingMode: 'gte',
            actor: actorFilter, tags: [], hasFavActor: false, isWatchLater: false
        };
        setUiFilters(newFilters);
        setAppliedFilters(newFilters);
        setActiveTab('works');
        setViewMode('list');
    };

    return html`
        <${LoadingOverlay} show=${isLoading} />
        <div style=${{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div className="navbar">
                <div className="nav-title">${fullTitle}</div>
                <div className="nav-tabs">
                    <button className="nav-btn ${activeTab === 'works' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { setActiveTab('works'); setViewMode('list'); }}><${Database} size=${16}/> 作品資料庫</button>
                    <button className="nav-btn ${activeTab === 'tags' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => setActiveTab('tags')}><${Tag} size=${16} /> 標籤系統</button>
                    <button className="nav-btn ${activeTab === 'actors' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => setActiveTab('actors')}><${Users} size=${16} /> 演員資料庫</button>
                    <button className="nav-btn ${activeTab === 'fileOrganizer' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => setActiveTab('fileOrganizer')}><${FolderCog} size=${16} /> 影片整理</button>
                    <button className="nav-btn ${activeTab === 'videoImport' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => setActiveTab('videoImport')}><${FolderInput} size=${16} /> 影片匯入</button>
                </div>
                ${activeTab === 'works' && html`<div className="nav-actions"><button className="btn-primary" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { setSelectedWorkId(null); setViewMode('edit'); }}><${Plus} size=${16} style=${{ marginRight: 4 }} /> 新增作品</button></div>`}
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: ['works', 'tags', 'actors'].includes(activeTab) ? 'block' : 'none' }}>
                ${activeTab === 'works' ? (
            viewMode === 'edit' ? html`<${WorkEditor} initialWorkId=${selectedWorkId} setIsLoading=${setIsLoading} onCancel=${() => setViewMode('list')} onSaveSuccess=${() => { setViewMode('list'); loadWorks(); }} />` :
                viewMode === 'details' ? html`<${WorkDetails} workId=${selectedWorkId} 
                            uiFilters=${uiFilters} 
                            setUiFilters=${setUiFilters} 
                            onApply=${() => { setAppliedFilters({ ...uiFilters }); setViewMode('list'); }} 
                            onClear=${handleClearFilter}
                            onBack=${() => { setViewMode('list'); setSelectedWorkId(null); }} 
                            onEdit=${(id) => { setSelectedWorkId(id); setViewMode('edit'); }} />` :
                    html`<div className="main-layout">
                        ${isSidebarOpen && html`<${WorkSidebar} uiFilters=${uiFilters} setUiFilters=${setUiFilters} onApply=${() => setAppliedFilters({ ...uiFilters })} onClear=${handleClearFilter} />`}
                        <div className="content-area">
                            <div className="content-header" style=${{ alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px', height: 'auto', minHeight: '60px', padding: '16px 20px' }}>
                                <div style=${{ display: 'flex', alignItems: 'flex-start', flex: 1, minWidth: '300px' }}>
                                    <button className="btn-ghost" onClick=${() => setIsSidebarOpen(!isSidebarOpen)} title=${isSidebarOpen ? "隱藏側邊欄" : "顯示側邊欄"} style=${{ marginRight: '12px', marginTop: '2px' }}>
                                        <${PanelLeft} size=${20} />
                                    </button>
                                    <div style=${{ flex: 1 }}>
                                        <div className="result-info" style=${{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px' }}>搜尋結果: 共${totalItems} 筆</div>
                                        <div style=${{ fontSize: '14px', color: '#666', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                            ${getSearchConditions().length === 0 ? html`<div style=${{ color: '#999', fontStyle: 'italic' }}>尚未搜尋</div>` : getSearchConditions().map(cond => html`<div key=${cond} style=${{ display: 'inline-block', backgroundColor: '#e3f2fd', color: '#0d47a1', padding: '6px 10px', borderRadius: '6px', fontWeight: '500', width: 'fit-content', border: '1px solid #bbdefb' }}>${cond}</div>`)}
                                        </div>
                                    </div>
                                </div>
                                <div style=${{ display: 'flex', alignItems: 'flex-start' }}>
                                    <div style=${{ display: 'flex', alignItems: 'center', backgroundColor: '#f5f5f5', padding: '4px', borderRadius: '6px' }}>
                                        <${ArrowUpDown} size=${16} color="#666" style=${{ margin: '0 8px' }} />
                                        <select className="filter-input" style=${{ width: 'auto', padding: '6px 12px', cursor: 'pointer', marginRight: '8px', border: 'none', backgroundColor: 'transparent', fontWeight: 'bold' }} value=${sortOrder} onChange=${e => setSortOrder(e.target.value)}>
                                            <option value="created_desc">新增時間 (新 → 舊)</option>
                                            <option value="code_asc">識別碼 (A → Z)</option>
                                            <option value="name_asc">作品名稱 (A → Z)</option>
                                            <option value="rating_desc">評分 (高 → 低)</option>
                                        </select>
                                        <button className="btn-ghost" onClick=${handleBatchMoveId} title="將識別碼從名稱開頭移至尾端" style=${{ padding: '6px 10px', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                                            <${FileText} size=${16} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div className="card-grid">
                                ${works.map(w => html`<${WorkCard} key=${w.id} work=${w} onClick=${id => { setSelectedWorkId(id); setViewMode('details'); }} />`)}
                            </div>
                            <div style=${{ marginTop: 'auto', borderTop: '1px solid #eee' }}>
                                <${Pagination} currentPage=${currentPage} totalPages=${totalPages} onPageChange=${p => setCurrentPage(p)} />
                            </div>
                        </div>
                    </div>`
        ) : activeTab === 'tags' ? html`<${TagSystem} />` : activeTab === 'actors' ? html`<${ActorSystem} setIsLoading=${setIsLoading} onNavigateToWork=${handleActorQuickSearch} />` : null}
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: activeTab === 'fileOrganizer' ? 'block' : 'none' }}>
                <${FileOrganizerSystem} />
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: activeTab === 'videoImport' ? 'block' : 'none' }}>
                <${VideoImportSystem} />
            </div>
        </div>`;
}

try {
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(html`<${ErrorBoundary}><${App} /></${ErrorBoundary}>`);
} catch (err) {
    document.body.innerHTML = `<div style="padding: 20px; color: red"><h1>Critical Error</h1><pre>${err.stack}</pre></div>`;
}