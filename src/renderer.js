/*
• TPOS (The Pile of Shame) 軟體開發 - Renderer Process
• 版本: V1.5.6 (新增作品名稱排序)
*/
const React = require('react');
const ReactDOM = require('react-dom/client');
const htm = require('htm');
const html = htm.bind(React.createElement);
const { ipcRenderer } = require('electron');

// 依作品識別碼於資料夾對照表中查詢所屬資料夾名稱 (與 main 的比對邏輯一致: 大寫去空白, 並容錯去連字號)
function lookupWorkFolders(map, workNumber) {
    if (!map || !workNumber) return [];
    const t = String(workNumber).toUpperCase().replace(/\s+/g, '');
    return map[t] || map[t.replace(/-/g, '')] || [];
}
const {
    Database, Tag, Users, Plus, PanelLeft, ArrowUpDown, FileText, FolderCog, FolderInput, ArrowLeft, X
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

// 反轉排序方向 (asc <-> desc)
const toggleSortDirection = (order) => {
    if (order.endsWith('_asc')) return order.slice(0, -4) + '_desc';
    if (order.endsWith('_desc')) return order.slice(0, -5) + '_asc';
    return order;
};

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

    // 演員資料庫狀態 (提升至 App 層級，以便導覽歷史可以記錄/還原)
    const [actorUiFilters, setActorUiFilters] = React.useState({ name: "", code: "", noImage: false, isFavorite: false, scrapeFailed: false });
    const [actorAppliedFilters, setActorAppliedFilters] = React.useState({ name: "", code: "", noImage: false, isFavorite: false, scrapeFailed: false });
    const [actorSortOrder, setActorSortOrder] = React.useState('number_desc');
    const [actorViewMode, setActorViewMode] = React.useState('normal'); // 'normal' | 'duplicates'
    const [actorCurrentPage, setActorCurrentPage] = React.useState(1);
    const [actorDetailId, setActorDetailId] = React.useState(null);
    const [actorDetailFromWork, setActorDetailFromWork] = React.useState(false);

    // 記住作品列表的捲動位置，返回列表時還原 (避免每次都跳回頂部)
    const listContentRef = React.useRef(null);
    const listScrollPosRef = React.useRef(0);

    // 記住演員列表的捲動位置
    const actorContentRef = React.useRef(null);
    const actorScrollPosRef = React.useRef(0);

    // 「返回上一頁」導覽歷史 (最多紀錄5個步驟)
    const [navHistory, setNavHistory] = React.useState([]);
    const [restoreVersion, setRestoreVersion] = React.useState(0);
    const isRestoringRef = React.useRef(false);

    React.useLayoutEffect(() => {
        if (viewMode === 'list' && listContentRef.current) {
            listContentRef.current.scrollTop = listScrollPosRef.current;
        }
    }, [viewMode, restoreVersion]);

    React.useLayoutEffect(() => {
        if (activeTab === 'actors' && actorContentRef.current) {
            actorContentRef.current.scrollTop = actorScrollPosRef.current;
        }
    }, [activeTab, restoreVersion]);

    // 記錄目前頁面狀態，供「返回上一頁」還原 (最多保留5筆)
    const pushHistory = () => {
        const snapshot = {
            activeTab, viewMode, selectedWorkId,
            works: {
                uiFilters, appliedFilters, sortOrder, currentPage, isSidebarOpen,
                scrollTop: listScrollPosRef.current
            },
            actors: {
                uiFilters: actorUiFilters, appliedFilters: actorAppliedFilters, sortOrder: actorSortOrder,
                currentPage: actorCurrentPage, viewMode: actorViewMode, detailActorId: actorDetailId,
                scrollTop: actorScrollPosRef.current
            }
        };
        setNavHistory(prev => {
            const next = [...prev, snapshot];
            return next.length > 5 ? next.slice(next.length - 5) : next;
        });
    };

    // 返回上一個操作頁面，還原當時的畫面設定 (視窗位置、篩選條件、排序...)
    const goBack = () => {
        if (navHistory.length === 0) return;
        const snap = navHistory[navHistory.length - 1];
        setNavHistory(navHistory.slice(0, -1));
        isRestoringRef.current = true;

        setActiveTab(snap.activeTab);
        setViewMode(snap.viewMode);
        setSelectedWorkId(snap.selectedWorkId);

        setUiFilters(snap.works.uiFilters);
        setAppliedFilters(snap.works.appliedFilters);
        setSortOrder(snap.works.sortOrder);
        setCurrentPage(snap.works.currentPage);
        setIsSidebarOpen(snap.works.isSidebarOpen);
        listScrollPosRef.current = snap.works.scrollTop;

        setActorUiFilters(snap.actors.uiFilters);
        setActorAppliedFilters(snap.actors.appliedFilters);
        setActorSortOrder(snap.actors.sortOrder);
        setActorCurrentPage(snap.actors.currentPage);
        setActorViewMode(snap.actors.viewMode);
        setActorDetailId(snap.actors.detailActorId ?? null);
        setActorDetailFromWork(false);
        actorScrollPosRef.current = snap.actors.scrollTop;

        setRestoreVersion(v => v + 1);
    };

    const loadWorks = () => {
        if (!db) return;
        setIsLoading(true);
        setTimeout(async () => {
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
                    const andTags = appliedFilters.tags.filter(t => t.mode === 'include');
                    const orTags = appliedFilters.tags.filter(t => t.mode === 'include_or');
                    const excludeTags = appliedFilters.tags.filter(t => t.mode === 'exclude');

                    // 選取(AND): 作品必須包含每一個指定標籤
                    andTags.forEach(t => {
                        whereClauses.push(`EXISTS (SELECT 1 FROM work_tag_link wtl WHERE wtl.work_id = w.id AND wtl.tag_id = ?)`);
                        params.push(t.id);
                    });

                    // 選取(OR): 作品只需包含其中任一指定標籤
                    if (orTags.length > 0) {
                        whereClauses.push(`EXISTS (SELECT 1 FROM work_tag_link wtl WHERE wtl.work_id = w.id AND wtl.tag_id IN (${orTags.map(() => '?').join(',')}))`);
                        params.push(...orTags.map(t => t.id));
                    }

                    // 排除標籤: 作品必須不包含任何一個排除標籤
                    excludeTags.forEach(t => {
                        whereClauses.push(`NOT EXISTS (SELECT 1 FROM work_tag_link etl WHERE etl.work_id = w.id AND etl.tag_id = ?)`);
                        params.push(t.id);
                    });
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
                } else if (sortOrder === 'name_desc') {
                    orderByClause = 'w.name DESC';
                } else if (sortOrder === 'code_desc') {
                    orderByClause = 'w.work_number DESC';
                } else if (sortOrder === 'rating_asc') {
                    orderByClause = 'w.rating ASC, w.created_at DESC';
                } else if (sortOrder === 'created_asc') {
                    orderByClause = 'w.created_at ASC';
                } else if (sortOrder === 'release_date_desc') {
                    orderByClause = 'w.release_date DESC, w.created_at DESC';
                } else if (sortOrder === 'release_date_asc') {
                    orderByClause = 'w.release_date ASC, w.created_at DESC';
                }

                // 修改查詢: 增加 fav_actor_count 欄位，用於判斷是否顯示「關注演員」圖示
                const selectFields = `w.*, wi.file_name as cover_image, (SELECT COUNT(*) FROM work_actor_link wal JOIN actors a ON wal.actor_id = a.id WHERE wal.work_id = w.id AND a.is_favorite = 1) as fav_actor_count`;
                // 使用動態 orderByClause
                const rows = db.prepare(`SELECT ${selectFields} FROM works w ${joinClause} ${whereSql} ${groupBy} ${having} ORDER BY ${orderByClause} LIMIT ? OFFSET ?`).all(...params, ITEMS_PER_PAGE, offset);

                const firstGroupOrderResult = db.prepare('SELECT MIN(sort_order) as min_order FROM tag_groups').get();
                const globalFirstGroupOrder = firstGroupOrderResult ? firstGroupOrderResult.min_order : null;

                // 一次撈出本頁所有作品的標籤 (避免每列各發一次查詢的 N+1 問題)
                // 依 (群組排序, 標籤排序) 排序, 分組後各作品的標籤順序即與原本逐列查詢一致
                const tagsByWork = {};
                const workIds = rows.map(r => r.id);
                if (workIds.length > 0) {
                    try {
                        const placeholders = workIds.map(() => '?').join(',');
                        const tagRows = db.prepare(`SELECT wtl.work_id as work_id, t.name, t.color, tg.sort_order as group_sort_order FROM work_tag_link wtl JOIN tags t ON wtl.tag_id = t.id JOIN tag_groups tg ON t.group_id = tg.id WHERE wtl.work_id IN (${placeholders}) ORDER BY tg.sort_order ASC, t.sort_order ASC`).all(...workIds);
                        tagRows.forEach(tr => {
                            (tagsByWork[tr.work_id] || (tagsByWork[tr.work_id] = [])).push({ name: tr.name, color: tr.color, group_sort_order: tr.group_sort_order });
                        });
                    } catch (e) { console.error(e); }
                }

                // 掃描根目錄一次, 取得各作品實體檔案所屬的資料夾名稱 (main 端有 TTL 快取)
                let folderMap = {};
                try {
                    const fr = await ipcRenderer.invoke('get-work-folders');
                    folderMap = (fr && fr.map) || {};
                } catch (e) { console.error(e); }

                rows.forEach(row => {
                    row.tags = tagsByWork[row.id] || [];
                    row.firstGroupOrder = globalFirstGroupOrder;
                    row.folderNames = lookupWorkFolders(folderMap, row.work_number);
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

    React.useEffect(() => {
        if (isRestoringRef.current) return;
        setCurrentPage(1);
    }, [appliedFilters]);
    // 監聽 sortOrder 的變化來重新載入
    React.useEffect(() => { loadWorks(); }, [activeTab, viewMode, currentPage, appliedFilters, sortOrder]);

    // 演員資料庫: 篩選/排序/模式變更時重置頁碼 (還原導覽歷史時跳過)
    React.useEffect(() => {
        if (isRestoringRef.current) return;
        setActorCurrentPage(1);
    }, [actorAppliedFilters, actorSortOrder, actorViewMode]);

    // 還原導覽歷史後，重置 isRestoringRef (須在上述重置頁碼的 effect 之後執行)
    React.useEffect(() => {
        isRestoringRef.current = false;
    }, [restoreVersion]);

    const handleRemoveTagFilter = (tagId) => {
        pushHistory();
        setUiFilters(prev => ({ ...prev, tags: (prev.tags || []).filter(t => t.id !== tagId) }));
        setAppliedFilters(prev => ({ ...prev, tags: (prev.tags || []).filter(t => t.id !== tagId) }));
    };

    const getSearchConditions = () => {
        const conds = [];
        if (appliedFilters.name) conds.push({ key: 'name', label: `名稱: ${appliedFilters.name}` });
        if (appliedFilters.code) conds.push({ key: 'code', label: `識別碼: ${appliedFilters.code}` });
        if (appliedFilters.rating) conds.push({ key: 'rating', label: `評分 ${appliedFilters.ratingMode === 'eq' ? '=' : '>='} ${appliedFilters.rating}` });
        if (appliedFilters.director) conds.push({ key: 'director', label: `導演: ${appliedFilters.director}` });
        if (appliedFilters.maker) conds.push({ key: 'maker', label: `製作商: ${appliedFilters.maker}` });
        if (appliedFilters.publisher) conds.push({ key: 'publisher', label: `發行商: ${appliedFilters.publisher}` });
        if (appliedFilters.hasFavActor) conds.push({ key: 'hasFavActor', label: `包含關注演員` });
        if (appliedFilters.isWatchLater) conds.push({ key: 'isWatchLater', label: `待看關注` });
        const af = appliedFilters.actor;
        if (af?.items?.length > 0) {
            const names = af.items.map(i => i.name).join(af.mode === 'AND' ? ' + ' : ' | ');
            conds.push({ key: 'actor', label: `演員: ${names}` });
        } else if (af?.inputValue && af.inputValue.trim()) {
            conds.push({ key: 'actorInput', label: `演員包含: ${af.inputValue.trim()}` });
        }
        if (appliedFilters.tags?.length > 0 && db) {
            try {
                const allIds = appliedFilters.tags.map(t => t.id);
                const nameRows = db.prepare(`SELECT id, name FROM tags WHERE id IN (${allIds.map(() => '?').join(',')})`).all(...allIds);
                const nameMap = {};
                nameRows.forEach(r => { nameMap[r.id] = r.name; });
                appliedFilters.tags.forEach(t => {
                    const isExclude = t.mode === 'exclude';
                    const isOr = t.mode === 'include_or';
                    const prefix = isExclude ? '排除標籤' : (isOr ? '包含標籤(OR)' : '包含標籤(AND)');
                    conds.push({ key: `tag-${t.id}`, label: `${prefix}: ${nameMap[t.id] || t.id}`, exclude: isExclude, isOr, onRemove: () => handleRemoveTagFilter(t.id) });
                });
            } catch (e) { conds.push({ key: 'tagsError', label: `標籤: ${appliedFilters.tags.length}個` }); }
        }
        return conds;
    };

    const handleClearFilter = () => {
        pushHistory();
        const empty = { name: '', code: '', director: '', maker: '', publisher: '', rating: '', ratingMode: 'gte', actor: { mode: 'OR', items: [], inputValue: "" }, tags: [], hasFavActor: false, isWatchLater: false };
        setUiFilters(empty);
        setAppliedFilters(empty);
    };

    const handleNavigateToWorkDetails = (workId) => {
        pushHistory();
        setSelectedWorkId(workId);
        setActiveTab('works');
        setViewMode('details');
    };

    const handleNavigateToActorDetails = (actorId) => {
        pushHistory();
        setActorDetailId(actorId);
        setActorDetailFromWork(true);
        setActiveTab('actors');
    };

    const handleActorQuickSearch = (actor) => {
        pushHistory();
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
                    <button className="nav-btn ${activeTab === 'works' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { if (activeTab !== 'works') pushHistory(); setActiveTab('works'); setViewMode('list'); }}><${Database} size=${16}/> 作品資料庫</button>
                    <button className="nav-btn ${activeTab === 'tags' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { if (activeTab !== 'tags') pushHistory(); setActiveTab('tags'); }}><${Tag} size=${16} /> 標籤系統</button>
                    <button className="nav-btn ${activeTab === 'actors' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { if (activeTab !== 'actors') pushHistory(); setActiveTab('actors'); }}><${Users} size=${16} /> 演員資料庫</button>
                    <button className="nav-btn ${activeTab === 'fileOrganizer' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { if (activeTab !== 'fileOrganizer') pushHistory(); setActiveTab('fileOrganizer'); }}><${FolderCog} size=${16} /> 影片整理</button>
                    <button className="nav-btn ${activeTab === 'videoImport' ? 'active' : ''}" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { if (activeTab !== 'videoImport') pushHistory(); setActiveTab('videoImport'); }}><${FolderInput} size=${16} /> 影片匯入</button>
                </div>
                ${activeTab === 'works' && html`<div className="nav-actions"><button className="btn-primary" disabled=${viewMode === 'edit'} style=${viewMode === 'edit' ? { opacity: 0.4, cursor: 'not-allowed' } : {}} onClick=${() => { pushHistory(); setSelectedWorkId(null); setViewMode('edit'); }}><${Plus} size=${16} style=${{ marginRight: 4 }} /> 新增作品</button></div>`}
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: activeTab === 'works' ? 'block' : 'none' }}>
                ${(
            viewMode === 'edit' ? html`<${WorkEditor} initialWorkId=${selectedWorkId} setIsLoading=${setIsLoading} onCancel=${() => { pushHistory(); setViewMode('list'); }} onSaveSuccess=${() => { pushHistory(); setViewMode('list'); loadWorks(); }} />` :
                viewMode === 'details' ? html`<${WorkDetails} workId=${selectedWorkId}
                            uiFilters=${uiFilters}
                            setUiFilters=${setUiFilters}
                            onApply=${() => { pushHistory(); setAppliedFilters({ ...uiFilters }); setViewMode('list'); }}
                            onClear=${handleClearFilter}
                            onEdit=${(id) => { pushHistory(); setSelectedWorkId(id); setViewMode('edit'); }}
                            onNavigateToActor=${handleNavigateToActorDetails}
                            canGoBack=${navHistory.length > 0} onGoBack=${goBack} />` :
                    html`<div className="main-layout">
                        ${isSidebarOpen && html`<${WorkSidebar} uiFilters=${uiFilters} setUiFilters=${setUiFilters} onApply=${() => { pushHistory(); setAppliedFilters({ ...uiFilters }); }} onClear=${handleClearFilter} />`}
                        <div className="content-area" style=${{ padding: 0, overflowY: 'hidden' }}>
                        <div className="content-scroll" ref=${listContentRef} onScroll=${e => { listScrollPosRef.current = e.target.scrollTop; }}>
                            <div className="content-header" style=${{ alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px', height: 'auto', minHeight: '60px', padding: '16px 20px' }}>
                                <div style=${{ display: 'flex', alignItems: 'flex-start', flex: 1, minWidth: '300px' }}>
                                    <button className="btn-ghost" onClick=${() => setIsSidebarOpen(!isSidebarOpen)} title=${isSidebarOpen ? "隱藏側邊欄" : "顯示側邊欄"} style=${{ marginRight: '12px', marginTop: '2px' }}>
                                        <${PanelLeft} size=${20} />
                                    </button>
                                    <div style=${{ flex: 1 }}>
                                        <div className="result-info" style=${{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            ${navHistory.length > 0 && html`
                                                <button className="btn-ghost" onClick=${goBack} title="返回上一頁" style=${{ padding: '4px', display: 'flex', alignItems: 'center' }}>
                                                    <${ArrowLeft} size=${18} />
                                                </button>
                                            `}
                                            搜尋結果: 共${totalItems} 筆
                                        </div>
                                        <div style=${{ fontSize: '14px', color: '#666', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                            ${getSearchConditions().length === 0 ? html`<div style=${{ color: '#999', fontStyle: 'italic' }}>尚未搜尋</div>` : html`<div style=${{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                                ${getSearchConditions().map(cond => html`<div key=${cond.key} style=${{ display: 'inline-flex', alignItems: 'center', gap: '6px', backgroundColor: cond.exclude ? '#ffebee' : (cond.isOr ? '#fff3e0' : '#e3f2fd'), color: cond.exclude ? '#c62828' : (cond.isOr ? '#e65100' : '#0d47a1'), padding: cond.onRemove ? '6px 6px 6px 10px' : '6px 10px', borderRadius: '6px', fontWeight: '500', width: 'fit-content', border: cond.exclude ? '1px solid #ffcdd2' : (cond.isOr ? '1px solid #ffe0b2' : '1px solid #bbdefb') }}>
                                                    <span>${cond.label}</span>
                                                    ${cond.onRemove && html`<button className="btn-ghost" onClick=${cond.onRemove} title="移除此搜尋條件" style=${{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px', color: cond.exclude ? '#c62828' : (cond.isOr ? '#e65100' : '#0d47a1'), borderRadius: '4px' }}>
                                                        <${X} size=${14} />
                                                    </button>`}
                                                </div>`)}
                                            </div>`}
                                        </div>
                                    </div>
                                </div>
                                <div style=${{ display: 'flex', alignItems: 'flex-start' }}>
                                    <div style=${{ display: 'flex', alignItems: 'center', backgroundColor: '#f5f5f5', padding: '4px', borderRadius: '6px' }}>
                                        <button className="btn-ghost" onClick=${() => { pushHistory(); setSortOrder(toggleSortDirection(sortOrder)); }} title="反轉排序順序" style=${{ display: 'flex', alignItems: 'center', padding: '4px', margin: '0 4px' }}>
                                            <${ArrowUpDown} size=${16} color="#666" />
                                        </button>
                                        <select className="filter-input" style=${{ width: 'auto', padding: '6px 12px', cursor: 'pointer', marginRight: '8px', border: 'none', backgroundColor: 'transparent', fontWeight: 'bold' }} value=${sortOrder} onChange=${e => { pushHistory(); setSortOrder(e.target.value); }}>
                                            <option value="created_desc">新增時間 (新 → 舊)</option>
                                            <option value="created_asc">新增時間 (舊 → 新)</option>
                                            <option value="code_asc">識別碼 (A → Z)</option>
                                            <option value="code_desc">識別碼 (Z → A)</option>
                                            <option value="name_asc">作品名稱 (A → Z)</option>
                                            <option value="name_desc">作品名稱 (Z → A)</option>
                                            <option value="rating_desc">評分 (高 → 低)</option>
                                            <option value="rating_asc">評分 (低 → 高)</option>
                                            <option value="release_date_desc">發行日期 (新 → 舊)</option>
                                            <option value="release_date_asc">發行日期 (舊 → 新)</option>
                                        </select>
                                        <button className="btn-ghost" onClick=${handleBatchMoveId} title="將識別碼從名稱開頭移至尾端" style=${{ padding: '6px 10px', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                                            <${FileText} size=${16} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div className="card-grid">
                                ${works.map(w => html`<${WorkCard} key=${w.id} work=${w} onClick=${id => { pushHistory(); setSelectedWorkId(id); setViewMode('details'); }} />`)}
                            </div>
                        </div>
                        <div style=${{ flexShrink: 0, borderTop: '1px solid #eee', backgroundColor: '#fff' }}>
                            <${Pagination} currentPage=${currentPage} totalPages=${totalPages} onPageChange=${p => { pushHistory(); setCurrentPage(p); }} />
                        </div>
                        </div>
                    </div>`
        )}
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: activeTab === 'tags' ? 'block' : 'none' }}>
                <${TagSystem} canGoBack=${navHistory.length > 0} onGoBack=${goBack} />
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: activeTab === 'actors' ? 'block' : 'none' }}>
                <${ActorSystem} setIsLoading=${setIsLoading} onNavigateToWork=${handleActorQuickSearch} onNavigateToWorkDetails=${handleNavigateToWorkDetails}
                    uiFilters=${actorUiFilters} setUiFilters=${setActorUiFilters}
                    appliedFilters=${actorAppliedFilters} setAppliedFilters=${setActorAppliedFilters}
                    sortOrder=${actorSortOrder} setSortOrder=${setActorSortOrder}
                    viewMode=${actorViewMode} setViewMode=${setActorViewMode}
                    currentPage=${actorCurrentPage} setCurrentPage=${setActorCurrentPage}
                    contentRef=${actorContentRef} onContentScroll=${e => { actorScrollPosRef.current = e.target.scrollTop; }}
                    canGoBack=${navHistory.length > 0} onGoBack=${goBack}
                    pushHistory=${pushHistory} isRestoringRef=${isRestoringRef}
                    detailActorId=${actorDetailId}
                    setDetailActorId=${(id) => { setActorDetailId(id); setActorDetailFromWork(false); }}
                    isDetailFromExternalNav=${actorDetailFromWork}
                />
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: activeTab === 'fileOrganizer' ? 'block' : 'none' }}>
                <${FileOrganizerSystem} canGoBack=${navHistory.length > 0} onGoBack=${goBack} />
            </div>
            <div style=${{ flex: 1, overflow: 'hidden', display: activeTab === 'videoImport' ? 'block' : 'none' }}>
                <${VideoImportSystem} canGoBack=${navHistory.length > 0} onGoBack=${goBack} />
            </div>
        </div>`;
}

try {
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(html`<${ErrorBoundary}><${App} /></${ErrorBoundary}>`);
} catch (err) {
    document.body.innerHTML = `<div style="padding: 20px; color: red"><h1>Critical Error</h1><pre>${err.stack}</pre></div>`;
}