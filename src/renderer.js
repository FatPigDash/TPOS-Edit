/*
• TPOS (The Pile of Shame) 軟體開發 - Renderer Process
• 版本: V1.4.0 (新增作品卡片顯示標籤-字體加大版)
*/
const React = require('react');
const ReactDOM = require('react-dom/client');
const htm = require('htm');
const html = htm.bind(React.createElement);
const {
    Database, Tag, Users, Plus
} = require('lucide-react');

const { db } = require('./utils/db');
const { parseSearchQuery } = require('./utils/helpers');
const {
    ErrorBoundary, LoadingOverlay, Pagination
} = require('./components/Shared');
const {
    WorkSidebar, WorkCard, WorkEditor, WorkDetails
} = require('./components/WorkSystem');
const { TagSystem } = require('./components/TagSystem');
const { ActorSystem } = require('./components/ActorSystem');

// 9. 主程式進入點 (App & Main)

function App() {
    const ITEMS_PER_PAGE = 15;
    const [activeTab, setActiveTab] = React.useState('works');
    const [viewMode, setViewMode] = React.useState('list');
    const [selectedWorkId, setSelectedWorkId] = React.useState(null);
    const [works, setWorks] = React.useState([]);

    const [uiFilters, setUiFilters] = React.useState({ name: "", code: "", director: "", maker: "", publisher: "", rating: "", actor: { mode: 'OR', items: [], inputValue: "" }, tags: [] });
    const [appliedFilters, setAppliedFilters] = React.useState({ name: "", code: "", director: "", maker: "", publisher: "", rating: "", actor: { mode: 'OR', items: [], inputValue: "" }, tags: [] });
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
                if (appliedFilters.code) { const q = parseSearchQuery(appliedFilters.code, 'w.work_number'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.director) { const q = parseSearchQuery(appliedFilters.director, 'w.director'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.maker) { const q = parseSearchQuery(appliedFilters.maker, 'w.maker'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.publisher) { const q = parseSearchQuery(appliedFilters.publisher, 'w.publisher'); if (q.sql) { whereClauses.push(q.sql.replace(/^\s*AND\s*/, '')); params.push(...q.params); } }
                if (appliedFilters.rating && appliedFilters.rating.trim() !== '') { const rVal = parseFloat(appliedFilters.rating); if (!isNaN(rVal)) { whereClauses.push('w.rating >= ?'); params.push(rVal); } }

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
                    joinClause += ' JOIN work_tag_link wtl ON w.id = wtl.work_id';
                    whereClauses.push(`wtl.tag_id IN (${appliedFilters.tags.map(() => '?').join(',')})`);
                    params.push(...appliedFilters.tags);
                    groupBy = 'GROUP BY w.id';
                    having = `HAVING COUNT(DISTINCT wtl.tag_id) = ${appliedFilters.tags.length}`;
                }

                const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
                const countSql = groupBy ? `SELECT COUNT(*) as count FROM (SELECT w.id FROM works w ${joinClause} ${whereSql} ${groupBy} ${having})` : `SELECT COUNT(*) as count FROM works w ${whereSql}`;

                // 修正分頁器未即時更新的問題
                const countResult = db.prepare(countSql).get(...params);
                const currentTotal = countResult ? countResult.count : 0;
                setTotalItems(currentTotal);
                const totalP = Math.ceil(currentTotal / ITEMS_PER_PAGE) || 1;
                setTotalPages(totalP);

                let targetPage = Math.min(currentPage, totalP);
                const offset = (targetPage - 1) * ITEMS_PER_PAGE;

                const rows = db.prepare(`SELECT w.*, wi.file_name as cover_image FROM works w ${joinClause} ${whereSql} ${groupBy} ${having} ORDER BY w.created_at DESC LIMIT ? OFFSET ?`).all(...params, ITEMS_PER_PAGE, offset);
                
                // 額外讀取每個作品的標籤 (v1.4.0 新增)
                rows.forEach(row => {
                    try {
                        row.tags = db.prepare(`SELECT t.name, t.color FROM work_tag_link wtl JOIN tags t ON wtl.tag_id = t.id JOIN tag_groups tg ON t.group_id = tg.id WHERE wtl.work_id = ? ORDER BY tg.sort_order ASC, t.sort_order ASC`).all(row.id);
                    } catch(e) { row.tags = []; }
                });

                setWorks(rows);
            } catch (err) { console.error(err); }
            setIsLoading(false);
        }, 50);
    };

    React.useEffect(() => { setCurrentPage(1); }, [appliedFilters]);
    React.useEffect(() => { loadWorks(); }, [activeTab, viewMode, currentPage, appliedFilters]);

    const getSearchConditions = () => {
        const conds = [];
        if (appliedFilters.name) conds.push(`名稱: ${appliedFilters.name}`);
        if (appliedFilters.code) conds.push(`識別碼: ${appliedFilters.code}`);
        if (appliedFilters.rating) conds.push(`評分 >= ${appliedFilters.rating}`);
        if (appliedFilters.director) conds.push(`導演: ${appliedFilters.director}`);
        if (appliedFilters.maker) conds.push(`製作商: ${appliedFilters.maker}`);
        if (appliedFilters.publisher) conds.push(`發行商: ${appliedFilters.publisher}`);
        const af = appliedFilters.actor;
        if (af?.items?.length > 0) {
            const names = af.items.map(i => i.name).join(af.mode === 'AND' ? ' + ' : ' | ');
            conds.push(`演員: ${names}`);
        } else if (af?.inputValue && af.inputValue.trim()) {
            conds.push(`演員包含: ${af.inputValue.trim()}`);
        }
        if (appliedFilters.tags?.length > 0 && db) {
            try {
                const names = db.prepare(`SELECT name FROM tags WHERE id IN (${appliedFilters.tags.map(() => '?').join(',')})`).all(...appliedFilters.tags).map(t => t.name);
                conds.push(`標籤: ${names.join(' + ')}`);
            } catch (e) { conds.push(`標籤: ${appliedFilters.tags.length}個`); }
        }
        return conds;
    };

    const handleClearFilter = () => {
        const empty = { name: '', code: '', director: '', maker: '', publisher: '', rating: '', actor: { mode: 'OR', items: [], inputValue: "" }, tags: [] };
        setUiFilters(empty);
        setAppliedFilters(empty);
    };

    // 新增: 處理從演員列表快速跳轉至作品搜尋
    const handleActorQuickSearch = (actor) => {
        const actorFilter = { mode: 'OR', items: [{ id: actor.id, name: actor.name }], inputValue: "" };
        const newFilters = { 
            name: "", code: "", director: "", maker: "", publisher: "", rating: "", 
            actor: actorFilter, tags: [] 
        };
        // 同步更新 UI 與 Applied，確保切換後立刻搜尋
        setUiFilters(newFilters);
        setAppliedFilters(newFilters);
        setActiveTab('works');
        setViewMode('list');
    };

    return html`
        <${LoadingOverlay} show=${isLoading} />
        <div style=${{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div className="navbar">
                <div className="nav-title">The Pile of Shame (V1.4.0)</div>
                <div className="nav-tabs">
                    <button className="nav-btn ${activeTab === 'works' ? 'active' : ''}" onClick=${() => { setActiveTab('works'); setViewMode('list'); }}><${Database} size=${16}/> 作品資料庫</button>
                    <button className="nav-btn ${activeTab === 'tags' ? 'active' : ''}" onClick=${() => setActiveTab('tags')}><${Tag} size=${16} /> 標籤系統</button>
                    <button className="nav-btn ${activeTab === 'actors' ? 'active' : ''}" onClick=${() => setActiveTab('actors')}><${Users} size=${16} /> 演員資料庫</button>
                </div>
                ${activeTab === 'works' && html`<div className="nav-actions"><button className="btn-primary" onClick=${() => { setSelectedWorkId(null); setViewMode('edit'); }}><${Plus} size=${16} style=${{ marginRight: 4 }} /> 新增作品</button></div>`}
            </div>
            <div style=${{ flex: 1, overflow: 'hidden' }}>
                ${activeTab === 'works' ? (
                    viewMode === 'edit' ? html`<${WorkEditor} initialWorkId=${selectedWorkId} setIsLoading=${setIsLoading} onCancel=${() => setViewMode('list')} onSaveSuccess=${() => { setViewMode('list'); loadWorks(); }} />` :
                        viewMode === 'details' ? html`<${WorkDetails} workId=${selectedWorkId} onBack=${() => { setViewMode('list'); setSelectedWorkId(null); }} onEdit=${(id) => { setSelectedWorkId(id); setViewMode('edit'); }} />` :
                            html`<div className="main-layout">
                        <${WorkSidebar} uiFilters=${uiFilters} setUiFilters=${setUiFilters} onApply=${() => setAppliedFilters({ ...uiFilters })} onClear=${handleClearFilter} />
                        <div className="content-area">
                            <div className="content-header" style=${{ flexDirection: 'column', alignItems: 'flex-start' }}>
                                <div className="result-info">搜尋結果: 共${totalItems} 筆</div>
                                <div style=${{ fontSize: '14px', color: '#666', marginTop: '8px', lineHeight: '1.5' }}>
                                    ${getSearchConditions().length === 0 && '尚未搜尋'}
                                    ${getSearchConditions().map(cond => html`<div key=${cond}>${cond}</div>`)}
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
                ) : activeTab === 'tags' ? html`<${TagSystem} />` : html`<${ActorSystem} setIsLoading=${setIsLoading} onNavigateToWork=${handleActorQuickSearch} />`}
            </div>
        </div>`;
}

try {
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(html`<${ErrorBoundary}><${App} /></${ErrorBoundary}>`);
} catch (err) {
    document.body.innerHTML = `<div style="padding: 20px; color: red"><h1>Critical Error</h1><pre>${err.stack}</pre></div>`;
}