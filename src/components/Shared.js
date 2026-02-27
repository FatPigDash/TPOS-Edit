const React = require('react');
const htm = require('htm');
const html = htm.bind(React.createElement);
const {
    X, AlertTriangle, Loader2, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight
} = require('lucide-react');

const { stopPropagation } = require('../utils/helpers');

// 3. 通用 UI元件 (Common Components)

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) { return { hasError: true, error }; }
    componentDidCatch(error, errorInfo) { console.error("ErrorBoundary caught an error", error, errorInfo); }
    render() {
        if (this.state.hasError) {
            return html`<div style=${{ padding: '20px', color: 'red', fontFamily: 'monospace' }}>
                <h1>發生錯誤 (Something went wrong)</h1>
                <pre>${this.state.error && this.state.error.toString()}</pre>
                <button onClick=${() => window.location.reload()}>重新載入</button>
            </div>`;
        }
        return this.props.children;
    }
}

function Modal({ title, onClose, children, footer }) {
    return html`<div className="modal-overlay" style=${{ zIndex: 2000 }}>
        <div className="modal-content" onClick=${stopPropagation}>
            <div className="modal-header">
                <span>${title}</span>
                <button className="btn-ghost" onClick=${onClose}><${X} size=${24} /></button>
            </div>
            <div className="modal-body">${children}</div>
            ${footer && html`<div className="modal-footer">${footer}</div>`}
        </div>
    </div>`;
}

function ConfirmModal({ title, message, onConfirm, onCancel, confirmText = "確認", cancelText = "取消", isDanger = false }) {
    return html`<div className="modal-overlay" style=${{ zIndex: 2100 }}>
        <div className="modal-content" style=${{ maxWidth: '400px' }} onClick=${stopPropagation}>
            <div className="modal-header">
                <span style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    ${isDanger && html`<${AlertTriangle} size=${20} color="#dc3545" />`} ${title}
                </span>
                <button className="btn-ghost" onClick=${onCancel}><${X} size=${24} /></button>
            </div>
            <div className="modal-body" style=${{ padding: '20px 0' }}>${message}</div>
            <div className="modal-footer">
                <button className="btn-block" onClick=${onCancel}>${cancelText}</button>
                <button className="${isDanger ? 'btn-block' : 'btn-primary'}" 
                    style=${isDanger ? { backgroundColor: '#dc3545', color: 'white' } : {}} 
                    onClick=${onConfirm}>${confirmText}</button>
            </div>
        </div>
    </div>`;
}

function ImageViewerModal({ src, onClose }) {
    if (!src) return null;
    return html`<div className="modal-overlay" onClick=${onClose} style=${{ backgroundColor: 'rgba(0,0,0,0.9)', zIndex: 9999 }}>
        <div style=${{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh', display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick=${stopPropagation}>
            <img src="${src}" style=${{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain', borderRadius: '4px', boxShadow: '0 0 20px rgba(0,0,0,0.5)' }} />
            <button onClick=${onClose} style=${{ position: 'absolute', top: '-40px', right: '-40px', background: 'none', border: 'none', color: 'white', cursor: 'pointer' }}>
                <${X} size=${32} />
            </button>
        </div>
    </div>`;
}

function LoadingOverlay({ show, message = "正在處理中..." }) {
    if (!show) return null;
    return html`<div className="modal-overlay" style=${{ backgroundColor: 'rgba(255, 255, 255, 0.8)', zIndex: 9999, flexDirection: 'column' }}>
        <div className="spinner"><${Loader2} size=${48} className="spin-anim" /></div>
        <div style=${{ marginTop: 16, fontSize: '18px', color: '#333', fontWeight: 'bold' }}>${message}</div>
    </div>`;
}

function SearchHelpText() {
    return html`<div style=${{ fontSize: '12px', color: '#888', marginTop: '4px', lineHeight: 1.4 }}>說明: + = AND, | = OR, - = NOT (空格視為文字)<br />字串中的「-」視為一般文字 (如 ABC-123)</div>`;
}

function CodeSearchHelpText() {
    return html`<div style=${{ fontSize: '12px', color: '#888', marginTop: '4px', lineHeight: 1.4 }}>說明: 空格分段, | = OR<br />開頭「-」= NOT, 開頭「+」= AND (字串內「-」視為文字)</div>`;
}

function Pagination({ currentPage, totalPages, onPageChange }) {
    if (totalPages <= 1) return null;
    let startPage = Math.max(1, currentPage - 4);
    let endPage = Math.min(totalPages, startPage + 9);
    if (endPage - startPage < 9) startPage = Math.max(1, endPage - 9);

    const pages = [];
    for (let i = startPage; i <= endPage; i++) pages.push(i);

    const handleJump = (e) => {
        if (e.key === 'Enter') {
            let p = parseInt(e.target.value);
            if (!isNaN(p)) {
                p = Math.max(1, Math.min(totalPages, p));
                onPageChange(p);
                e.target.value = "";
            }
        }
    };

    return html`
        <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 0', justifyContent: 'center' }}>
            <button className="nav-btn" disabled=${currentPage === 1} onClick=${() => onPageChange(1)}><${ChevronFirst} size=${16} /> 第一頁</button>
            <button className="nav-btn" disabled=${currentPage === 1} onClick=${() => onPageChange(currentPage - 1)}><${ChevronLeft} size=${16} /> 上一頁</button>
            
            ${pages.map(p => html`<button key=${p} className="nav-btn ${currentPage === p ? 'active' : ''}" style=${{ minWidth: '32px', justifyContent: 'center' }} onClick=${() => onPageChange(p)}>${p}</button>`)}
            
            ${endPage < totalPages && html`<span style=${{ margin: '0 4px' }}>...</span><span style=${{ fontSize: '14px' }}>${totalPages}</span>`}
            
            <button className="nav-btn" disabled=${currentPage === totalPages} onClick=${() => onPageChange(currentPage + 1)}>下一頁 <${ChevronRight} size=${16} /></button>
            <button className="nav-btn" disabled=${currentPage === totalPages} onClick=${() => onPageChange(totalPages)}>最尾頁 <${ChevronLast} size=${16} /></button>
            
            <div style=${{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '12px' }}>
                <span style=${{ fontSize: '14px' }}>跳至</span>
                <input type="number" min="1" max=${totalPages} className="filter-input" style=${{ width: '60px', padding: '4px', textAlign: 'center' }} onKeyDown=${handleJump} placeholder="頁碼" />
                <span style=${{ fontSize: '14px' }}>頁</span>
            </div>
        </div>`;
}

module.exports = {
    ErrorBoundary,
    Modal,
    ConfirmModal,
    ImageViewerModal,
    LoadingOverlay,
    SearchHelpText,
    CodeSearchHelpText,
    Pagination
};