/**
 * feature-favorites.js
 * Star/unstar individual chat messages (per char+chat session) and the
 * Favorites panel listing them with preview text, jump-to-message, and
 * unstar-from-list.
 *
 * Moved from original index.js "Favorites" section (lines 14282-14398,
 * 117 lines).
 *
 * No injected forward-deps — every dependency it needs already exists.
 * This resolves ui-chat.js's remaining Favorites injection point; wire it
 * up during bootstrap:
 *
 *   import { setForwardDeps } from './ui/ui-chat.js';
 *   import { isMessageStarred, toggleStarMessage, renderFavoritesPanel } from './features/feature-favorites.js';
 *   setForwardDeps({ isMessageStarred, toggleStarMessage, renderFavoritesPanel });
 */

import { ICONS } from '../constants.js';
import { escHtml } from '../utils/util-dom.js';
import { getBindingKey } from '../utils/util-st.js';
import { getSettings, saveSettings } from '../settings.js';
import { getCurrentSession } from '../session.js';

export function getSessionFavKey() {
    const { charId, chatId } = getBindingKey();
    return `${charId}${chatId}`;
}

export function getStarredMessages() {
    const s = getSettings();
    const key = getSessionFavKey();
    if (!s.starredMessages[key]) s.starredMessages[key] = [];
    return s.starredMessages[key];
}

export function isMessageStarred(msgId) {
    return getStarredMessages().includes(msgId);
}

export function toggleStarMessage(msgId) {
    const s = getSettings();
    const key = getSessionFavKey();
    if (!s.starredMessages[key]) s.starredMessages[key] = [];
    const arr = s.starredMessages[key];
    const idx = arr.indexOf(msgId);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(msgId);
    saveSettings();
    return idx < 0; // true = now starred
}

export function renderFavoritesPanel() {
    const listEl = document.getElementById('scp-fav-list');
    const emptyEl = document.getElementById('scp-fav-empty');
    if (!listEl) return;

    const starredIds = getStarredMessages();
    const session = getCurrentSession();
    const starred = session.messages.filter(m => starredIds.includes(m.id));

    // Clear dynamic items
    listEl.querySelectorAll('.scp-fav-item').forEach(el => el.remove());

    if (!starred.length) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const frag = document.createDocumentFragment();
    starred.forEach(msg => {
        const item = document.createElement('div');
        item.className = 'scp-fav-item';
        item.dataset.msgId = msg.id;

        const raw = msg.content.replace(/```[\s\S]*?```/g, '[code]').replace(/<[^>]+>/g, '').trim();
        const preview = raw.length > 140 ? raw.slice(0, 140) + '…' : raw;
        const roleLabel = msg.role === 'user' ? 'User' : 'Copilot';
        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        item.innerHTML = `
            <span class="scp-fav-item-icon">${ICONS.starFill}</span>
            <div class="scp-fav-item-body">
                <div class="scp-fav-item-meta">
                    <span class="scp-fav-item-role">${escHtml(roleLabel)}</span>
                    <span>${escHtml(time)}</span>
                </div>
                <div class="scp-fav-item-text">${escHtml(preview)}</div>
            </div>
            <button class="scp-fav-item-remove" title="Remove from starred">✕</button>`;

        item.addEventListener('click', e => {
            if (e.target.classList.contains('scp-fav-item-remove')) return;
            closeFavoritesPanel();
            const msgEl = document.querySelector(`.scp-msg[data-id="${msg.id}"]`);
            if (!msgEl) return;
            msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            requestAnimationFrame(() => {
                msgEl.classList.remove('scp-msg-flash');
                void msgEl.offsetWidth;
                msgEl.classList.add('scp-msg-flash');
                msgEl.addEventListener('animationend', () => msgEl.classList.remove('scp-msg-flash'), { once: true });
            });
        });

        item.querySelector('.scp-fav-item-remove').addEventListener('click', e => {
            e.stopPropagation();
            toggleStarMessage(msg.id);
            const msgEl = document.querySelector(`.scp-msg[data-id="${msg.id}"]`);
            if (msgEl) {
                msgEl.classList.remove('scp-msg-starred');
                const btn = msgEl.querySelector('.scp-msg-btn-star');
                if (btn) { btn.classList.remove('starred'); btn.title = 'Star message'; }
            }
            renderFavoritesPanel();
        });

        frag.appendChild(item);
    });
    listEl.appendChild(frag);
}

export function openFavoritesPanel() {
    const panel = document.getElementById('scp-fav-panel');
    const btn = document.getElementById('scp-fav-btn');
    if (!panel) return;
    renderFavoritesPanel();
    panel.style.display = 'flex';
    btn?.classList.add('active');
}

export function closeFavoritesPanel() {
    const panel = document.getElementById('scp-fav-panel');
    const btn = document.getElementById('scp-fav-btn');
    if (panel) panel.style.display = 'none';
    btn?.classList.remove('active');
}
