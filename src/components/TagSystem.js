const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const {
    Plus, MoreVertical, X, Palette, Trash2
} = require('lucide-react');

const { db } = require('../utils/db');
const {
    hexToRgb, getDragAfterElement, stopPropagation
} = require('../utils/helpers');
const { Modal } = require('./Shared');

const PRESET_COLORS = [
    '#FF6B6B', '#FF9F43', '#FECA57', '#1DD1A1',
    '#48DBFB', '#5F27CD', '#FF9FF3', '#576574'
];

// 7. 標籤系統元件 (Tag System)

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

function TagSystem() {
    const [groups, setGroups] = React.useState([]);
    const [isAddingGroup, setIsAddingGroup] = React.useState(false);
    const [addingTagGroupId, setAddingTagGroupId] = React.useState(null);
    const [editingTarget, setEditingTarget] = React.useState(null);
    const [editValue, setEditValue] = React.useState("");
    const [draggingItem, setDraggingItem] = React.useState(null);
    const [deletingTag, setDeletingTag] = React.useState(null);
    const [menuOpenTagId, setMenuOpenTagId] = React.useState(null);
    const [menuOpenGroupId, setMenuOpenGroupId] = React.useState(null);
    const [dropTarget, setDropTarget] = React.useState(null);
    const [pendingColor, setPendingColor] = React.useState(null);
    const boardRef = React.useRef(null);
    const dragScrollRef = React.useRef({ isDown: false, startX: 0, scrollLeft: 0 });
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
            const t = db.prepare('SELECT * FROM tags WHERE is_visible = 1 ORDER BY sort_order ASC').all();
            setGroups(g.map(grp => ({ ...grp, tags: t.filter(tag => tag.group_id === grp.id) })));
        } catch (err) { console.error(err); }
    };

    React.useEffect(() => { loadTags(); }, []);
    React.useEffect(() => { if (isAddingGroup) addGroupInputRef.current?.focus(); }, [isAddingGroup]);
    React.useEffect(() => { if (addingTagGroupId) addTagInputRef.current?.focus(); }, [addingTagGroupId]);
    React.useEffect(() => { if (editingTarget) editInputRef.current?.focus(); }, [editingTarget]);

    React.useEffect(() => {
        const handleMouseMove = (e) => {
            if (!dragScrollRef.current.isDown || !boardRef.current) return;
            e.preventDefault();
            const x = e.pageX - boardRef.current.offsetLeft;
            const walk = (x - dragScrollRef.current.startX) * 1.5;
            boardRef.current.scrollLeft = dragScrollRef.current.scrollLeft - walk;
        };
        const handleMouseUp = () => { dragScrollRef.current.isDown = false; if (boardRef.current) boardRef.current.style.cursor = 'default'; };
        const handleClickOutside = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpenTagId(null);
            if (groupMenuRef.current && !groupMenuRef.current.contains(e.target)) setMenuOpenGroupId(null);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    const handleOpenGroupMenu = (group, e) => {
        e.stopPropagation();
        if (menuOpenGroupId === group.id) setMenuOpenGroupId(null);
        else { setMenuOpenGroupId(group.id); setMenuOpenTagId(null); setPendingColor(group.color || null); }
    };

    const handleOpenTagMenu = (tag, e) => {
        e.stopPropagation();
        if (menuOpenTagId === tag.id) setMenuOpenTagId(null);
        else { setMenuOpenTagId(tag.id); setMenuOpenGroupId(null); setPendingColor(tag.color || null); }
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

    const handleDragStart = (e, type, item) => {
        if (editingTarget || e.target.tagName === 'INPUT') { e.preventDefault(); return; }
        e.stopPropagation();
        setDraggingItem({ type, ...item });
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({ type, id: item.id }));
    };

    const handleDragEnd = () => { setDraggingItem(null); setDropTarget(null); };

    const handleDragOver = (e, type, id, groupId) => {
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const now = Date.now();
        if (now - lastDragOverTime.current < 50) return;
        lastDragOverTime.current = now;

        if (draggingItem && draggingItem.id !== id) {
            if (!dropTarget || dropTarget.id !== id) setDropTarget({ type, id, groupId });
        }
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
            const count = groups.find(g => g.id === targetGroupId).tags.length;
            db.prepare('UPDATE tags SET group_id = ?, sort_order = ? WHERE id = ?').run(targetGroupId, count + 1, draggingItem.id);
            loadTags();
        }
        setDraggingItem(null); setDropTarget(null);
    };

    const handleDropTag = (e, targetTagId, targetGroupId) => {
        e.preventDefault(); e.stopPropagation();
        if (!draggingItem || draggingItem.type !== 'tag' || draggingItem.id === targetTagId) return;

        db.transaction(() => {
            if (draggingItem.group_id !== targetGroupId) db.prepare('UPDATE tags SET group_id = ? WHERE id = ?').run(targetGroupId, draggingItem.id);
            const currentTags = db.prepare('SELECT * FROM tags WHERE group_id = ? AND is_visible = 1 ORDER BY sort_order ASC').all(targetGroupId);
            const filtered = currentTags.filter(t => t.id !== draggingItem.id);
            let newHoverIdx = filtered.findIndex(t => t.id === targetTagId);
            if (newHoverIdx === -1) newHoverIdx = filtered.length;
            filtered.splice(newHoverIdx, 0, { id: draggingItem.id });
            const stmt = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?');
            filtered.forEach((t, idx) => stmt.run(idx + 1, t.id));
        })();
        loadTags(); setDraggingItem(null); setDropTarget(null);
    };

    const handleListDragOver = (e, groupId) => {
        e.preventDefault(); e.stopPropagation();
        if (!draggingItem || draggingItem.type !== 'tag') return;
        const container = e.currentTarget;
        const rect = container.getBoundingClientRect();
        const scrollThreshold = 80;
        const scrollSpeed = 15;

        if (e.clientY < rect.top + scrollThreshold) { container.scrollTop -= scrollSpeed; }
        else if (e.clientY > rect.bottom - scrollThreshold) { container.scrollTop += scrollSpeed; }

        const now = Date.now();
        if (now - lastDragOverTime.current < 50) return;
        lastDragOverTime.current = now;

        const afterElement = getDragAfterElement(container, e.clientY);
        if (afterElement) {
            const targetId = parseInt(afterElement.getAttribute('data-id'));
            if (targetId && targetId !== draggingItem.id) {
                if (!dropTarget || dropTarget.id !== targetId) setDropTarget({ type: 'tag', id: targetId, groupId });
            }
        } else {
            if (!dropTarget || dropTarget.id !== -1) setDropTarget({ type: 'tag', id: -1, groupId });
        }
    };

    const handleListDrop = (e, groupId) => {
        e.preventDefault(); e.stopPropagation();
        if (!draggingItem || draggingItem.type !== 'tag') return;
        const container = e.currentTarget;
        const afterElement = getDragAfterElement(container, e.clientY);

        if (afterElement) handleDropTag(e, parseInt(afterElement.getAttribute('data-id')), groupId);
        else {
            db.transaction(() => {
                if (draggingItem.group_id !== groupId) db.prepare('UPDATE tags SET group_id = ? WHERE id = ?').run(groupId, draggingItem.id);
                const currentTags = db.prepare('SELECT * FROM tags WHERE group_id = ? AND is_visible = 1 ORDER BY sort_order ASC').all(groupId);
                const filtered = currentTags.filter(t => t.id !== draggingItem.id);
                filtered.push({ id: draggingItem.id });
                const stmt = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?');
                filtered.forEach((t, idx) => stmt.run(idx + 1, t.id));
            })();
            loadTags(); setDraggingItem(null); setDropTarget(null);
        }
    };

    const handleBoardMouseDown = (e) => {
        if (e.button === 2) {
            dragScrollRef.current.isDown = true;
            dragScrollRef.current.startX = e.pageX - boardRef.current.offsetLeft;
            dragScrollRef.current.scrollLeft = boardRef.current.scrollLeft;
            boardRef.current.style.cursor = 'grabbing';
        }
    };

    const inputProps = { className: "quick-input", autoFocus: true, onClick: e => e.stopPropagation(), onDragStart: (e) => e.preventDefault(), onMouseDown: (e) => e.stopPropagation() };

    return html`
        <div className="tag-board" ref=${boardRef} onMouseDown=${handleBoardMouseDown} onContextMenu=${e => e.preventDefault()}>
            ${groups.map(group => {
                const isGroupEditing = editingTarget?.type === 'group' && editingTarget.id === group.id;
                const isGroupMenuOpen = menuOpenGroupId === group.id;
                const groupStyle = group.color ? { backgroundColor: group.color } : {};
                const menuBtnStyle = group.color ? { backgroundColor: '#fff', border: '1px solid rgba(0,0,0,0.2)', borderRadius: 4, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 } : {};

                return html`
                <div className="tag-group ${draggingItem?.type === 'group' && draggingItem.id === group.id ? 'dragging' : ''}" style=${groupStyle} key=${group.id} draggable=${!isGroupEditing} onDragStart=${e => handleDragStart(e, 'group', group)} onDragEnd=${handleDragEnd} onDragOver=${e => handleDragOver(e, 'group', group.id, null)} onDrop=${e => handleDropGroup(e, group.id)}>
                    <div className="tag-group-header">
                        ${isGroupEditing ?
                            html`<input ref=${editInputRef} {...inputProps} value=${editValue} onInput=${e => setEditValue(e.target.value)} onBlur=${submitEdit} onKeyDown=${e => e.key === 'Enter' && submitEdit()} />` :
                            html`<span style=${{ flex: 1 }} onClick=${() => startEditing('group', group.id, group.name)}>${group.name}</span>`
                        }
                        <div style=${{ position: 'relative' }}>
                            <button className="btn-ghost ${isGroupMenuOpen ? 'active' : ''}" style=${menuBtnStyle} onClick=${e => handleOpenGroupMenu(group, e)}>
                                <${MoreVertical} size=${16} />
                            </button>
                            ${isGroupMenuOpen && html`
                                <div className="kebab-menu" ref=${groupMenuRef} onClick=${stopPropagation} style=${{ width: 220 }}>
                                    <div className="tag-menu-section">
                                        <div style=${{ fontSize: 12, color: '#666', marginBottom: 4 }}>標籤顏色</div>
                                        <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                                            ${PRESET_COLORS.map(color => html`<div style=${{ width: 20, height: 20, borderRadius: 4, backgroundColor: color, cursor: 'pointer', border: pendingColor === color ? '2px solid #333' : '1px solid #ddd' }} onClick=${() => setPendingColor(color)} />`)}
                                            <div style=${{ width: 20, height: 20, borderRadius: 4, background: 'linear-gradient(135deg, #fff 0%, #eee 100%)', cursor: 'pointer', border: pendingColor === null ? '2px solid #333' : '1px solid #ddd', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick=${() => setPendingColor(null)} title="清除顏色"><${X} size=${12}/></div>
                                        </div>
                                        <div className="tag-menu-item" style=${{ border: '1px solid #ddd' }} onClick=${() => groupColorInputRef.current.click()}><${Palette} size=${14}/> 自訂顏色<input ref=${groupColorInputRef} type="color" style=${{ visibility: 'hidden', width: 0, height: 0, position: 'absolute' }} onChange=${e => setPendingColor(e.target.value)} /></div>
                                        <div style=${{ fontSize: 12, color: '#666', marginTop: 4 }}>選定: ${hexToRgb(pendingColor)}</div>
                                        <div style=${{ display: 'flex', gap: 4, marginTop: 8 }}> <button className="btn-primary" style=${{ flex: 1, padding: '4px 8px', fontSize: 12 }} onClick=${() => saveGroupColor(group.id)}>確定</button> <button className="btn-block" style=${{ flex: 1, padding: '4px 8px', fontSize: 12 }} onClick=${() => setMenuOpenGroupId(null)}>取消</button></div>
                                    </div>
                                    <div className="tag-menu-item delete" style=${{ borderTop: '1px solid #ddd', marginTop: 4 }} onClick=${() => handleDeleteGroup(group.id)}><${Trash2} size=${14} /> 刪除組別</div>
                                </div>
                            `}
                        </div>
                    </div>
                    <div className="tag-list" onDragOver=${e => handleListDragOver(e, group.id)} onDrop=${e => handleListDrop(e, group.id)}>
                        ${group.tags.map(tag => {
                            const isTagEditing = editingTarget?.type === 'tag' && editingTarget.id === tag.id;
                            const isMenuOpen = menuOpenTagId === tag.id;
                            const tagStyle = tag.color ? { backgroundColor: tag.color } : {};
                            const tagMenuBtnStyle = tag.color ? { backgroundColor: '#fff', border: '1px solid rgba(0,0,0,0.2)', borderRadius: 4 } : {};

                            return html`
                            ${dropTarget?.type === 'tag' && dropTarget.id === tag.id && dropTarget.groupId === group.id && html`<div className="drop-placeholder" />`}
                            <div className="tag-item ${draggingItem?.id === tag.id ? 'dragging' : ''}" style=${tagStyle} key=${tag.id} data-id=${tag.id} draggable=${!isTagEditing} onDragStart=${e => handleDragStart(e, 'tag', tag)} onDragEnd=${handleDragEnd} onDragOver=${e => handleDragOver(e, 'tag', tag.id, group.id)} onDrop=${e => handleDropTag(e, tag.id, group.id)}>
                                ${isTagEditing ?
                                    html`<input ref=${editInputRef} {...inputProps} value=${editValue} onInput=${e => setEditValue(e.target.value)} onBlur=${submitEdit} onKeyDown=${e => e.key === 'Enter' && submitEdit()} />` :
                                    html`<span style=${{ flex: 1 }} onClick=${() => startEditing('tag', tag.id, tag.name)}>${tag.name}</span>`
                                }
                                <div style=${{ position: 'relative' }}>
                                    <button className="tag-menu-btn ${isMenuOpen ? 'active' : ''}" style=${tagMenuBtnStyle} onClick=${e => handleOpenTagMenu(tag, e)}><${MoreVertical} size=${14} /></button>
                                    ${isMenuOpen && html`
                                        <div className="kebab-menu" ref=${menuRef} onClick=${stopPropagation} style=${{ width: 220 }}>
                                            <div className="tag-menu-section">
                                                <div style=${{ fontSize: 12, color: '#666', marginBottom: 4 }}>標籤顏色</div>
                                                <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                                                    ${PRESET_COLORS.map(color => html`<div style=${{ width: 20, height: 20, borderRadius: 4, backgroundColor: color, cursor: 'pointer', border: pendingColor === color ? '2px solid #333' : '1px solid #ddd' }} onClick=${() => setPendingColor(color)} />`)}
                                                    <div style=${{ width: 20, height: 20, borderRadius: 4, background: 'linear-gradient(135deg, #fff 0%, #eee 100%)', cursor: 'pointer', border: pendingColor === null ? '2px solid #333' : '1px solid #ddd', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick=${() => setPendingColor(null)} title="清除顏色"><${X} size=${12}/></div>
                                                </div>
                                                <div className="tag-menu-item" style=${{ border: '1px solid #ddd' }} onClick=${() => colorInputRef.current.click()}><${Palette} size=${14}/> 自訂顏色<input ref=${colorInputRef} type="color" style=${{ visibility: 'hidden', width: 0, height: 0, position: 'absolute' }} onChange=${e => setPendingColor(e.target.value)} /></div>
                                                <div style=${{ fontSize: 12, color: '#666', marginTop: 4 }}>選定: ${hexToRgb(pendingColor)}</div>
                                                <div style=${{ display: 'flex', gap: 4, marginTop: 8 }}> <button className="btn-primary" style=${{ flex: 1, padding: '4px 8px', fontSize: 12 }} onClick=${() => saveTagColor(tag.id)}>確定</button> <button className="btn-block" style=${{ flex: 1, padding: '4px 8px', fontSize: 12 }} onClick=${() => setMenuOpenTagId(null)}>取消</button></div>
                                            </div>
                                            <div className="tag-menu-item delete" style=${{ borderTop: '1px solid #ddd', marginTop: 4 }} onClick=${() => handleDeleteTag(tag)}><${Trash2} size=${14} /> 刪除標籤</div>
                                        </div>
                                    `}
                                </div>
                            </div>`;
                        })}
                        ${dropTarget?.id === -1 && dropTarget.groupId === group.id && html`<div className="drop-placeholder" />`}
                    </div>
                    <div className="add-btn-area">
                        ${addingTagGroupId === group.id ?
                            html`<input ref=${addTagInputRef} {...inputProps} placeholder="輸入標籤..." onKeyDown=${e => handleCreateTag(e, group.id)} onBlur=${() => setAddingTagGroupId(null)} />` :
                            html`<button className="btn-block" onClick=${() => setAddingTagGroupId(group.id)}><${Plus} size=${16} style=${{ marginRight: 4 }} /> 新增標籤</button>`
                        }
                    </div>
                </div>`;
            })}
            <div style=${{ flexShrink: 0 }}>
                <div className="add-group-btn" onClick=${() => setIsAddingGroup(true)}>
                    ${isAddingGroup ?
                        html`<input ref=${addGroupInputRef} {...inputProps} placeholder="輸入組別名稱..." onKeyDown=${handleCreateGroup} onBlur=${() => setIsAddingGroup(false)} />` :
                        html`<div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'default' }} onMouseDown=${(e) => e.preventDefault()}><${Plus} size=${20} /> 新增組別</div>`
                    }
                </div>
            </div>
            ${deletingTag && html`<${TagDeleteModal} tagId=${deletingTag.id} tagName=${deletingTag.name} onClose=${() => setDeletingTag(null)} onDeleteSuccess=${loadTags} />`}
        </div>`;
}

module.exports = { TagSystem };