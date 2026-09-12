/**
 * feature-attachments.js
 * Lets the user attach images/files to a message before sending: reads
 * files, optionally captions images via ST's image-captioning extension or
 * the /api/extra/caption endpoint, renders a preview bar with thumbnails,
 * and shows a lightbox for images/text on click.
 *
 * Moved from original index.js "File Attachments" section (lines
 * 14399-14626, 227 lines).
 *
 * `updateMsgCount` turned out to live in what's now `ui/ui-chat.js`, so
 * it's imported directly (creates an import cycle with that module — safe
 * since it's only called from inside function bodies).
 */

import { EXT_DISPLAY } from '../constants.js';
import { getSettings } from '../settings.js';
import { getCurrentSession } from '../session.js';
import { updateMsgCount } from '../ui/ui-chat.js';

let _pendingAttachments = []; // [{id, name, type, dataUrl, isImage, file}]

function _notifyMsgCount() { updateMsgCount(getCurrentSession()); }

export function getPendingAttachments() { return _pendingAttachments; }
export function clearPendingAttachments() { _pendingAttachments = []; }

function _attachmentId() { return `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }

export async function _fileToDataUrl(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('Read failed'));
        r.readAsDataURL(file);
    });
}

async function _getCaptionViaExtension(file) {
    const ctx = SillyTavern.getContext();
    try {
        const captionMod = await import('/scripts/extensions/image-captioning/index.js').catch(() => null);
        if (captionMod && typeof captionMod.getCaptionForFile === 'function') {
            const caption = await captionMod.getCaptionForFile(file, null, true);
            return caption || '';
        }
    } catch (_) {}
    try {
        const dataUrl = await _fileToDataUrl(file);
        const base64 = dataUrl.split(',')[1];
        const res = await fetch('/api/extra/caption', {
            method: 'POST',
            headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64 }),
        });
        if (res.ok) {
            const data = await res.json();
            return data.caption || '';
        }
    } catch (_) {}
    return '';
}

export async function processAttachmentsBeforeSend(atts, isPreview = false) {
    const s = getSettings();
    const mode = s.imageAnalysisMode || 'direct';
    const processed = [];
    for (const a of atts) {
        if (a.isImage && mode === 'caption') {
            if (isPreview) {
                processed.push({ ...a, sendAsText: true, textContent: `[Image "${a.name}" (caption will be generated on send)]` });
            } else {
                let cap = await _getCaptionViaExtension(a.file).catch((e) => {
                    console.warn('[ST-Copilot] Captioning error:', e);
                    return '';
                });
                if (!cap) toastr.warning(`Captioning failed for ${a.name}`, EXT_DISPLAY);
                processed.push({
                    ...a,
                    sendAsText: true,
                    textContent: cap ? `[Image "${a.name}" caption: ${cap}]` : `[Image "${a.name}" (captioning failed)]`,
                });
            }
        } else if (!a.isImage) {
            let text = a.textContent;
            if (!text && a.file) {
                try { text = await a.file.text(); } catch (e) { text = '(binary data or read error)'; }
            }
            processed.push({ ...a, sendAsText: true, textContent: text });
        } else {
            processed.push({ ...a });
        }
    }
    return processed;
}

export function mergeContent(baseText, atts) {
    if (!atts || !atts.length) return baseText;
    const textParts = atts.filter(a => a.textContent).map(a => a.sendAsText ? a.textContent : `[Attached file "${a.name}"]\n${a.textContent}`);
    const textPrefix = textParts.join('\n\n');

    let combinedText = '';
    if (textPrefix && baseText) combinedText = `${textPrefix}\n\n${baseText}`;
    else if (textPrefix) combinedText = textPrefix;
    else combinedText = baseText;

    const imgBlocks = atts.filter(a => a.isImage && !a.sendAsText).map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } }));

    if (imgBlocks.length > 0) {
        return [...imgBlocks, { type: 'text', text: combinedText }];
    }
    return combinedText;
}

export function renderAttachmentPreviews() {
    let previewBar = document.getElementById('scp-attachment-bar');
    const inputRow = document.querySelector('.scp-input-row');
    if (!inputRow) return;

    if (!_pendingAttachments.length) {
        previewBar?.remove();
        return;
    }

    if (!previewBar) {
        previewBar = document.createElement('div');
        previewBar.id = 'scp-attachment-bar';
        previewBar.className = 'scp-attachment-bar';
        inputRow.parentNode.insertBefore(previewBar, inputRow);
    }
    previewBar.innerHTML = '';

    for (const att of _pendingAttachments) {
        const item = document.createElement('div');
        item.className = 'scp-att-item';
        item.dataset.id = att.id;

        if (att.isImage) {
            const img = document.createElement('img');
            img.src = att.dataUrl;
            img.className = 'scp-att-thumb';
            img.title = att.name;
            img.addEventListener('click', () => _openImageLightbox(att));
            item.appendChild(img);
        } else {
            const icon = document.createElement('div');
            icon.className = 'scp-att-icon';
            icon.innerHTML = `<i class="fa-solid fa-file"></i>`;
            icon.title = att.name;
            item.appendChild(icon);
            const lbl = document.createElement('div');
            lbl.className = 'scp-att-label';
            lbl.textContent = att.name.length > 14 ? att.name.slice(0, 12) + '…' : att.name;
            item.appendChild(lbl);
            item.addEventListener('click', () => _openTextLightbox(att));
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'scp-att-remove';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', e => {
            e.stopPropagation();
            _pendingAttachments = _pendingAttachments.filter(a => a.id !== att.id);
            renderAttachmentPreviews();
            _notifyMsgCount();
        });
        item.appendChild(removeBtn);
        previewBar.appendChild(item);
    }
}

let _lightboxEl = null;
let _lightboxScale = 1;
let _lightboxOpenedAt = 0;

export function _openImageLightbox(att) {
    if (_lightboxEl) _lightboxEl.remove();
    _lightboxScale = 1;

    const overlay = document.createElement('div');
    overlay.className = 'scp-lightbox';
    // Inline styles as a safety net in case the extension stylesheet fails.
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999999;background:rgba(0,0,0,0.92);display:flex;overflow:auto;backdrop-filter:blur(4px);cursor:zoom-in;';
    _lightboxEl = overlay;

    const img = document.createElement('img');
    img.src = att.dataUrl;
    img.className = 'scp-lightbox-img';
    img.style.cssText = 'max-width:92vw;max-height:92vh;border-radius:6px;box-shadow:0 0 60px rgba(0,0,0,0.8);cursor:zoom-in;user-select:none;margin:auto;flex-shrink:0;';

    overlay.appendChild(img);
    document.body.appendChild(overlay);
    // On touch devices a synthesized "ghost click" fires after the tap that
    // opened the lightbox and hits the overlay itself, instantly closing it.
    // Ignore overlay clicks for a short grace period after opening.
    _lightboxOpenedAt = Date.now();

    const applyZoom = (fx, fy) => {
        if (_lightboxScale === 1) {
            img.style.width = '';
            img.style.height = '';
            img.style.maxWidth = '92vw';
            img.style.maxHeight = '92vh';
            overlay.scrollTop = 0; overlay.scrollLeft = 0;
        } else {
            // Resize via width/height so the overlay scrolls instead of the
            // scaled image overflowing (getting clipped) off-screen.
            const rect = img.getBoundingClientRect();
            const baseW = rect.width / _lightboxScale;
            const baseH = rect.height / _lightboxScale;
            img.style.maxWidth = 'none';
            img.style.maxHeight = 'none';
            img.style.width = `${baseW * _lightboxScale}px`;
            img.style.height = `${baseH * _lightboxScale}px`;
            // Keep the anchor point centered in view.
            const w = baseW * _lightboxScale, h = baseH * _lightboxScale;
            overlay.scrollLeft = fx * w - overlay.clientWidth / 2;
            overlay.scrollTop = fy * h - overlay.clientHeight / 2;
        }
        img.style.cursor = _lightboxScale > 1 ? 'zoom-out' : 'zoom-in';
    };

    const zoomAt = (newScale, cx, cy) => {
        // Anchor as a fraction of the CURRENT (pre-zoom) image.
        const rect = img.getBoundingClientRect();
        const fx = rect.width > 0 ? (cx - rect.left) / rect.width : 0.5;
        const fy = rect.height > 0 ? (cy - rect.top) / rect.height : 0.5;
        _lightboxScale = newScale;
        applyZoom(fx, fy);
    };

    img.addEventListener('click', e => {
        if (Date.now() - _lightboxOpenedAt < 400) return;
        const next = _lightboxScale >= 3 ? 1 : Math.min(3, _lightboxScale + 1);
        zoomAt(next, e.clientX, e.clientY);
    });
    // Mouse wheel zoom: up = zoom in, down = zoom out.
    overlay.addEventListener('wheel', e => {
        e.preventDefault();
        const steps = [1, 2, 3];
        const idx = steps.indexOf(_lightboxScale);
        if (e.deltaY < 0 && _lightboxScale < 3) zoomAt(steps[idx + 1], e.clientX, e.clientY);
        else if (e.deltaY > 0 && _lightboxScale > 1) zoomAt(steps[Math.max(0, idx - 1)], e.clientX, e.clientY);
    }, { passive: false });

    overlay.addEventListener('click', e => {
        if (Date.now() - _lightboxOpenedAt < 400) return;
        if (e.target === overlay) { overlay.remove(); _lightboxEl = null; }
    });
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') { overlay.remove(); _lightboxEl = null; document.removeEventListener('keydown', onEsc); }
    });
}

export async function _openTextLightbox(att) {
    if (_lightboxEl) _lightboxEl.remove();
    const overlay = document.createElement('div');
    overlay.className = 'scp-lightbox';
    _lightboxEl = overlay;
    const pre = document.createElement('pre');
    pre.className = 'scp-lightbox-text';

    let text = att.textContent;
    if (!text && att.file) {
        try { text = await att.file.text(); att.textContent = text; }
        catch (e) { text = 'Error reading file.'; }
    }
    pre.textContent = text || 'Loading...';

    overlay.appendChild(pre);
    document.body.appendChild(overlay);
    _lightboxOpenedAt = Date.now();
    overlay.addEventListener('click', e => {
        if (Date.now() - _lightboxOpenedAt < 400) return;
        if (e.target === overlay) { overlay.remove(); _lightboxEl = null; }
    });
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { overlay.remove(); _lightboxEl = null; document.removeEventListener('keydown', onEsc); } });
}

export async function addAttachments(files) {
    for (const file of files) {
        const isImage = file.type.startsWith('image/');
        let dataUrl = null;
        if (isImage) {
            dataUrl = await _fileToDataUrl(file).catch(() => null);
            if (!dataUrl) continue;
        }

        _pendingAttachments.push({
            id: _attachmentId(),
            name: file.name, type: file.type, mimeType: file.type,
            dataUrl, isImage, file, textContent: null,
        });
    }
    renderAttachmentPreviews();
    _notifyMsgCount();
}
