/**
 * util-dom.js
 * Small, dependency-free DOM helpers used all over the codebase: HTML
 * escaping, element lookup by id, textarea auto-resize, and clipboard copy.
 *
 * Moved from (original index.js line numbers, for reference during migration):
 *   - Custom Dialog        6086–6091  (escHtml)
 *   - DOM References       8266–8302  ($ helper only — see note below)
 *   - Clipboard Helper     9331–9351
 *   - Auto-resize textarea 12197–12200
 *   - showCustomDialog     6207–6274  (found nested under the "Color Picker"
 *     section marker, but it's a generic alert/confirm/prompt modal used in
 *     57 places across the codebase — belongs here, not with color-picking)
 *   - showSessionDialog    6253–6288  ("Session Dialog" section — never
 *     extracted into any module in earlier passes; same dialog-helper
 *     family as showCustomDialog directly above it, so it lives here too)
 *
 * NOTE: `injectUI()`, which used to live in the "DOM References" section
 * alongside `$`, is NOT here — it's a one-time bootstrap step that populates
 * windowEl/iconEl/modalEl in state.js, so it belongs in index.js (or a
 * dedicated bootstrap module) once that phase of the split happens, not in
 * a reusable utility file.
 */

import { EXT_DISPLAY } from '../constants.js';

// ─── HTML escaping ──────────────────────────────────────────────────────
export function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Element lookup ─────────────────────────────────────────────────────
export function $(id) { return document.getElementById(id); }

// ─── Textarea auto-resize ───────────────────────────────────────────────
export function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

// ─── Clipboard ──────────────────────────────────────────────────────────
export function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;width:1px;height:1px;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); toastr.success('Copied', EXT_DISPLAY); }
    catch (e) { toastr.error('Copy failed', EXT_DISPLAY); }
    ta.remove();
}

export function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(() => toastr.success('Copied', EXT_DISPLAY))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

// ─── Generic alert/confirm/prompt modal ──────────────────────────────────
export function showCustomDialog({ type = 'alert', title = '', message = '', htmlMessage = '', defaultValue = '', placeholder = '', delayConfirm = 0 }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'scp-dialog-overlay';
        const isPrompt = type === 'prompt';
        const isConfirm = type === 'confirm';
        overlay.innerHTML = `
            <div class="scp-dialog-box">
                ${title ? `<div class="scp-dialog-title">${escHtml(title)}</div>` : ''}
                ${message ? `<div class="scp-dialog-msg">${escHtml(message)}</div>` : (htmlMessage ? `<div class="scp-dialog-msg">${htmlMessage}</div>` : '')}
                ${isPrompt ? `<input type="text" class="scp-dialog-input" value="${escHtml(defaultValue)}" placeholder="${escHtml(placeholder)}">` : ''}
                <div class="scp-dialog-btns">
                    ${(isPrompt || isConfirm) ? `<button class="scp-dialog-btn scp-dialog-cancel">Cancel</button>` : ''}
                    <button class="scp-dialog-btn scp-dialog-ok${isConfirm ? ' danger' : ''}">${isConfirm ? 'Confirm' : 'OK'}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('.scp-dialog-input');
        const okBtn = overlay.querySelector('.scp-dialog-ok');
        const cancelBtn = overlay.querySelector('.scp-dialog-cancel');

        let timerIntv = null;
        let currentDelay = delayConfirm;
        const origOkText = okBtn.textContent;

        const close = val => {
            if (timerIntv) clearInterval(timerIntv);
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 150);
            resolve(val);
        };

        if (isConfirm && currentDelay > 0) {
            okBtn.disabled = true;
            okBtn.style.opacity = '0.5';
            okBtn.style.cursor = 'not-allowed';
            okBtn.textContent = `${origOkText} (${currentDelay})`;
            timerIntv = setInterval(() => {
                currentDelay--;
                if (currentDelay <= 0) {
                    clearInterval(timerIntv);
                    timerIntv = null;
                    okBtn.disabled = false;
                    okBtn.style.opacity = '1';
                    okBtn.style.cursor = '';
                    okBtn.textContent = origOkText;
                    if (!input) okBtn.focus();
                } else {
                    okBtn.textContent = `${origOkText} (${currentDelay})`;
                }
            }, 1000);
        }

        if (input) { input.focus(); input.select(); } else if (currentDelay <= 0) { setTimeout(() => okBtn.focus(), 50); }

        okBtn.addEventListener('click', () => { if (!okBtn.disabled) close(isPrompt ? input.value : true); });
        cancelBtn?.addEventListener('click', () => close(isPrompt ? null : false));
        let _dlgMouseDownTarget = null;
        overlay.addEventListener('mousedown', e => { _dlgMouseDownTarget = e.target; });
        overlay.addEventListener('click', e => { if (e.target === overlay && _dlgMouseDownTarget === overlay) close(isPrompt ? null : false); });
        const keyHandler = e => {
            if (e.key === 'Enter') { e.preventDefault(); if (!okBtn.disabled) close(isPrompt ? input.value : true); }
            if (e.key === 'Escape') close(isPrompt ? null : false);
        };
        (input || overlay).addEventListener('keydown', keyHandler);
        requestAnimationFrame(() => overlay.classList.add('visible'));
    });
}

// ─── Session Dialog (with temporary toggle) ──────────────────────────────────
// Moved from original index.js (6253-6288). This one never got extracted
// into any module in earlier passes even though it's a dialog exactly like
// showCustomDialog above (found while wiring index.js's bootstrap, since
// attachWindowListeners' "New Session" button calls it) — same file is the
// right home.
export function showSessionDialog({ defaultName = '' } = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'scp-dialog-overlay';
        overlay.innerHTML = `
            <div class="scp-dialog-box">
                <div class="scp-dialog-title">New Session</div>
                <div class="scp-dialog-msg">Session name:</div>
                <input type="text" class="scp-dialog-input" value="${escHtml(defaultName)}" placeholder="${escHtml(defaultName)}">
                <label class="scp-sess-tmp-label">
                    <div class="scp-lb-toggle" id="scp-sess-tmp-toggle"><div class="scp-lb-toggle-knob"></div></div>
                    <span>Temporary — auto-delete when switching</span>
                </label>
                <div class="scp-dialog-btns">
                    <button class="scp-dialog-btn scp-dialog-cancel">Cancel</button>
                    <button class="scp-dialog-btn scp-dialog-ok">Create</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        let isTemporary = false;
        const toggle = overlay.querySelector('#scp-sess-tmp-toggle');
        toggle.addEventListener('click', () => {
            isTemporary = !isTemporary;
            toggle.classList.toggle('active', isTemporary);
        });
        const input = overlay.querySelector('.scp-dialog-input');
        const okBtn = overlay.querySelector('.scp-dialog-ok');
        const cancelBtn = overlay.querySelector('.scp-dialog-cancel');
        const close = val => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 150); resolve(val); };
        input.focus(); input.select();
        okBtn.addEventListener('click', () => close({ name: input.value, isTemporary }));
        cancelBtn.addEventListener('click', () => close(null));
        overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); close({ name: input.value, isTemporary }); }
            if (e.key === 'Escape') close(null);
        });
        requestAnimationFrame(() => overlay.classList.add('visible'));
    });
}
