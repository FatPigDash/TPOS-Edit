const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const {
    Plus, MoreVertical, X, Palette, Trash2, ArrowLeft
} = require('lucide-react');

const { db } = require('../utils/db');
const {
    hexToRgb, stopPropagation, getContrastYIQ
} = require('../utils/helpers');
const { Modal } = require('./Shared');

const PRESET_COLORS = [
    '#FF6B6B', '#FF9F43', '#FECA57', '#1DD1A1',
    '#48DBFB', '#5F27CD', '#FF9FF3', '#576574'
];

// 7. 標籤系統元件 (Tag System) — 欄位/整列呈現 (放棄看板模式)

function TagDeleteModal({ tagId, tagName, onClose, onDeleteSuccess }) {
    const [usageCount, setUsageCount] = React.useState(0);

    React.useEffect(() => {
        if (!db) return;
        try { setUsageCount(db.prepare('SELECT COUNT(*) as count FROM work_tag_link WHERE tag_id = ?').get(tagId).count); } catch (e) { console.error(e); }
    }, [tagId]);

    const handleHardDelete = () => {
        if (!db || !confirm(`將從${usageCount}個作品中永久移除標籤「${tagName}」, 此操作無法復原, 確認刪除?`)) return;
        try {
            db.prepare('DELETE FROM work_tag_link WHERE tag_id = ?').run(tagId);
            db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
            onDeleteSuccess(); onClose();
        } catch (e) { alert(e.message); }
    };

    const handleSoftDelete = () => {
        if (!db) return;
        try { db.prepare('UPDATE tags SET is_visible = 0 WHERE id = ?').run(tagId); onDeleteSuccess(); onClose(); } catch (e) { alert(e.message); }
    };

    return html`
        <${Modal} title="刪除標籤" onClose=${onClose}>
            <div style=${{ padding: '20px 0' }}>
                <p>目前有 <strong>${usageCount}</strong> 個作品正在使用此標籤。</p>
                <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '20px' }}>
                    <button className="btn-block" style=${{ backgroundColor: '#dc3545', color: 'white' }} onClick=${handleHardDelete}>自所有作品移除並刪除標籤</button>
                    <button className="btn-block" style=${{ backgroundColor: '#6c757d', color: 'white' }} onClick=${handleSoftDelete}>刪除標籤但保留現有作品設定</button>
                    <button className="btn-block" onClick=${onClose}>取消動作</button>
                </div>
            </div>
        <//>`;
}

function TagSystem({ canGoBack, onGoBack }) {
    const [groups, setGroups] = React.useState([]);
    const [isAddingGroup, setIsAddingGroup] = React.useState(false);
    const [addingTagGroupId, setAddingTagGroupId] = React.useState(null);
    const [editingTarget, setEditingTarget] = React.useState(null);
    const [editValue, setEditValue] = React.useState("");
    const [draggingItem, setDraggingItem] = React.useState(null);
    const [deletingTag, setDeletingTag] = React.useState(null);

    // 選單控制與位置計算
    const [menuOpenTagId, setMenuOpenTagId] = React.useState(null);
    const [menuOpenGroupId, setMenuOpenGroupId] = React.useState(null);
    const [menuPos, setMenuPos] = React.useState({ x: 0, y: 0 });

    const [dropTarget, setDropTarget] = React.useState(null);
    const [pendingColor, setPendingColor] = React.useState(null);
    const [copiedColor, setCopiedColor] = React.useState(null);
    const boardRef = React.useRef(null);
    const lastDragOverTime = React.useRef(0);
    const addGroupInputRef = React.useRef(null);
    const addTagInputRef = React.useRef(null);
    const editInputRef = React.useRef(null);
    const menuRef = React.useRef(null);
    const groupMenuRef = React.useRef(null);
    const colorInputRef = React.useRef(null);
    const groupColorInputRef = React.useRef(null);

    const loadTags = () => {
        if (!db) return;
        try {
            const g = db.prepare('SELECT * FROM tag_groups ORDER BY sort_order ASC').all();
            const t = db.prepare(`
                SELECT tags.*, (SELECT COUNT(*) FROM work_tag_link wtl WHERE wtl.tag_id = tags.id) as usage_count
                FROM tags WHERE is_visible = 1 ORDER BY sort_order ASC
            `).all();
            setGroups(g.map(grp => ({ ...grp, tags: t.filter(tag => tag.group_id === grp.id) })));
            // 通知其他常駐元件 (如作品篩選側欄) 標籤資料已變更，需重新載入
            window.dispatchEvent(new Event('tags-changed'));
        } catch (err) { console.error(err); }
    };

    React.useEffect(() => { loadTags(); }, []);
    React.useEffect(() => { if (isAddingGroup) addGroupInputRef.current?.focus(); }, [isAddingGroup]);
    React.useEffect(() => { if (addingTagGroupId) addTagInputRef.current?.focus(); }, [addingTagGroupId]);
    React.useEffect(() => { if (editingTarget) editInputRef.current?.focus(); }, [editingTarget]);

    React.useEffect(() => {
        const handleClickOutside = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpenTagId(null);
            if (groupMenuRef.current && !groupMenuRef.current.contains(e.target)) setMenuOpenGroupId(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleScroll = () => {
        // 外層捲動時自動關閉選單，避免選單浮在畫面上
        if (menuOpenGroupId || menuOpenTagId) {
            setMenuOpenGroupId(null);
            setMenuOpenTagId(null);
        }
    };

    const handleOpenGroupMenu = (group, e) => {
        e.stopPropagation();
        if (menuOpenGroupId === group.id) setMenuOpenGroupId(null);
        else {
            const rect = e.currentTarget.getBoundingClientRect();
            let x = rect.left;
            let y = rect.bottom + 4;
            // 邊界偵測：若太靠右邊則往左推
            if (x + 240 > window.innerWidth) x = window.innerWidth - 250;
            // 邊界偵測：若太靠下方則往上彈出
            if (y + 250 > window.innerHeight) y = rect.top - 250;

            setMenuPos({ x, y });
            setMenuOpenGroupId(group.id);
            setMenuOpenTagId(null);
            setPendingColor(group.color || null);
        }
    };

    const handleOpenTagMenu = (tag, e) => {
        e.stopPropagation();
        if (menuOpenTagId === tag.id) setMenuOpenTagId(null);
        else {
            const rect = e.currentTarget.getBoundingClientRect();
            let x = rect.left;
            let y = rect.bottom + 4;
            // 邊界偵測：若太靠右邊則往左推
            if (x + 240 > window.innerWidth) x = window.innerWidth - 250;
            // 邊界偵測：若太靠下方則往上彈出
            if (y + 250 > window.innerHeight) y = rect.top - 250;

            setMenuPos({ x, y });
            setMenuOpenTagId(tag.id);
            setMenuOpenGroupId(null);
            setPendingColor(tag.color || null);
        }
    };

    const handleCreateGroup = (e) => {
        if (!db) return;
        if (e.key === 'Enter' && e.target.value.trim()) {
            db.prepare('INSERT INTO tag_groups (name, sort_order) VALUES (?, ?)').run(e.target.value.trim(), groups.length + 1);
            setIsAddingGroup(false); loadTags();
        } else if (e.key === 'Escape') setIsAddingGroup(false);
    };

    const handleCreateTag = (e, groupId) => {
        if (!db) return;
        if (e.key === 'Enter' && e.target.value.trim()) {
            const count = groups.find(g => g.id === groupId).tags.length;
            db.prepare('INSERT INTO tags (group_id, name, sort_order) VALUES (?, ?, ?)').run(groupId, e.target.value.trim(), count + 1);
            setAddingTagGroupId(null); loadTags();
        } else if (e.key === 'Escape') setAddingTagGroupId(null);
    };

    const handleDeleteTag = (tag) => { setMenuOpenTagId(null); setDeletingTag(tag); };

    const saveTagColor = (tagId) => {
        db.prepare("UPDATE tags SET color = ? WHERE id = ?").run(pendingColor, tagId);
        loadTags(); setMenuOpenTagId(null);
    };

    const saveGroupColor = (groupId) => {
        db.prepare("UPDATE tag_groups SET color = ? WHERE id = ?").run(pendingColor, groupId);
        loadTags(); setMenuOpenGroupId(null);
    };

    const handleDeleteGroup = (groupId) => {
        if (!db) return;
        const group = groups.find(g => g.id === groupId);
        if (group.tags.length > 0) return alert('請先清空或移動組內的標籤, 才能刪除此組別');
        if (confirm(`確定刪除組別「${group.name}」?`)) { db.prepare('DELETE FROM tag_groups WHERE id = ?').run(groupId); loadTags(); }
        setMenuOpenGroupId(null);
    };

    const startEditing = (type, id, initialValue) => { setEditingTarget({ type, id }); setEditValue(initialValue); };

    const submitEdit = () => {
        if (!db || !editingTarget) return;
        const val = editValue.trim();
        if (val) {
            const table = editingTarget.type === 'group' ? 'tag_groups' : 'tags';
            db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(val, editingTarget.id);
            loadTags(); setEditingTarget(null);
        }
    };

    // ---- 拖曳 (Drag & Drop) ----
    // 找出水平排列 (可換行) 之標籤中，游標應插入於「哪個標籤之前」；回傳 null 代表插入尾端
    const getTagInsertBefore = (container, x, y) => {
        const els = [...container.querySelectorAll('.tag-item:not(.dragging)')];
        for (const el of els) {
            const box = el.getBoundingClientRect();
            if (y < box.top) return el;                                  // 游標在此標籤所在列的上方
            if (y <= box.bottom && x < box.left + box.width / 2) return el; // 同一列且位於此標籤左半
        }
        return null;
    };

    const handleDragStart = (e, type, item) => {
        if (editingTarget || e.target.tagName === 'INPUT') { e.preventDefault(); return; }
        e.stopPropagation();
        setDraggingItem({ type, ...item });
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({ type, id: item.id }));
    };

    const handleDragEnd = () => { setDraggingItem(null); setDropTarget(null); };

    // 標籤組 (整列) 排序：以整列為單位垂直拖放
    const handleGroupDragOver = (e, groupId) => {
        if (!draggingItem || draggingItem.type !== 'group') return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (draggingItem.id === groupId) return;
        if (!dropTarget || dropTarget.type !== 'group' || dropTarget.id !== groupId) setDropTarget({ type: 'group', id: groupId });
    };

    const handleDropGroup = (e, targetGroupId) => {
        e.preventDefault(); e.stopPropagation();
        if (!draggingItem || !db) return;

        if (draggingItem.type === 'group' && draggingItem.id !== targetGroupId) {
            const newList = [...groups];
            const dragIdx = newList.findIndex(g => g.id === draggingItem.id);
            const hoverIdx = newList.findIndex(g => g.id === targetGroupId);
            const [removed] = newList.splice(dragIdx, 1);
            newList.splice(hoverIdx, 0, removed);
            const stmt = db.prepare('UPDATE tag_groups SET sort_order = ? WHERE id = ?');
            db.transaction(() => { newList.forEach((g, idx) => stmt.run(idx + 1, g.id)); })();
            loadTags();
        } else if (draggingItem.type === 'tag' && draggingItem.group_id !== targetGroupId) {
            // 將標籤拖放至某組別名稱欄 → 移動到該組別尾端
            const count = groups.find(g => g.id === targetGroupId).tags.length;
            db.prepare('UPDATE tags SET group_id = ?, sort_order = ? WHERE id = ?').run(targetGroupId, count + 1, draggingItem.id);
            loadTags();
        }
        setDraggingItem(null); setDropTarget(null);
    };

    // 標籤重新定位 (同組排序 / 跨組移動)：插入於 targetTagId 之前
    const reorderTagBefore = (targetTagId, targetGroupId) => {
        db.transaction(() => {
            if (draggingItem.group_id !== targetGroupId) db.prepare('UPDATE tags SET group_id = ? WHERE id = ?').run(targetGroupId, draggingItem.id);
            const currentTags = db.prepare('SELECT * FROM tags WHERE group_id = ? AND is_visible = 1 ORDER BY sort_order ASC').all(targetGroupId);
            const filtered = currentTags.filter(t => t.id !== draggingItem.id);
            let hoverIdx = filtered.findIndex(t => t.id === targetTagId);
            if (hoverIdx === -1) hoverIdx = filtered.length;
            filtered.splice(hoverIdx, 0, { id: draggingItem.id });
            const stmt = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?');
            filtered.forEach((t, idx) => stmt.run(idx + 1, t.id));
        })();
        loadTags(); setDraggingItem(null); setDropTarget(null);
    };

    const reorderTagToEnd = (targetGroupId) => {
        db.transaction(() => {
            if (draggingItem.group_id !== targetGroupId) db.prepare('UPDATE tags SET group_id = ? WHERE id = ?').run(targetGroupId, draggingItem.id);
            const currentTags = db.prepare('SELECT * FROM tags WHERE group_id = ? AND is_visible = 1 ORDER BY sort_order ASC').all(targetGroupId);
            const filtered = currentTags.filter(t => t.id !== draggingItem.id);
            filtered.push({ id: draggingItem.id });
            const stmt = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?');
            filtered.forEach((t, idx) => stmt.run(idx + 1, t.id));
        })();
        loadTags(); setDraggingItem(null); setDropTarget(null);
    };

    const handleTagsDragOver = (e, groupId) => {
        // 僅處理標籤拖曳；標籤組拖曳則讓事件冒泡到整列 (handleGroupDragOver)
        if (!draggingItem || draggingItem.type !== 'tag') return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const now = Date.now();
        if (now - lastDragOverTime.current < 50) return;
        lastDragOverTime.current = now;

        const before = getTagInsertBefore(e.currentTarget, e.clientX, e.clientY);
        if (before) {
            const targetId = parseInt(before.getAttribute('data-id'));
            if (targetId && targetId !== draggingItem.id) {
                if (!dropTarget || dropTarget.id !== targetId || dropTarget.groupId !== groupId) setDropTarget({ type: 'tag', id: targetId, groupId });
            }
        } else {
            if (!dropTarget || dropTarget.id !== -1 || dropTarget.groupId !== groupId) setDropTarget({ type: 'tag', id: -1, groupId });
        }
    };

    const handleTagsDrop = (e, groupId) => {
        if (!draggingItem || draggingItem.type !== 'tag') return;
        e.preventDefault(); e.stopPropagation();
        const before = getTagInsertBefore(e.currentTarget, e.clientX, e.clientY);
        if (before) {
            const targetId = parseInt(before.getAttribute('data-id'));
            if (targetId === draggingItem.id) { setDraggingItem(null); setDropTarget(null); return; }
            reorderTagBefore(targetId, groupId);
        } else {
            reorderTagToEnd(groupId);
        }
    };

    // 拖曳接近上/下緣時自動捲動整個列表
    const handleBoardDragOver = (e) => {
        if (!draggingItem || !boardRef.current) return;
        const rect = boardRef.current.getBoundingClientRect();
        const threshold = 60, speed = 14;
        if (e.clientY < rect.top + threshold) boardRef.current.scrollTop -= speed;
        else if (e.clientY > rect.bottom - threshold) boardRef.current.scrollTop += speed;
    };

    // 修正: 確保 input 輸入時文字為深色，不被外層顏色繼承污染
    const inputProps = { className: "quick-input", autoFocus: true, style: { color: '#333333' }, onClick: e => e.stopPropagation(), onDragStart: (e) => e.preventDefault(), onMouseDown: (e) => e.stopPropagation() };

    const renderColorMenu = (target, onApply, onCancel, onDelete, deleteLabel) => html`
        <div className="kebab-menu" ref=${target === 'group' ? groupMenuRef : menuRef} onClick=${stopPropagation} style=${{ position: 'fixed', top: menuPos.y, left: menuPos.x, zIndex: 9999, width: 240, backgroundColor: '#ffffff', color: '#333333', padding: '12px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', cursor: 'default', whiteSpace: 'normal', textAlign: 'left' }}>
            <div style=${{ fontSize: 13, fontWeight: 'bold', marginBottom: 8, borderBottom: '1px solid #eee', paddingBottom: 6 }}>${target === 'group' ? '群組設定' : '標籤設定'}</div>
            <div style=${{ fontSize: 12, color: '#666', marginBottom: 6 }}>顏色標記</div>
            <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                ${PRESET_COLORS.map(color => html`<div style=${{ width: 24, height: 24, borderRadius: 4, backgroundColor: color, cursor: 'pointer', border: pendingColor === color ? '2px solid #333' : '1px solid #ddd' }} onClick=${() => setPendingColor(color)} />`)}
                <div style=${{ width: 24, height: 24, borderRadius: 4, background: 'linear-gradient(135deg, #fff 0%, #eee 100%)', cursor: 'pointer', border: pendingColor === null ? '2px solid #333' : '1px solid #ddd', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick=${() => setPendingColor(null)} title="清除顏色"><${X} size=${14}/></div>
            </div>
            <button className="btn-block" style=${{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginBottom: '8px', padding: '6px', backgroundColor: '#f8f9fa', border: '1px solid #ddd' }} onClick=${() => (target === 'group' ? groupColorInputRef : colorInputRef).current.click()}>
                <${Palette} size=${14}/> 自訂顏色
                <input ref=${target === 'group' ? groupColorInputRef : colorInputRef} type="color" style=${{ visibility: 'hidden', width: 0, height: 0, position: 'absolute' }} onChange=${e => setPendingColor(e.target.value)} />
            </button>
            <div style=${{ fontSize: 12, color: '#666', marginBottom: 12, textAlign: 'center' }}>選定: ${hexToRgb(pendingColor)}</div>

            <div style=${{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button className="btn-block" style=${{ flex: 1, padding: '5px', fontSize: 12 }} onClick=${() => { if (pendingColor) { setCopiedColor(pendingColor); } }} title=${pendingColor ? `複製: ${pendingColor}` : '尚無顏色可複製'} disabled=${!pendingColor}>
                    複製代碼 ${pendingColor ? pendingColor.toUpperCase() : ''}
                </button>
                <button className="btn-block" style=${{ flex: 1, padding: '5px', fontSize: 12, opacity: copiedColor ? 1 : 0.45 }} onClick=${() => { if (copiedColor) setPendingColor(copiedColor); }} title=${copiedColor ? `貼上: ${copiedColor}` : '尚未複製顏色'} disabled=${!copiedColor}>
                    貼上代碼 ${copiedColor ? copiedColor.toUpperCase() : ''}
                </button>
            </div>
            <div style=${{ display: 'flex', gap: 8, marginBottom: 12, borderBottom: '1px solid #eee', paddingBottom: 12 }}>
                <button className="btn-primary" style=${{ flex: 1, padding: '6px' }} onClick=${onApply}>套用顏色</button>
                <button className="btn-block" style=${{ flex: 1, padding: '6px' }} onClick=${onCancel}>取消</button>
            </div>

            <button className="btn-block" style=${{ width: '100%', backgroundColor: '#dc3545', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '6px', border: 'none' }} onClick=${onDelete}>
                <${Trash2} size=${14} /> ${deleteLabel}
            </button>
        </div>`;

    return html`
        <div className="tag-system-wrap">
            <div className="tag-toolbar">
                ${canGoBack && html`
                    <button className="btn-ghost" onClick=${onGoBack} title="返回上一頁" style=${{ padding: '4px', display: 'flex', alignItems: 'center' }}>
                        <${ArrowLeft} size=${18} />
                    </button>
                `}
                ${isAddingGroup ?
            html`<input ref=${addGroupInputRef} ...${inputProps} placeholder="輸入組別名稱..." style=${{ color: '#333333', width: 240 }} onKeyDown=${handleCreateGroup} onBlur=${() => setIsAddingGroup(false)} />` :
            html`<button className="tag-add-group-btn" onClick=${() => setIsAddingGroup(true)}><${Plus} size=${18} /> 新增標籤組</button>`
        }
            </div>

            <div className="tag-board" ref=${boardRef} onScroll=${handleScroll} onDragOver=${handleBoardDragOver}>
                ${groups.map(group => {
            const isGroupEditing = editingTarget?.type === 'group' && editingTarget.id === group.id;
            const isGroupMenuOpen = menuOpenGroupId === group.id;
            const isGroupDragging = draggingItem?.type === 'group' && draggingItem.id === group.id;
            const isGroupDropTarget = dropTarget?.type === 'group' && dropTarget.id === group.id;

            // 套用高對比文字顏色 (群組名稱欄)
            const groupNameStyle = group.color ? { backgroundColor: group.color, color: getContrastYIQ(group.color) } : {};
            const menuBtnStyle = group.color ? { backgroundColor: '#fff', color: '#333', border: '1px solid rgba(0,0,0,0.2)', borderRadius: 4, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 } : {};

            return html`
                    <div className="tag-group-row ${isGroupDragging ? 'dragging' : ''} ${isGroupDropTarget ? 'drop-above' : ''}" key=${group.id}
                        onDragOver=${e => handleGroupDragOver(e, group.id)} onDrop=${e => handleDropGroup(e, group.id)}>

                        <div className="tag-group-name" style=${groupNameStyle} draggable=${!isGroupEditing}
                            onDragStart=${e => handleDragStart(e, 'group', group)} onDragEnd=${handleDragEnd}>
                            ${isGroupEditing ?
                    html`<input ref=${editInputRef} ...${inputProps} value=${editValue} onInput=${e => setEditValue(e.target.value)} onBlur=${submitEdit} onKeyDown=${e => e.key === 'Enter' && submitEdit()} />` :
                    html`<span style=${{ flex: 1 }} onClick=${() => startEditing('group', group.id, group.name)}>${group.name}</span>`
                }
                            <div>
                                <button className="btn-ghost ${isGroupMenuOpen ? 'active' : ''}" style=${menuBtnStyle} onClick=${e => handleOpenGroupMenu(group, e)}>
                                    <${MoreVertical} size=${16} />
                                </button>
                                ${isGroupMenuOpen && renderColorMenu('group', () => saveGroupColor(group.id), () => setMenuOpenGroupId(null), () => handleDeleteGroup(group.id), '刪除此群組')}
                            </div>
                        </div>

                        <div className="tag-group-tags" onDragOver=${e => handleTagsDragOver(e, group.id)} onDrop=${e => handleTagsDrop(e, group.id)}>
                            ${group.tags.map(tag => {
                    const isTagEditing = editingTarget?.type === 'tag' && editingTarget.id === tag.id;
                    const isMenuOpen = menuOpenTagId === tag.id;

                    // 修正: 如果沒有設定顏色，強制使用深灰色，避免顏色繼承問題
                    const tagStyle = tag.color ? { backgroundColor: tag.color, color: getContrastYIQ(tag.color), borderColor: 'transparent' } : { color: '#333333' };
                    const tagMenuBtnStyle = tag.color ? { backgroundColor: 'rgba(255,255,255,0.85)', color: '#333', border: '1px solid rgba(0,0,0,0.2)', borderRadius: 4 } : { color: '#333333' };

                    return html`
                                ${dropTarget?.type === 'tag' && dropTarget.id === tag.id && dropTarget.groupId === group.id && html`<div className="drop-placeholder" />`}
                                <div className="tag-item ${draggingItem?.type === 'tag' && draggingItem.id === tag.id ? 'dragging' : ''}" style=${tagStyle} key=${tag.id} data-id=${tag.id} draggable=${!isTagEditing}
                                    onDragStart=${e => handleDragStart(e, 'tag', tag)} onDragEnd=${handleDragEnd}>
                                    ${isTagEditing ?
                        html`<input ref=${editInputRef} ...${inputProps} value=${editValue} onInput=${e => setEditValue(e.target.value)} onBlur=${submitEdit} onKeyDown=${e => e.key === 'Enter' && submitEdit()} />` :
                        html`<span onClick=${() => startEditing('tag', tag.id, tag.name)}>${tag.name} (${tag.usage_count || 0})</span>`
                    }
                                    <div style=${{ display: 'flex', alignItems: 'center' }}>
                                        <button className="tag-menu-btn ${isMenuOpen ? 'active' : ''}" style=${tagMenuBtnStyle} onClick=${e => handleOpenTagMenu(tag, e)}><${MoreVertical} size=${14} /></button>
                                        ${isMenuOpen && renderColorMenu('tag', () => saveTagColor(tag.id), () => setMenuOpenTagId(null), () => handleDeleteTag(tag), '刪除此標籤')}
                                    </div>
                                </div>`;
                })}
                            ${dropTarget?.type === 'tag' && dropTarget.id === -1 && dropTarget.groupId === group.id && html`<div className="drop-placeholder" />`}

                            <div className="tag-add-area">
                                ${addingTagGroupId === group.id ?
                    html`<input ref=${addTagInputRef} ...${inputProps} placeholder="輸入標籤..." onKeyDown=${e => handleCreateTag(e, group.id)} onBlur=${() => setAddingTagGroupId(null)} />` :
                    html`<button className="btn-block tag-add-btn" onClick=${() => setAddingTagGroupId(group.id)}><${Plus} size=${16} style=${{ marginRight: 4 }} /> 新增標籤</button>`
                }
                            </div>
                        </div>
                    </div>`;
        })}

                ${groups.length === 0 && !isAddingGroup && html`
                    <div className="tag-empty-hint">尚無標籤組，點選上方「新增標籤組」開始建立。</div>
                `}
            </div>

            ${deletingTag && html`<${TagDeleteModal} tagId=${deletingTag.id} tagName=${deletingTag.name} onClose=${() => setDeletingTag(null)} onDeleteSuccess=${loadTags} />`}
        </div>`;
}

module.exports = { TagSystem };
