/**
 * ui-window.js
 * The Copilot window's chrome and surrounding chrome-adjacent features:
 * dirty-state "unsaved changes" dots, completion sound synthesis, the
 * Context Inspector open/preview action, drag/resize (window + dock icon),
 * custom theme application + background image/video, window
 * position/size persistence, show/hide/minimize, Ghost Mode (click-through
 * transparency), the open-window and search hotkeys, connection Profile
 * System (save/load/bind settings snapshots), the Theme Editor UI, the
 * character avatar badge, and the settings-panel profile dropdown refresh.
 *
 * Moved from original index.js: "Dirty State Tracking (item 1)"
 * (lines 5522-5548 — just `_markDirty`/`_clearDirty`/`_updateDirtyDots`;
 * the Stats half of that same marker range is in `feature-stats.js`),
 * "Completion Sound" (10072-10364), "Context Inspector" (10510-10569),
 * "Drag & Resize" (10570-10926), "Theme" (10927-11285), "Window State"
 * (11286-11367), "Visibility" (11368-11435), "Ghost Mode" (11436-11483),
 * "Hotkey" (11484-11537), "Profile System" (11737-11859), "Theme Editor"
 * (11860-12161), and "char Badge" (12162-12196).
 *
 * `_markDirty`/`_clearDirty` needed `isConfigProfileDirty`/`isThemeDirty`/
 * `_takeProfileSnapshot` from Profile System and Theme Editor, so all three
 * pulled together into one file rather than splitting further and adding
 * yet another injection layer.
 *
 * This resolves the last two forward-dependency injection points left
 * anywhere in the codebase: `applyCustomTheme` (feature-lorebook-ui.js)
 * and `playCompletionSound` (ui/ui-chat.js).
 *
 * DEPENDENCY NOTE: `updateSettingsUI` and `_syncBgToOverlay` aren't built
 * yet (belong to the future `ui/ui-settings.js` Settings Panel). Injected:
 *
 *   import { setForwardDeps } from './ui/ui-window.js';
 *   import { updateSettingsUI, syncBgToOverlay } from './ui/ui-settings.js'; // future
 *   setForwardDeps({ updateSettingsUI, syncBgToOverlay });
 *
 * Until wired: loading a saved profile won't refresh the open Settings
 * panel's form fields, and changing the background won't sync to the
 * settings-overlay preview — everything else (dragging, resizing, theming,
 * showing/hiding, ghost mode, hotkeys, profiles, dirty dots) works
 * standalone.
 */

import { EXT_DISPLAY, WIN_ID, ICON_STORAGE_KEY, THEME_PRESETS, THEME_VAR_DEFS, THEME_CSS_MAP } from '../constants.js';
import { DEFAULT_SYSTEM_PROMPT } from '../default-prompts.js';
import { $, escHtml, showCustomDialog } from '../utils/util-dom.js';
import { getBindingKey } from '../utils/util-st.js';
import { COLOR_KEYS, showColorPicker } from '../utils/util-colorpicker.js';
import { isCopilotActive, setCopilotActive, getWindowEl, setWindowEl, getIconEl, setIconEl, getModalEl } from '../state.js';
import { getSettings, saveSettings } from '../settings.js';
import { getEffectiveSettings, getCurrentSession } from '../session.js';
import {
    assembleMessages, getLastInspectorMessages, setLastInspectorMessages,
    buildContextInspectorHTML,
} from '../api.js';
import {
    getPendingAttachments, processAttachmentsBeforeSend, addAttachments, _fileToDataUrl,
} from '../features/feature-attachments.js';
import {
    scrollToBottom, resetUserScrolledUp, isSearchOpen, openSearch,
} from '../ui/ui-chat.js';

// ── Injected forward deps (see header note) ────────────────────────────────
let _updateSettingsUI = () => {};
let _syncBgToOverlayFn = () => {};

export function setForwardDeps({ updateSettingsUI, syncBgToOverlay } = {}) {
    if (updateSettingsUI) _updateSettingsUI = updateSettingsUI;
    if (syncBgToOverlay) _syncBgToOverlayFn = syncBgToOverlay;
}

let _configDirty = false;
let _themeDirty = false;

export function _markDirty(type) {
    if (type === 'config') _configDirty = isConfigProfileDirty();
    if (type === 'theme') _themeDirty = isThemeDirty();
    _updateDirtyDots();
}

export function _clearDirty(type) {
    if (type === 'config') { _configDirty = false; _takeProfileSnapshot(); }
    if (type === 'theme') _themeDirty = false;
    _updateDirtyDots();
}

export function _updateDirtyDots() {
    const configDot = '<span class="scp-save-dirty-dot"></span>';
    ['scp-profile-save', 'scp-sp-profile-save'].forEach(id => {
        const btn = document.getElementById(id); if (!btn) return;
        btn.querySelectorAll('.scp-save-dirty-dot').forEach(d => d.remove());
        if (_configDirty) btn.insertAdjacentHTML('beforeend', configDot);
    });
    document.querySelectorAll('#scp-theme-save').forEach(btn => {
        btn.querySelectorAll('.scp-save-dirty-dot').forEach(d => d.remove());
        if (_themeDirty) btn.insertAdjacentHTML('beforeend', configDot);
    });
}


// ─── Completion Sound ────────────────────────────────────────────────────────

const _SOUND_PRESETS = {
    none:    { label: 'None' },
    chime:   { label: 'Chime' },
    bell:    { label: 'Bell' },
    soft:    { label: 'Soft Ping' },
    digital: { label: 'Digital Blip' },
    pop:     { label: 'Pop' },
};

export function _synthSound(type, volume = 80) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const masterGain = ctx.createGain();
        masterGain.gain.value = Math.max(0, Math.min(1, volume / 100));
        masterGain.connect(ctx.destination);
        const now = ctx.currentTime;

        if (type === 'chime') {
            [523.25, 659.25, 783.99].forEach((freq, i) => {
                const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
                const og = ctx.createGain();
                o.connect(og); og.connect(masterGain);
                og.gain.setValueAtTime(0, now + i * 0.12);
                og.gain.linearRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
                og.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.5);
                o.start(now + i * 0.12); o.stop(now + i * 0.12 + 0.5);
            });
        } else if (type === 'bell') {
            const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 880;
            const og = ctx.createGain();
            o.connect(og); og.connect(masterGain);
            og.gain.setValueAtTime(0.25, now);
            og.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
            o.start(now); o.stop(now + 1.2);
        } else if (type === 'soft') {
            const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 660;
            const og = ctx.createGain();
            o.connect(og); og.connect(masterGain);
            og.gain.setValueAtTime(0, now);
            og.gain.linearRampToValueAtTime(0.15, now + 0.05);
            og.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
            o.start(now); o.stop(now + 0.4);
        } else if (type === 'digital') {
            [440, 880].forEach((freq, i) => {
                const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
                const og = ctx.createGain();
                o.connect(og); og.connect(masterGain);
                og.gain.setValueAtTime(0.08, now + i * 0.07);
                og.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.12);
                o.start(now + i * 0.07); o.stop(now + i * 0.07 + 0.12);
            });
        } else if (type === 'pop') {
            const o = ctx.createOscillator(); o.type = 'sine';
            o.frequency.setValueAtTime(600, now);
            o.frequency.exponentialRampToValueAtTime(200, now + 0.1);
            const og = ctx.createGain();
            o.connect(og); og.connect(masterGain);
            og.gain.setValueAtTime(0.22, now);
            og.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
            o.start(now); o.stop(now + 0.15);
        }
        setTimeout(() => ctx.close(), 2000);
    } catch (_) {}
}

export function playCompletionSound() {
    const s = getSettings();
    const soundType = s.completionSound || 'none';
    const vol = s.completionSoundVolume ?? 80;
    if (soundType === 'none') return;
    if (s.completionSoundOnlyWhenUnfocused && document.hasFocus()) return;

    if (soundType.startsWith('custom_') && s.customSounds && s.customSounds[soundType]) {
        try {
            const audio = new Audio(s.customSounds[soundType].data);
            audio.volume = vol / 100;
            audio.play().catch(() => {});
        } catch (_) {}
        return;
    }

    if (soundType === 'custom' && s.completionSoundData) {
        try {
            const audio = new Audio(s.completionSoundData);
            audio.volume = vol / 100;
            audio.play().catch(() => {});
        } catch (_) {}
        return;
    }
    
    if (_SOUND_PRESETS[soundType] && soundType !== 'none') {
        _synthSound(soundType, vol);
    }
}

export function buildSoundSettingsUI(container) {
    if (!container) return;
    container.innerHTML = '';
    const s = getSettings();
    if (!s.customSounds) s.customSounds = {};

    if (s.completionSoundData && !s.customSounds['custom_legacy']) {
        s.customSounds['custom_legacy'] = {
            name: s.completionSoundFileName || 'Legacy Custom Sound',
            data: s.completionSoundData
        };
        if (s.completionSound === 'custom') {
            s.completionSound = 'custom_legacy';
        }
        delete s.completionSoundData;
        delete s.completionSoundFileName;
        saveSettings();
    }

    const isSP = container.id === 'scp-sp-sound-settings';

    const typeRow = document.createElement('div');
    typeRow.className = isSP ? 'scp-sp-field' : '';
    if (!isSP) typeRow.style.marginTop = '10px';
    
    const typeLbl = document.createElement(isSP ? 'label' : 'b');
    typeLbl.className = isSP ? 'scp-sp-label' : '';
    if (!isSP) typeLbl.style.fontSize = '12px';
    typeLbl.textContent = 'Completion Sound';
    
    const typeWrap = document.createElement('div');
    typeWrap.style.cssText = 'display:flex;gap:6px;align-items:center';
    if (!isSP) typeWrap.style.marginTop = '6px';
    
    const typeSel = document.createElement('select');
    typeSel.className = isSP ? 'scp-sp-select text_pole' : 'text_pole';
    typeSel.style.flex = '1';
    
    const renderDropdown = () => {
        typeSel.innerHTML = '';
        
        const groupPreset = document.createElement('optgroup');
        groupPreset.label = 'Presets';
        for (const [key, preset] of Object.entries(_SOUND_PRESETS)) {
            const opt = document.createElement('option');
            opt.value = key; opt.textContent = preset.label;
            groupPreset.appendChild(opt);
        }
        typeSel.appendChild(groupPreset);
        
        if (Object.keys(s.customSounds).length > 0) {
            const groupCustom = document.createElement('optgroup');
            groupCustom.label = 'Custom Sounds';
            for (const [key, snd] of Object.entries(s.customSounds)) {
                const opt = document.createElement('option');
                opt.value = key; opt.textContent = snd.name;
                groupCustom.appendChild(opt);
            }
            typeSel.appendChild(groupCustom);
        }
        
        typeSel.value = s.completionSound || 'none';
        if (!typeSel.value) {
            typeSel.value = 'none';
            s.completionSound = 'none';
            saveSettings();
        }
    };
    renderDropdown();

    const testBtn = document.createElement('button');
    testBtn.className = isSP ? 'scp-action-btn' : 'menu_button interactable';
    testBtn.innerHTML = `<i class="fa-solid fa-play"></i><span>Test</span>`;
    if (!isSP) testBtn.style.flex = '0 0 auto';
    testBtn.addEventListener('click', () => playCompletionSound());
    
    typeWrap.appendChild(typeSel);
    typeWrap.appendChild(testBtn);
    typeRow.appendChild(typeLbl);
    typeRow.appendChild(typeWrap);
    container.appendChild(typeRow);

    const customActionsWrap = document.createElement('div');
    customActionsWrap.style.cssText = isSP ? 'display:flex;gap:6px;margin-top:6px' : 'display:flex;gap:6px;margin-top:6px;align-items:center';
    
    const uploadBtn = document.createElement('button');
    uploadBtn.className = isSP ? 'scp-action-btn' : 'menu_button interactable';
    uploadBtn.innerHTML = `<i class="fa-solid fa-upload"></i><span>Upload Custom</span>`;
    if (!isSP) uploadBtn.style.flex = '1';

    uploadBtn.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*,video/mp4,video/webm';
        inp.onchange = async () => {
            const file = inp.files?.[0]; if (!file) return;
            if (file.size > 25 * 1024 * 1024) { toastr.warning('File too large (>25MB).', EXT_DISPLAY); return; }
            const isVideo = file.type.startsWith('video/');
            const url = await _uploadBackgroundToST(file).catch(() => null);
            if (!url) { toastr.error('Failed to upload background', EXT_DISPLAY); return; }
            
            const s2 = getSettings();
            const id = 'bg_' + Date.now();
            s2.customBackgrounds[id] = { name: file.name, dataUrl: url, isVideo, fit: 'cover' };
            s2.windowBg = id;
            saveSettings();
            
            const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
            allContainers.forEach(c => buildBackgroundSettingsUI(c));
            applyWindowBackground();
        };
        inp.click();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = isSP ? 'scp-action-btn scp-sp-danger-btn' : 'menu_button interactable';
    deleteBtn.innerHTML = `<i class="fa-solid fa-trash"></i><span>Delete</span>`;
    if (!isSP) deleteBtn.style.flex = '1';

    deleteBtn.addEventListener('click', async () => {
        const val = typeSel.value;
        if (val.startsWith('custom_')) {
            const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Sound', message: 'Delete this custom sound?' });
            if (!ok) return;
            const s2 = getSettings();
            delete s2.customSounds[val];
            s2.completionSound = 'none';
            saveSettings();
            renderDropdown();
            updateCustomActions();
            
            const otherContainers = [document.getElementById('scp-sound-settings'), document.getElementById('scp-sp-sound-settings')].filter(c => c && c !== container);
            otherContainers.forEach(c => buildSoundSettingsUI(c));
        }
    });
    
    customActionsWrap.appendChild(uploadBtn);
    customActionsWrap.appendChild(deleteBtn);
    container.appendChild(customActionsWrap);

    const updateCustomActions = () => {
        deleteBtn.style.display = typeSel.value.startsWith('custom_') ? '' : 'none';
    };
    updateCustomActions();

    typeSel.addEventListener('change', () => {
        getSettings().completionSound = typeSel.value;
        saveSettings();
        updateCustomActions();
        const otherContainers = [document.getElementById('scp-sound-settings'), document.getElementById('scp-sp-sound-settings')].filter(c => c && c !== container);
        otherContainers.forEach(c => buildSoundSettingsUI(c));
    });

    const volRow = document.createElement('div');
    volRow.className = isSP ? 'scp-sp-field' : '';
    volRow.style.marginTop = isSP ? '6px' : '10px';

    const volLbl = document.createElement(isSP ? 'label' : 'b');
    volLbl.className = isSP ? 'scp-sp-label' : '';
    if (!isSP) volLbl.style.fontSize = '12px';
    volLbl.textContent = 'Volume';

    const volWrap = document.createElement('div');
    volWrap.className = isSP ? 'scp-sp-row' : '';
    if (!isSP) {
        volWrap.style.display = 'flex';
        volWrap.style.alignItems = 'center';
        volWrap.style.gap = '10px';
        volWrap.style.marginTop = '6px';
    }

    const volSlider = document.createElement('input');
    volSlider.type = 'range'; 
    volSlider.className = isSP ? 'scp-slider scp-sp-vol-slider' : 'neo-range-slider scp-sp-vol-slider';
    volSlider.style.flex = '1'; volSlider.min = '0'; volSlider.max = '100';
    volSlider.value = s.completionSoundVolume ?? 80;

    const volVal = document.createElement('span');
    volVal.className = 'scp-sp-vol-val';
    volVal.style.cssText = isSP 
        ? 'min-width:32px;text-align:right;font-size:11px;color:var(--scp-accent)' 
        : 'min-width:34px;text-align:right;font-size:12px;color:var(--SmartThemeQuoteColor,#a99bfb)';
    volVal.textContent = `${volSlider.value}%`;
    
    volSlider.addEventListener('input', () => { volVal.textContent = `${volSlider.value}%`; });
    volSlider.addEventListener('change', () => { 
        getSettings().completionSoundVolume = parseInt(volSlider.value); 
        saveSettings(); 
        const otherContainers2 = [document.getElementById('scp-sound-settings'), document.getElementById('scp-sp-sound-settings')].filter(c => c && c !== container);
        otherContainers2.forEach(c => buildSoundSettingsUI(c));
    });
    
    volWrap.appendChild(volSlider); volWrap.appendChild(volVal);
    volRow.appendChild(volLbl); volRow.appendChild(volWrap);
    container.appendChild(volRow);
}


// ─── Context Inspector ──────────────────────────────────────────────────────

export async function openInspector() {
    const sess = getCurrentSession(); const settings = getEffectiveSettings();
    const inputEl = document.getElementById('scp-input');
    const pendingText = inputEl ? inputEl.value.trim() : '';
    const processedAtts = await processAttachmentsBeforeSend(getPendingAttachments(), true);

    const messages = await assembleMessages(sess, settings, pendingText, processedAtts);
    setLastInspectorMessages(messages);

    const fmtEl = $('scp-ctx-formatted'); const jsonEl = $('scp-ctx-json');

    const modal = getModalEl()?.querySelector('.scp-modal');
    if (modal) modal.style.height = '75vh';

    const modalBody = getModalEl()?.querySelector('.scp-modal-body');
    if (modalBody) {
        modalBody.style.padding = '0';
        modalBody.style.overflow = 'hidden';
        modalBody.style.display = 'flex';
        modalBody.style.flexDirection = 'column';
        modalBody.style.height = '100%';
    }

    if (fmtEl) {
        fmtEl.style.height = '100%';
        fmtEl.style.flex = '1';
        fmtEl.style.overflow = 'hidden';
        fmtEl.style.padding = '0';
        fmtEl.innerHTML = buildContextInspectorHTML(messages);

fmtEl.querySelectorAll('.scp-ctx-nav-btn[data-t]').forEach(btn => {
btn.addEventListener('click', () => {
const targetId = btn.dataset.t;
const bodyContainer = document.getElementById('scp-ctx-body');
if (!bodyContainer) return;
const t = bodyContainer.querySelector('#' + CSS.escape(targetId));
if (!t) { console.warn('[ST-Copilot] Nav target not found:', targetId); return; }
const tRect = t.getBoundingClientRect();
const cRect = bodyContainer.getBoundingClientRect();
bodyContainer.scrollTo({ top: bodyContainer.scrollTop + tRect.top - cRect.top, behavior: 'smooth' });
});
});
    }
    if (jsonEl) jsonEl.textContent = JSON.stringify(messages, null, 2);
    getModalEl().style.display = 'flex';

    setTimeout(() => {
        const isJsonActive = document.querySelector('.scp-modal-tab.active')?.dataset.tab === 'json';
        const targetEl = isJsonActive ? jsonEl : document.getElementById('scp-ctx-body');
        if (targetEl) {
            const prevBehavior = targetEl.style.scrollBehavior;
            targetEl.style.scrollBehavior = 'auto';
            targetEl.scrollTop = targetEl.scrollHeight;
            targetEl.style.scrollBehavior = prevBehavior;
        }
    }, 0);
}


// ─── Drag & Resize ──────────────────────────────────────────────────────────

export function getEvCoords(e) {
    if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

export function makeDraggable(handle, target) {
    let active = false, ox = 0, oy = 0, sl = 0, st = 0;
    let _rafId = null;
    let _anchorX = 0, _anchorY = 0;

    let tx = 0, ty = 0;
    let cx = 0, cy = 0;
    let vx = 0, vy = 0;

    let rotX = 0, rotY = 0, rotZ = 0, skewX = 0, skewY = 0;
    let vRotX = 0, vRotY = 0, vRotZ = 0, vSkewX = 0, vSkewY = 0;

    let isWobbly = true;

    const tick = () => {
        if (!active && 
            Math.abs(vx) < 0.1 && Math.abs(vy) < 0.1 &&
            Math.abs(vRotX) < 0.1 && Math.abs(vRotY) < 0.1 && Math.abs(vRotZ) < 0.1 &&
            Math.abs(rotX) < 0.1 && Math.abs(rotY) < 0.1 && Math.abs(rotZ) < 0.1 &&
            Math.abs(tx - cx) < 0.5 && Math.abs(ty - cy) < 0.5) {
            
            target.style.transform = '';
            target.style.transformOrigin = '';
            target.style.left = `${Math.max(0, tx)}px`;
            target.style.top = `${Math.max(0, ty)}px`;
            _rafId = null;
            
            vx = vy = 0;
            rotX = rotY = rotZ = skewX = skewY = 0;
            vRotX = vRotY = vRotZ = vSkewX = vSkewY = 0;
            
            saveWindowState();
            return;
        }

        if (isWobbly) {
            const tension = 0.28;   
            const friction = 0.62;  
            const aTension = 0.18;  
            const aFriction = 0.72; 

            const dx = tx - cx;
            const dy = ty - cy;
            
            vx = (vx + dx * tension) * friction;
            vy = (vy + dy * tension) * friction;
            cx += vx;
            cy += vy;

            const targetRotY = dx * 0.12 + vx * 0.02; 
            const targetRotX = -(dy * 0.12 + vy * 0.02);
            const targetRotZ = (-dx * _anchorY + dy * _anchorX) * 0.05;
            const targetSkewX = -vx * 0.03;
            const targetSkewY = -vy * 0.03;

            vRotX = (vRotX + (targetRotX - rotX) * aTension) * aFriction;
            vRotY = (vRotY + (targetRotY - rotY) * aTension) * aFriction;
            vRotZ = (vRotZ + (targetRotZ - rotZ) * aTension) * aFriction;
            vSkewX = (vSkewX + (targetSkewX - skewX) * aTension) * aFriction;
            vSkewY = (vSkewY + (targetSkewY - skewY) * aTension) * aFriction;

            rotX += vRotX;
            rotY += vRotY;
            rotZ += vRotZ;
            skewX += vSkewX;
            skewY += vSkewY;

            const clamp = (val, max) => Math.max(-max, Math.min(max, val));
            const cRotX = clamp(rotX, 15);
            const cRotY = clamp(rotY, 15);
            const cRotZ = clamp(rotZ, 8);
            const cSkewX = clamp(skewX, 5);
            const cSkewY = clamp(skewY, 5);

            const speed = Math.sqrt(vx*vx + vy*vy);
            const scaleStr = Math.max(0.98, 1 - speed * 0.0004);

            target.style.left = `${cx}px`;
            target.style.top = `${cy}px`;
            
            target.style.transformOrigin = `${(_anchorX * 50 + 50)}% ${(_anchorY * 50 + 50)}%`;
            target.style.transform = `perspective(1200px) scale(${scaleStr}) rotateX(${cRotX}deg) rotateY(${cRotY}deg) rotateZ(${cRotZ}deg) skew(${cSkewX}deg, ${cSkewY}deg)`;
        } else {
            cx = tx; cy = ty;
            
            vx = vy = 0;
            rotX = rotY = rotZ = skewX = skewY = 0;
            vRotX = vRotY = vRotZ = vSkewX = vSkewY = 0;

            target.style.transform = '';
            target.style.left = `${Math.max(0, cx)}px`;
            target.style.top = `${Math.max(0, cy)}px`;
        }

        _rafId = requestAnimationFrame(tick);
    };

    handle.addEventListener('pointerdown', e => {
        if (e.target.closest('.scp-hbtn,.scp-tbtn,select,input,button,.scp-opacity-wrap,.scp-rh,.scp-sess-dropdown,.scp-sess-wrap')) return;
        
        isWobbly = getSettings().wobbleWindow !== false && !getSettings().performanceMode;

        if (_rafId && isWobbly) {
            sl = cx; 
            st = cy;
            const w = target.offsetWidth;
            const h = target.offsetHeight;
            _anchorX = (e.clientX - (sl + w/2)) / (w/2);
            _anchorY = (e.clientY - (st + h/2)) / (h/2);
        } else {
            const r = target.getBoundingClientRect();
            sl = r.left; 
            st = r.top;
            _anchorX = (e.clientX - (r.left + r.width/2)) / (r.width/2);
            _anchorY = (e.clientY - (r.top + r.height/2)) / (r.height/2);
            
            cx = sl; cy = st;
            vx = vy = 0;
            rotX = rotY = rotZ = skewX = skewY = 0;
            vRotX = vRotY = vRotZ = vSkewX = vSkewY = 0;
        }

        ox = e.clientX; oy = e.clientY; 
        tx = sl; ty = st;

        active = true;
        handle.setPointerCapture(e.pointerId);
        target.classList.add('scp-dragging');
        e.preventDefault();
        
        if (!_rafId) _rafId = requestAnimationFrame(tick);
    });

    handle.addEventListener('pointermove', e => {
        if (!active) return;
        tx = Math.max(0, sl + (e.clientX - ox));
        ty = Math.max(0, st + (e.clientY - oy));
    });

    const onEnd = () => {
        if (!active) return;
        active = false;
        target.classList.remove('scp-dragging');
        if (!isWobbly) {
            saveWindowState();
        }
    };

    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
    handle.style.touchAction = 'none';
}

export function makeResizable(target) {
    const MIN_W = 320, MIN_H = 300;
    target.querySelectorAll('.scp-rh').forEach(h => {
        const dir = [...h.classList].find(c => /^scp-rh-\w/.test(c))?.replace('scp-rh-', '') || '';
        let active = false, sw, sh, sl, st, sx, sy, _rafId = null, _s = {};

        const flush = () => {
            if (_s.w !== undefined) target.style.width = `${_s.w}px`;
            if (_s.h !== undefined) target.style.height = `${_s.h}px`;
            if (_s.l !== undefined) { target.style.left = `${_s.l}px`; target.style.right = 'auto'; }
            if (_s.t !== undefined) target.style.top = `${_s.t}px`;
            _rafId = null;
        };

        h.addEventListener('pointerdown', e => {
            e.preventDefault(); e.stopPropagation();
            active = true; _s = {};
            const r = target.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; sl = r.left; st = r.top;
            h.setPointerCapture(e.pointerId);
            target.classList.add('scp-resizing');
        });

        h.addEventListener('pointermove', e => {
            if (!active) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            _s = {};
            if (dir.includes('e')) _s.w = Math.max(MIN_W, sw + dx);
            if (dir.includes('s')) _s.h = Math.max(MIN_H, sh + dy);
            if (dir.includes('w')) { const nw = Math.max(MIN_W, sw - dx); _s.w = nw; _s.l = sl + (sw - nw); }
            if (dir.includes('n')) { const nh = Math.max(MIN_H, sh - dy); _s.h = nh; _s.t = st + (sh - nh); }
            if (!_rafId) _rafId = requestAnimationFrame(flush);
        });

        h.addEventListener('pointerup', e => {
            if (!active) return;
            active = false;
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; flush(); }
            target.classList.remove('scp-resizing');
            saveWindowState();
        });

        h.addEventListener('pointercancel', () => {
            active = false;
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            target.classList.remove('scp-resizing');
        });

        h.style.touchAction = 'none';
    });
}

export function makeIconDraggable(iconTarget) {
    let dragging = false;
    let active = false;
    let offsetX = 0, offsetY = 0;
    let startX = 0, startY = 0;
    let _rafId = null;

    let tx = 0, ty = 0;
    let cx = 0, cy = 0;
    let vx = 0, vy = 0;

    let stretch = 0;
    let vStretch = 0;
    let angle = 0;

    const tick = () => {
        const isWobbly = getSettings().wobbleWindow !== false && !getSettings().performanceMode;

        if (!active && !dragging &&
            Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05 &&
            Math.abs(tx - cx) < 0.5 && Math.abs(ty - cy) < 0.5 &&
            Math.abs(stretch) < 0.005 && Math.abs(vStretch) < 0.005) {
            
            iconTarget.style.transform = '';
            iconTarget.style.left = `${tx}px`;
            iconTarget.style.top = `${ty}px`;
            _rafId = null;
            vx = vy = stretch = vStretch = 0;
            
            localStorage.setItem(ICON_STORAGE_KEY, JSON.stringify({
                left: iconTarget.style.left,
                top: iconTarget.style.top,
            }));
            return;
        }

        if (isWobbly) {
            const tension = 0.28;   
            const friction = 0.62;  

            const dx = tx - cx;
            const dy = ty - cy;

            vx = (vx + dx * tension) * friction;
            vy = (vy + dy * tension) * friction;
            cx += vx;
            cy += vy;

            const speed = Math.sqrt(vx * vx + vy * vy);
            const targetStretch = Math.min(0.35, speed * 0.015);
            
            const sTension = 0.22;
            const sFriction = 0.68;
            const dStretch = targetStretch - stretch;
            vStretch = (vStretch + dStretch * sTension) * sFriction;
            stretch += vStretch;

            if (speed > 0.5) {
                angle = Math.atan2(vy, vx) * (180 / Math.PI);
            }

            iconTarget.style.left = `${cx}px`;
            iconTarget.style.top = `${cy}px`;
            iconTarget.style.transform = `rotate(${angle}deg) scale(${1 + stretch}, ${1 - stretch}) rotate(${-angle}deg)`;
        } else {
            cx = tx; cy = ty;
            vx = vy = stretch = vStretch = 0;
            iconTarget.style.transform = '';
            iconTarget.style.left = `${tx}px`;
            iconTarget.style.top = `${ty}px`;
        }

        _rafId = requestAnimationFrame(tick);
    };

    iconTarget.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        
        dragging = false;
        active = true;
        
        const r = iconTarget.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;
        
        startX = r.left;
        startY = r.top;
        
        cx = r.left;
        cy = r.top;
        tx = cx;
        ty = cy;
        vx = vy = stretch = vStretch = 0;

        iconTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    iconTarget.addEventListener('pointermove', e => {
        if (!iconTarget.hasPointerCapture(e.pointerId)) return;
        
        const rawX = e.clientX - offsetX;
        const rawY = e.clientY - offsetY;
        
        const viewportWidth = window.visualViewport ? window.visualViewport.width : window.innerWidth;
        const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        
        tx = Math.max(0, Math.min(viewportWidth - 46, rawX));
        ty = Math.max(0, Math.min(viewportHeight - 46, rawY));
        
        const moveDist = Math.sqrt((tx - startX) * (tx - startX) + (ty - startY) * (ty - startY));
        if (!dragging && moveDist > 6) {
            dragging = true;
            iconTarget.classList.add('scp-icon-dragging');
        }

        if (!_rafId) _rafId = requestAnimationFrame(tick);
    });

    iconTarget.addEventListener('pointerup', e => {
        if (iconTarget.hasPointerCapture(e.pointerId)) {
            iconTarget.releasePointerCapture(e.pointerId);
        }
        active = false;
        iconTarget.classList.remove('scp-icon-dragging');
        
        if (dragging) {
            dragging = false;
        } else {
            toggleVisibility();
        }
    });

    iconTarget.addEventListener('pointercancel', e => {
        if (iconTarget.hasPointerCapture(e.pointerId)) {
            iconTarget.releasePointerCapture(e.pointerId);
        }
        dragging = false;
        active = false;
        iconTarget.classList.remove('scp-icon-dragging');
    });

    iconTarget.style.touchAction = 'none';
}


// ─── Theme ──────────────────────────────────────────────────────────────────

export function buildBackgroundSettingsUI(container) {
    if (!container) return;
    container.innerHTML = '';
    const s = getSettings();
    if (!s.customBackgrounds) s.customBackgrounds = {};

    const isSP = container.id === 'scp-sp-bg-settings';

    // TYPE SELECTOR
    const typeRow = document.createElement('div');
    typeRow.className = isSP ? 'scp-sp-field' : '';
    
    const typeLbl = document.createElement(isSP ? 'label' : 'b');
    typeLbl.className = isSP ? 'scp-sp-label' : '';
    if (!isSP) typeLbl.style.cssText = 'font-size:11px;color:#888;display:block;margin-bottom:4px';
    typeLbl.textContent = 'Background Type';
    
    const typeWrap = document.createElement('div');
    typeWrap.style.cssText = 'display:flex;gap:6px;align-items:center';
    
    const typeSel = document.createElement('select');
    typeSel.className = isSP ? 'scp-sp-select text_pole' : 'text_pole';
    typeSel.style.flex = '1';
    
    const renderDropdown = () => {
        typeSel.innerHTML = '<option value="none">None</option>';
        if (Object.keys(s.customBackgrounds).length > 0) {
            const groupCustom = document.createElement('optgroup');
            groupCustom.label = 'Custom Backgrounds';
            for (const [key, bg] of Object.entries(s.customBackgrounds)) {
                const opt = document.createElement('option');
                opt.value = key; opt.textContent = bg.name;
                groupCustom.appendChild(opt);
            }
            typeSel.appendChild(groupCustom);
        }
        typeSel.value = s.windowBg || 'none';
    };
    renderDropdown();
    typeWrap.appendChild(typeSel);
    typeRow.appendChild(typeLbl); typeRow.appendChild(typeWrap);
    container.appendChild(typeRow);

    // ACTIONS
    const customActionsWrap = document.createElement('div');
    customActionsWrap.style.cssText = isSP ? 'display:flex;gap:6px;margin-top:6px' : 'display:flex;gap:6px;margin-top:6px;align-items:center';
    
    const uploadBtn = document.createElement('button');
    uploadBtn.className = isSP ? 'scp-action-btn' : 'menu_button interactable';
    uploadBtn.innerHTML = `<i class="fa-solid fa-upload"></i><span>Upload</span>`;
    if (!isSP) uploadBtn.style.flex = '1';

    uploadBtn.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*,video/mp4,video/webm';
        inp.onchange = async () => {
            const file = inp.files?.[0]; if (!file) return;
            if (file.size > 25 * 1024 * 1024) { toastr.warning('File too large (>25MB).', EXT_DISPLAY); return; }
            const isVideo = file.type.startsWith('video/');
            const dataUrl = await _fileToDataUrl(file).catch(() => null);
            if (!dataUrl) return;
            
            const s2 = getSettings();
            const id = 'bg_' + Date.now();
            s2.customBackgrounds[id] = { name: file.name, dataUrl, isVideo, fit: 'cover' };
            s2.windowBg = id;
            saveSettings();
            
            const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
            allContainers.forEach(c => buildBackgroundSettingsUI(c));
            applyWindowBackground();
        };
        inp.click();
    });

    const urlBtn = document.createElement('button');
    urlBtn.className = isSP ? 'scp-action-btn' : 'menu_button interactable';
    urlBtn.innerHTML = `<i class="fa-solid fa-link"></i><span>URL</span>`;
    if (!isSP) urlBtn.style.flex = '1';

    urlBtn.addEventListener('click', async () => {
        const url = await showCustomDialog({ type: 'prompt', title: 'Add Background', message: 'Enter direct URL to image or video:', placeholder: 'https://...' });
        if (url && url.trim()) {
            const s2 = getSettings();
            const id = 'bg_' + Date.now();
            const isVideo = url.endsWith('.mp4') || url.endsWith('.webm');
            s2.customBackgrounds[id] = { name: 'URL Background', dataUrl: url.trim(), isVideo, fit: 'cover' };
            s2.windowBg = id;
            saveSettings();
            const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
            allContainers.forEach(c => buildBackgroundSettingsUI(c));
            applyWindowBackground();
        }
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = isSP ? 'scp-action-btn' : 'menu_button interactable';
    renameBtn.innerHTML = `<i class="fa-solid fa-pen"></i><span>Rename</span>`;
    if (!isSP) renameBtn.style.flex = '1';

    renameBtn.addEventListener('click', async () => {
        const val = typeSel.value;
        if (val === 'none') return;
        const bg = s.customBackgrounds[val];
        const newName = await showCustomDialog({ type: 'prompt', title: 'Rename Background', message: 'New name:', defaultValue: bg.name });
        if (newName && newName.trim()) {
            s.customBackgrounds[val].name = newName.trim();
            saveSettings();
            const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
            allContainers.forEach(c => buildBackgroundSettingsUI(c));
        }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = isSP ? 'scp-action-btn scp-sp-danger-btn' : 'menu_button interactable';
    deleteBtn.innerHTML = `<i class="fa-solid fa-trash"></i><span>Delete</span>`;
    if (!isSP) deleteBtn.style.flex = '1';

    deleteBtn.addEventListener('click', async () => {
        const val = typeSel.value;
        if (val === 'none') return;
        const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Background', message: 'Delete this background?' });
        if (!ok) return;
        const s2 = getSettings();
        delete s2.customBackgrounds[val];
        s2.windowBg = 'none';
        saveSettings();
        const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
        allContainers.forEach(c => buildBackgroundSettingsUI(c));
        applyWindowBackground();
    });
    
    customActionsWrap.appendChild(uploadBtn);
    customActionsWrap.appendChild(urlBtn);
    customActionsWrap.appendChild(renameBtn);
    customActionsWrap.appendChild(deleteBtn);
    container.appendChild(customActionsWrap);

    // EXTRA SETTINGS (Fit & Dim)
    const extraWrap = document.createElement('div');
    extraWrap.style.cssText = 'margin-top:12px';

    const fitRow = document.createElement('div');
    fitRow.className = isSP ? 'scp-sp-field' : '';
    const fitLbl = document.createElement('label');
    fitLbl.className = isSP ? 'scp-sp-label' : '';
    if (!isSP) fitLbl.style.cssText = 'font-size:11px;color:#888;display:block;margin-bottom:4px';
    fitLbl.textContent = 'Image/Video Fit';
    const fitSel = document.createElement('select');
    fitSel.className = isSP ? 'scp-sp-select text_pole' : 'text_pole';
    ['cover', 'contain', 'fill', 'center'].forEach(f => {
        const opt = document.createElement('option'); opt.value = f; opt.textContent = f; fitSel.appendChild(opt);
    });
    
    const currentBgData = s.customBackgrounds[s.windowBg];
    fitSel.value = currentBgData?.fit || 'cover';
    
    fitSel.addEventListener('change', () => {
        if (s.windowBg !== 'none' && s.customBackgrounds[s.windowBg]) {
            s.customBackgrounds[s.windowBg].fit = fitSel.value;
            saveSettings();
            const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
            allContainers.forEach(c => { const s = c.querySelector('select[id$="fit-sel"]'); if(s) s.value = fitSel.value; });
            applyWindowBackground();
        }
    });
    fitSel.id = isSP ? 'scp-sp-fit-sel' : 'scp-fit-sel';
    fitRow.appendChild(fitLbl); fitRow.appendChild(fitSel);
    extraWrap.appendChild(fitRow);

    const dimRow = document.createElement('div');
    dimRow.className = isSP ? 'scp-sp-field' : '';
    dimRow.style.marginTop = '8px';
    const dimLbl = document.createElement('label');
    dimLbl.className = isSP ? 'scp-sp-label' : '';
    if (!isSP) dimLbl.style.cssText = 'font-size:11px;color:#888;display:block;margin-bottom:4px';
    dimLbl.textContent = 'Darkness Overlay';
    const dimFlex = document.createElement('div');
    dimFlex.className = isSP ? 'scp-sp-row' : '';
    if (!isSP) dimFlex.style.cssText = 'display:flex;align-items:center;gap:10px';
    
    const dimSlider = document.createElement('input');
    dimSlider.type = 'range'; dimSlider.min = '0'; dimSlider.max = '100';
    dimSlider.className = isSP ? 'scp-slider' : 'neo-range-slider';
    dimSlider.style.flex = '1'; dimSlider.value = s.windowBgDim ?? 50;
    
    const dimVal = document.createElement('span');
    dimVal.style.cssText = isSP ? 'min-width:32px;text-align:right;font-size:11px;color:var(--scp-accent)' : 'font-size:12px;min-width:34px;text-align:right;color:var(--SmartThemeQuoteColor,#a99bfb)';
    dimVal.textContent = `${dimSlider.value}%`;

    dimSlider.addEventListener('input', () => { dimVal.textContent = `${dimSlider.value}%`; });
    dimSlider.addEventListener('change', () => {
        getSettings().windowBgDim = parseInt(dimSlider.value); saveSettings();
        const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
        allContainers.forEach(c => { const s = c.querySelector('input[type="range"]'); if(s && s !== dimSlider) { s.value = dimSlider.value; s.nextElementSibling.textContent = `${dimSlider.value}%`; } });
        applyWindowBackground();
    });

    dimFlex.appendChild(dimSlider); dimFlex.appendChild(dimVal);
    dimRow.appendChild(dimLbl); dimRow.appendChild(dimFlex);
    extraWrap.appendChild(dimRow);

    container.appendChild(extraWrap);

    const updateVisibility = () => {
        const isNone = typeSel.value === 'none';
        renameBtn.style.display = isNone ? 'none' : '';
        deleteBtn.style.display = isNone ? 'none' : '';
        extraWrap.style.display = isNone ? 'none' : 'block';
    };
    updateVisibility();

    typeSel.addEventListener('change', () => {
        getSettings().windowBg = typeSel.value;
        saveSettings();
        updateVisibility();
        const allContainers = [document.getElementById('scp-bg-settings'), document.getElementById('scp-sp-bg-settings')].filter(Boolean);
        allContainers.forEach(c => buildBackgroundSettingsUI(c));
        applyWindowBackground();
    });
}

export function applyWindowBackground() {
    if (!getWindowEl()) return;
    const s = getSettings();
    const bgId = s.windowBg || 'none';
    const dim = (s.windowBgDim ?? 50) / 100;

    getWindowEl().style.removeProperty('--scp-bg-image');
    getWindowEl().classList.remove('scp-has-bg');
    
    let mediaEl = document.getElementById('scp-bg-media');

    if (bgId === 'none' || !s.customBackgrounds || !s.customBackgrounds[bgId]) {
        if (mediaEl) mediaEl.remove();
        return;
    }

    const bg = s.customBackgrounds[bgId];
    const fit = bg.fit || 'cover';

    const isVideo = bg.isVideo;
    if (mediaEl) {
        const isVideoTag = mediaEl.tagName.toLowerCase() === 'video';
        if (isVideo !== isVideoTag) {
            mediaEl.remove();
            mediaEl = null;
        }
    }

    if (!mediaEl) {
        mediaEl = document.createElement(isVideo ? 'video' : 'img');
        mediaEl.id = 'scp-bg-media';
        if (isVideo) {
            mediaEl.autoplay = true; 
            mediaEl.loop = true; 
            mediaEl.muted = true; 
            mediaEl.playsInline = true;
        }
        getWindowEl().insertBefore(mediaEl, getWindowEl().firstChild);
    }

    mediaEl.className = `scp-bg-media bg-${fit}`;
    if (mediaEl.src !== bg.dataUrl) mediaEl.src = bg.dataUrl;
    
    getWindowEl().style.setProperty('--scp-bg-dim', dim);
    getWindowEl().classList.add('scp-has-bg');
}

export function _setupAttachButton() {
    const btn = document.getElementById('scp-attach-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.multiple = true;
        inp.accept = 'image/*,text/*,.pdf,.json,.txt,.md,.csv,.log,.js,.py,.html,.css';
        inp.onchange = () => { if (inp.files?.length) addAttachments(Array.from(inp.files)); };
        inp.click();
    });
}

export async function _uploadBackgroundToST(file) {
    const formData = new FormData();
    formData.append('avatar', file);
    const ctx = SillyTavern.getContext();
    const headers = ctx.getRequestHeaders();
    delete headers['Content-Type'];
    const res = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        headers,
        body: formData
    });
    if (res.ok) {
        const text = await res.text();
        let filename = text;
        try { const j = JSON.parse(text); if (j.path) filename = j.path; } catch(e){}
        if (!filename.startsWith('/')) filename = `/backgrounds/${filename}`;
        return filename;
    }
    throw new Error('Background upload failed');
}

export function _setupBgUpload(btnId, inputId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/*,video/mp4,video/webm';
        inp.onchange = async () => {
            const file = inp.files[0];
            if (!file) return;
            if (file.size > 25 * 1024 * 1024) { toastr.warning('File is too large (>25MB). Use URL instead.', EXT_DISPLAY); return; }
            const url = await _uploadBackgroundToST(file).catch(() => null);
            if (url) {
                getSettings().windowBgUrl = url;
                saveSettings();
                const urlInput = document.getElementById(inputId);
                if (urlInput) urlInput.value = url;
                applyWindowBackground();
                _syncBgToOverlayFn();
            } else {
                toastr.error('Failed to upload background.', EXT_DISPLAY);
            }
        };
        inp.click();
    });
}

export function applyCustomTheme(theme) {
    if (!theme) return;
    const targets = [getWindowEl(), getIconEl(), document.getElementById('scp-lb-overlay'), document.getElementById('scp-diff-modal'), document.getElementById('scp-settings-overlay'), document.getElementById('scp-picker-overlay')].filter(Boolean);
    const s = getSettings();
    
    for (const [key, cssVar] of Object.entries(THEME_CSS_MAP)) {
        if (key === 'font') continue;
        if (theme[key] !== undefined && theme[key] !== '') {
            let val = theme[key];
            
            if (s.performanceMode) {
                if (key === 'blur') val = 'none';
                if (key === 'shadow') val = '0 8px 24px rgba(0,0,0,0.85)';
                if (key === 'bg' && val.includes('rgba')) {
                    val = val.replace(/,\s*0\.[0-8]\d*\)/, ', 0.96)');
                }
            }

            targets.forEach(t => t.style.setProperty(cssVar, val));
        }
    }
    const fontVal = (theme.font || '').trim();
    targets.forEach(t => fontVal
        ? t.style.setProperty('--scp-font', fontVal)
        : t.style.removeProperty('--scp-font'));
}


// ─── Window State ───────────────────────────────────────────────────────────

export function saveWindowState() {
    const s = getSettings(); if (!getWindowEl()) return;
    const r = getWindowEl().getBoundingClientRect();
    s.windowX = r.left; s.windowY = r.top; s.windowW = r.width; s.windowH = r.height;
    saveSettings();
}

export function _getViewportSize() {
    const vv = window.visualViewport;
    return {
        w: vv ? vv.width : window.innerWidth,
        h: vv ? vv.height : window.innerHeight,
    };
}

export function restoreWindowState() {
    const s = getSettings(); if (!getWindowEl()) return;
    const isMobile = window.innerWidth <= 900 || ('ontouchstart' in window && window.innerWidth <= 1366);
    
    const w = s.windowW || 440;
    const h = s.windowH || 600;
    
    if (s.windowX !== null) {
        const maxLeft = Math.max(0, window.innerWidth - (isMobile ? window.innerWidth * 0.94 : w));
        getWindowEl().style.left = `${Math.max(0, Math.min(s.windowX, maxLeft))}px`;
        const maxTop = Math.max(0, window.innerHeight - 100);
        getWindowEl().style.top = `${Math.max(0, Math.min(s.windowY ?? 80, maxTop))}px`;
        getWindowEl().style.right = 'auto';
    } else if (isMobile) {
        getWindowEl().style.left = '3vw';
        getWindowEl().style.top = '8vh';
        getWindowEl().style.right = 'auto';
    }
    
    if (getIconEl()) {
        const savedIconPos = localStorage.getItem(ICON_STORAGE_KEY);
        let posValid = false;
        const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const iconSize = 46;

        if (savedIconPos) {
            try {
                const pos = JSON.parse(savedIconPos);
                const left = parseFloat(pos.left);
                const top = parseFloat(pos.top);
                if (!isNaN(left) && !isNaN(top) && left >= 0 && top >= 0 && left + iconSize <= vw && top + iconSize <= vh) {
                    getIconEl().style.left = `${left}px`;
                    getIconEl().style.top = `${top}px`;
                    getIconEl().style.bottom = 'auto';
                    getIconEl().style.right = 'auto';
                    posValid = true;
                }
            } catch {
                localStorage.removeItem(ICON_STORAGE_KEY);
            }
        }
        
        if (!posValid) {
            const defaultRight = isMobile ? 16 : 20;
            const defaultBottom = isMobile ? 120 : 80;
            getIconEl().style.left = `${Math.max(0, vw - iconSize - defaultRight)}px`;
            getIconEl().style.top = `${Math.max(0, vh - iconSize - defaultBottom)}px`;
            getIconEl().style.bottom = 'auto';
            getIconEl().style.right = 'auto';
        }
    }
    
    if (isMobile) {
        getWindowEl().style.width = `${Math.min(w, Math.floor(window.innerWidth * 0.94), 560)}px`;
        getWindowEl().style.height = `${Math.min(h, Math.floor(window.innerHeight * 0.82), 700)}px`;
    } else {
        getWindowEl().style.width = `${w}px`;
        getWindowEl().style.height = `${h}px`;
    }
    getWindowEl().style.opacity = ((s.opacity || 95) / 100).toString();
    applyCustomTheme(s.customTheme || THEME_PRESETS.default);
    applyWindowBackground();
}


// ─── Visibility ─────────────────────────────────────────────────────────────

export function updateIconVisibility() {
    if (!getIconEl()) return;
    const s = getSettings();
    
    if (!s.enabled) {
        getIconEl().style.setProperty('display', 'none', 'important');
        return;
    }
    
    if (s.minimized || s.floatingIconPersistent) {
        getIconEl().style.setProperty('display', 'flex', 'important');
    } else {
        getIconEl().style.setProperty('display', 'none', 'important');
    }
}

export function minimize() { 
    setGhostMode(false); 
    const s = getSettings(); 
    s.minimized = true; 
    getWindowEl().style.display = 'none'; 
    setCopilotActive(false);
    saveSettings(); 
    updateIconVisibility();
}

export function restoreFromMinimize() { 
    const s = getSettings(); 
    s.minimized = false; 
    getWindowEl().style.display = 'flex'; 
    setCopilotActive(true);
    saveSettings(); 
    updateIconVisibility();
    scrollToBottom(); 
}

export function hideWindow() { 
    setGhostMode(false); 
    const s = getSettings(); 
    s.windowVisible = false; 
    s.minimized = false; 
    getWindowEl().style.display = 'none'; 
    setCopilotActive(false);
    saveSettings(); 
    updateIconVisibility();
}

export function showWindow() {
    const s = getSettings(); 
    if (!s.enabled) { toastr.warning('ST-Copilot is disabled.', EXT_DISPLAY); return; }
    s.windowVisible = true; 
    s.minimized = false;
    getWindowEl().style.display = 'flex';
    setCopilotActive(true);
    resetUserScrolledUp();
    saveSettings(); 
    updateIconVisibility();
    scrollToBottom();
}

export function toggleVisibility() {
    const s = getSettings();
    if (!s.windowVisible || s.minimized) { showWindow(); return; }
    if (s.floatingIconPersistent) { hideWindow(); } else { minimize(); }
}


// ─── Ghost Mode ──────────────────────────────────────────────────────────────

let _ghostModeActive = false;
let _ghostHotkeyHandler = null;

// Exported so other modules (ui-settings.js's opacity sliders) can check
// ghost-mode state without reaching into this file's private variable.
export function isGhostModeActive() { return _ghostModeActive; }

export function setGhostMode(enabled) {
    _ghostModeActive = enabled;
    if (!getWindowEl()) return;
    const s = getSettings();
    const ghostBtn = document.getElementById('scp-ghost-btn');

    if (enabled) {
        const opacity = Math.max(15, Math.min(50, s.ghostModeOpacity ?? 15)) / 100;
        getWindowEl().classList.add('scp-ghost-mode');
        getWindowEl().style.opacity = opacity.toString();
        ghostBtn?.classList.add('active');
    } else {
        getWindowEl().classList.remove('scp-ghost-mode');
        getWindowEl().style.opacity = ((s.opacity ?? 95) / 100).toString();
        ghostBtn?.classList.remove('active');
    }
}

export function toggleGhostMode() {
    if (!getWindowEl() || getWindowEl().style.display === 'none') return;
    setGhostMode(!_ghostModeActive);
}

export function setupGhostHotkey() {
    if (_ghostHotkeyHandler) document.removeEventListener('keydown', _ghostHotkeyHandler);
    _ghostHotkeyHandler = null;
    const s = getSettings();
    if (!s.ghostModeHotkeyEnabled || !s.ghostModeHotkey) return;
    const parts = s.ghostModeHotkey.toLowerCase().split('+').map(p => p.trim());
    const key = parts[parts.length - 1];
    const needAlt = parts.includes('alt');
    const needCtrl = parts.includes('ctrl') || parts.includes('control');
    const needShift = parts.includes('shift');
    const needMeta = parts.includes('meta') || parts.includes('cmd');
    _ghostHotkeyHandler = e => {
        if (e.key.toLowerCase() !== key) return;
        if (needAlt !== e.altKey || needCtrl !== e.ctrlKey || needShift !== e.shiftKey || needMeta !== e.metaKey) return;
        e.preventDefault();
        toggleGhostMode();
    };
    document.addEventListener('keydown', _ghostHotkeyHandler);
}


// ─── Hotkey ─────────────────────────────────────────────────────────────────

let _hotkeyHandler = null;

export function setupHotkey() {
    if (_hotkeyHandler) document.removeEventListener('keydown', _hotkeyHandler);
    const s = getSettings();
    if (!s.enabled || !s.hotkeyEnabled || !s.hotkey) return;
    const parts = s.hotkey.toLowerCase().split('+').map(p => p.trim());
    const key = parts[parts.length - 1];
    const needAlt = parts.includes('alt'), needCtrl = parts.includes('ctrl') || parts.includes('control');
    const needShift = parts.includes('shift'), needMeta = parts.includes('meta') || parts.includes('cmd');
    _hotkeyHandler = e => {
        if (e.key.toLowerCase() !== key) return;
        if (needAlt !== e.altKey || needCtrl !== e.ctrlKey || needShift !== e.shiftKey || needMeta !== e.metaKey) return;
        const active = document.activeElement;
        if (active && active !== $('scp-input') && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
        e.preventDefault(); toggleVisibility();
    };
    document.addEventListener('keydown', _hotkeyHandler);
}

let _searchHotkeyHandler = null;

export function setupSearchHotkey() {
    if (_searchHotkeyHandler) document.removeEventListener('keydown', _searchHotkeyHandler, true);
    _searchHotkeyHandler = null;
    const s = getSettings();
    if (!s.enabled || !s.searchHotkeyEnabled || !s.searchHotkey) return;

    const parts = s.searchHotkey.toLowerCase().split('+').map(p => p.trim());
    const key = parts[parts.length - 1];
    const needAlt = parts.includes('alt');
    const needCtrl = parts.includes('ctrl') || parts.includes('control');
    const needShift = parts.includes('shift');
    const needMeta = parts.includes('meta') || parts.includes('cmd');

    _searchHotkeyHandler = e => {
        if (e.key.toLowerCase() !== key) return;
        if (needAlt !== e.altKey || needCtrl !== e.ctrlKey || needShift !== e.shiftKey || needMeta !== e.metaKey) return;
        
        if (!isCopilotActive()) return;
        
        const win = document.getElementById(WIN_ID);
        if (!win || win.style.display === 'none') return;
        
        e.preventDefault();
        e.stopPropagation();
        if (isSearchOpen()) { document.getElementById('scp-search-input')?.focus(); }
        else openSearch();
    };
    document.addEventListener('keydown', _searchHotkeyHandler, true);
}


const _PROFILE_KEYS = [
    'systemPrompt', 'includeSystemPrompt', 'includeAuthorsNote', 
    'includeCharacterCard', 'includeUserPersonality', 'contextDepth', 
    'localHistoryLimit', 'connectionSource', 'connectionProfileId', 'maxTokens',
    'applyRegexToContext', 'includeInlineSummaryOriginals', 'reasoningTrimStrings', 'forceStreaming',
    'charEditAIEnabled', 'charEditPrompt', 'lorebookAIManageEnabled',
    'lorebookManagePrompt', 'lorebookAutoKeyword', 'lorebookSTScanDepth',
    'lorebookCopilotScanDepth', 'chatEditAIEnabled', 'chatEditPrompt',
];

let _profileSnapshot = null;

export function _takeProfileSnapshot() {
    const s = getSettings();
    _profileSnapshot = {};
    for (const k of _PROFILE_KEYS) _profileSnapshot[k] = JSON.stringify(s[k]);
    _profileSnapshot._charEditFields = JSON.stringify(s.charEditFields || {});
}

export function isConfigProfileDirty() {
    if (!_profileSnapshot) return false;
    const s = getSettings();
    for (const k of _PROFILE_KEYS) {
        if (JSON.stringify(s[k]) !== _profileSnapshot[k]) return true;
    }
    if (JSON.stringify(s.charEditFields || {}) !== _profileSnapshot._charEditFields) return true;
    return false;
}

export function saveProfile(name) {
    const s = getSettings();
    const p = {};
    for (const k of _PROFILE_KEYS) p[k] = s[k];
    p.charEditFields = JSON.parse(JSON.stringify(s.charEditFields || {}));
    s.profiles[name] = p;
    s.activeProfile = name; 
    saveSettings();
}

export function loadProfile(name) {
    const s = getSettings(); const p = s.profiles[name]; if (!p) return;
    for (const k of _PROFILE_KEYS) {
        if (p[k] !== undefined) s[k] = p[k];
    }
    if (p.charEditFields) s.charEditFields = JSON.parse(JSON.stringify(p.charEditFields));
    s.activeProfile = name;
    saveSettings();
    _updateSettingsUI();
    _takeProfileSnapshot();
    _configDirty = false;
    _updateDirtyDots();
}

export function deleteProfile(name) {
    const s = getSettings(); delete s.profiles[name];
    if (s.activeProfile === name) s.activeProfile = '';
    for (const k in s.profileBindings) { if (s.profileBindings[k] === name) delete s.profileBindings[k]; }
    saveSettings();
}

export function refreshProfilesDropdown() {
    const sel = $('scp-profile-select'); if (!sel) return;
    const s = getSettings();

    if (Object.keys(s.profiles).length === 0) {
        s.profiles['Default'] = {
            systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true,
            includeAuthorsNote: true, includeCharacterCard: true,
            includeUserPersonality: true, contextDepth: 15,
            localHistoryLimit: 50,
            connectionSource: 'default', connectionProfileId: '',
            maxTokens: 8200,
            applyRegexToContext: true,
            includeInlineSummaryOriginals: false,
        };
        s.activeProfile = 'Default';
        saveSettings();
    }

    sel.innerHTML = '';
    let hasActive = false;

    for (const name of Object.keys(s.profiles)) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        if (name === s.activeProfile) {
            opt.selected = true;
            hasActive = true;
        }
        sel.appendChild(opt);
    }

    if (!hasActive && Object.keys(s.profiles).length > 0) {
        const first = Object.keys(s.profiles)[0];
        loadProfile(first);
        sel.value = first;
    }

    updateBindingSection();
}
export function updateBindingSection() {
    const sel = $('scp-profile-select'); const section = $('scp-binding-section');
    if (!section) return;
    const hasProfile = sel?.value;
    section.style.display = hasProfile ? '' : 'none';
    if (!hasProfile) return;
    const s = getSettings(); const { charId, chatId } = getBindingKey();
    const charKey = `char_${charId}`; const chatKey = `chat_${charId}_${chatId}`;
    const charBtn = $('scp-bind-char'); const chatBtn = $('scp-bind-chat');
    if (charBtn) charBtn.classList.toggle('active', s.profileBindings[charKey] === sel.value);
    if (chatBtn) chatBtn.classList.toggle('active', s.profileBindings[chatKey] === sel.value);
}

export function autoLoadBoundProfile() {
    const s = getSettings(); const { charId, chatId } = getBindingKey();
    const name = s.profileBindings[`chat_${charId}_${chatId}`] || s.profileBindings[`char_${charId}`];
    if (name && s.profiles[name]) {
        loadProfile(name);
        const sel = $('scp-profile-select'); if (sel) sel.value = name;
    }
}


export function isThemeDirty() {
    const s = getSettings();
    const current = s.customTheme || {};
    
    if (s.activeThemeProfile && s.savedThemes[s.activeThemeProfile]) {
        const saved = s.savedThemes[s.activeThemeProfile];
        return THEME_VAR_DEFS.some(def => (current[def.key] || '') !== (saved[def.key] || ''));
    }
    
    for (const preset of Object.values(THEME_PRESETS)) {
        const isMatch = THEME_VAR_DEFS.every(def => (current[def.key] || '') === (preset[def.key] || ''));
        if (isMatch) return false;
    }
    
    return true;
}

export function buildThemeEditor(containerOverride) {
    const container = containerOverride || $('scp-theme-section'); if (!container) return;
    container.innerHTML = '';
    const s = getSettings();

    if (!s.savedThemes || Object.keys(s.savedThemes).length === 0) {
        s.savedThemes = { 'Default': { ...THEME_PRESETS.default } };
        s.activeThemeProfile = 'Default';
        s.customTheme = { ...s.savedThemes['Default'] };
        saveSettings();
    }

    const profileRow = document.createElement('div');
    profileRow.className = 'scp-profile-bar';
    profileRow.style.marginBottom = '12px';
    profileRow.innerHTML = `
        <select id="scp-theme-profile-select"></select>
        <button class="scp-profile-icon-btn" id="scp-theme-save" title="Save current theme parameters"><i class="fa-solid fa-floppy-disk"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-create" title="Create new theme from preset"><i class="fa-solid fa-plus"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-duplicate" title="Duplicate selected theme"><i class="fa-solid fa-copy"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-rename" title="Rename selected theme"><i class="fa-solid fa-pen"></i></button>
        <button class="scp-profile-icon-btn danger" id="scp-theme-delete" title="Delete selected theme"><i class="fa-solid fa-trash"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-export" title="Export theme to JSON file"><i class="fa-solid fa-file-export"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-import" title="Import theme from JSON file"><i class="fa-solid fa-file-import"></i></button>
    `;
    container.appendChild(profileRow);

    const sel = profileRow.querySelector('#scp-theme-profile-select');

    const optGrpDefault = document.createElement('optgroup');
    optGrpDefault.label = 'Default Presets';
    for (const [key, preset] of Object.entries(THEME_PRESETS)) {
        const opt = document.createElement('option');
        opt.value = `__preset__${key}`;
        opt.textContent = preset.label;
        optGrpDefault.appendChild(opt);
    }
    sel.appendChild(optGrpDefault);

    const userThemeKeys = Object.keys(s.savedThemes);
    if (userThemeKeys.length) {
        const optGrpCustom = document.createElement('optgroup');
        optGrpCustom.label = 'Custom Themes';
        for (const name of userThemeKeys) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === s.activeThemeProfile) opt.selected = true;
            optGrpCustom.appendChild(opt);
        }
        sel.appendChild(optGrpCustom);
    }

    if (!s.activeThemeProfile || !s.savedThemes[s.activeThemeProfile]) {
        const matchKey = Object.keys(THEME_PRESETS).find(k =>
            THEME_VAR_DEFS.every(d => (s.customTheme?.[d.key] || '') === (THEME_PRESETS[k][d.key] || ''))
        );
        if (matchKey) sel.value = `__preset__${matchKey}`;
    }

    sel.addEventListener('change', async () => {
        const name = sel.value;

        if (isThemeDirty()) {
            const ok = await showCustomDialog({
                type: 'confirm',
                title: 'Unsaved Changes',
                message: 'You have unsaved changes in your current theme. Are you sure you want to switch?'
            });
            if (!ok) {
                sel.value = s.activeThemeProfile ? s.activeThemeProfile : (Object.keys(THEME_PRESETS).find(k => `__preset__${k}` === sel.value) ? sel.value : '');
                return;
            }
        }

        if (name.startsWith('__preset__')) {
            const presetKey = name.replace('__preset__', '');
            const s2 = getSettings();
            s2.customTheme = { ...THEME_PRESETS[presetKey] };
            s2.activeThemeProfile = '';
            saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride);
        } else if (name && getSettings().savedThemes[name]) {
            const s2 = getSettings();
            s2.customTheme = { ...s2.savedThemes[name] };
            s2.activeThemeProfile = name;
            saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride);
        }
    });

    profileRow.querySelector('#scp-theme-save').addEventListener('click', async () => {
        const val = sel.value;
        if (val.startsWith('__preset__')) {
            const name = await showCustomDialog({ type: 'prompt', title: 'Save as Custom Theme', message: 'Name for your custom theme:', placeholder: 'My Theme' });
            if (!name?.trim()) return;
            const n = name.trim();
            const s2 = getSettings();
            s2.savedThemes[n] = { ...s2.customTheme };
            s2.activeThemeProfile = n;
            saveSettings(); buildThemeEditor(containerOverride); toastr.success(`Theme "${n}" saved`, EXT_DISPLAY);
            _clearDirty('theme');
        } else if (val) {
            const s2 = getSettings();
            s2.savedThemes[val] = { ...s2.customTheme };
            saveSettings(); toastr.success(`Theme "${val}" updated`, EXT_DISPLAY);
            _clearDirty('theme');
        }
    });

    profileRow.querySelector('#scp-theme-create').addEventListener('click', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'New Theme', message: 'Enter name for new custom theme:', placeholder: 'My New Theme' });
        if (!name?.trim()) return;
        const n = name.trim();
        const s2 = getSettings();
        s2.savedThemes[n] = { ...s2.customTheme };
        s2.activeThemeProfile = n;
        saveSettings(); buildThemeEditor(containerOverride); toastr.success(`Created theme "${n}"`, EXT_DISPLAY);
    });

    profileRow.querySelector('#scp-theme-duplicate').addEventListener('click', async () => {
        const val = sel.value;
        if (!val) return;
        const baseTheme = val.startsWith('__preset__') ? THEME_PRESETS[val.replace('__preset__', '')] : s.savedThemes[val];
        if (!baseTheme) return;
        
        const defaultName = (val.startsWith('__preset__') ? THEME_PRESETS[val.replace('__preset__', '')].label : val) + ' (Copy)';
        const name = await showCustomDialog({ type: 'prompt', title: 'Duplicate Theme', message: 'Name for the duplicated theme:', defaultValue: defaultName });
        if (!name?.trim()) return;
        const n = name.trim();
        const s2 = getSettings();
        s2.savedThemes[n] = JSON.parse(JSON.stringify(baseTheme));
        s2.activeThemeProfile = n;
        s2.customTheme = { ...s2.savedThemes[n] };
        saveSettings(); buildThemeEditor(containerOverride); toastr.success(`Theme duplicated as "${n}"`, EXT_DISPLAY);
    });

    profileRow.querySelector('#scp-theme-rename').addEventListener('click', async () => {
        const val = sel.value;
        if (!val || val.startsWith('__preset__')) { toastr.info('Select a custom theme to rename.', EXT_DISPLAY); return; }
        const newName = await showCustomDialog({ type: 'prompt', title: 'Rename Theme', message: 'Enter new name:', defaultValue: val });
        if (!newName?.trim() || newName.trim() === val) return;
        const n = newName.trim();
        const s2 = getSettings();
        s2.savedThemes[n] = s2.savedThemes[val];
        delete s2.savedThemes[val];
        s2.activeThemeProfile = n;
        saveSettings(); buildThemeEditor(containerOverride); toastr.success('Theme renamed.', EXT_DISPLAY);
    });

    profileRow.querySelector('#scp-theme-delete').addEventListener('click', async () => {
        const val = sel.value;
        if (!val || val.startsWith('__preset__')) { toastr.info('Select a custom theme to delete.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Theme', message: `Delete "${val}"?` });
        if (!ok) return;
        const s2 = getSettings();
        delete s2.savedThemes[val];
        s2.activeThemeProfile = Object.keys(s2.savedThemes)[0] || '';
        if (s2.activeThemeProfile) s2.customTheme = { ...s2.savedThemes[s2.activeThemeProfile] };
        else { s2.customTheme = { ...THEME_PRESETS.default }; }
        saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride);
        toastr.success('Deleted.', EXT_DISPLAY);
    });

    profileRow.querySelector('#scp-theme-export').addEventListener('click', () => {
        const s2 = getSettings();
        const val = sel.value;
        const rawName = val.startsWith('__preset__') ? val.replace('__preset__', '') : (val || 'custom');
        const payload = JSON.stringify({ name: rawName, version: 1, theme: s2.customTheme }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `st-copilot-theme-${rawName.replace(/[^a-z0-9]/gi, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    profileRow.querySelector('#scp-theme-import').addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json';
        inp.onchange = async () => {
            const file = inp.files?.[0]; if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const imported = data.theme || data;
                if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Invalid format');
                const themeName = (data.name && typeof data.name === 'string')
                    ? data.name
                    : file.name.replace(/\.json$/i, '');
                const s2 = getSettings();
                s2.savedThemes[themeName] = { ...THEME_PRESETS.default, ...imported };
                s2.activeThemeProfile = themeName;
                s2.customTheme = { ...s2.savedThemes[themeName] };
                saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride);
                toastr.success(`Theme "${escHtml(themeName)}" imported.`, EXT_DISPLAY);
            } catch (e) {
                toastr.error('Invalid theme file.', EXT_DISPLAY);
            }
        };
        inp.click();
    });

    const grid = document.createElement('div'); grid.className = 'scp-theme-var-grid';
    for (const def of THEME_VAR_DEFS) {
        const item = document.createElement('div'); item.className = 'scp-theme-var-item';
        const label = document.createElement('div'); label.className = 'scp-theme-var-label'; label.textContent = def.label;
        const wrap = document.createElement('div'); wrap.className = 'scp-theme-var-wrap';
        const isColorKey = COLOR_KEYS.has(def.key);
        const isFontKey = def.key === 'font';

        const preview = document.createElement('div'); preview.className = 'scp-theme-var-preview';
        const curVal = s.customTheme?.[def.key] ?? '';
        if (isColorKey) {
            preview.style.background = curVal;
            preview.style.display = curVal ? '' : 'none';
            preview.classList.add('scp-color-clickable');
        } else {
            preview.style.display = 'none';
        }

        const input = document.createElement('input'); input.type = 'text'; input.className = 'scp-theme-var-input';
        input.value = curVal; input.placeholder = def.hint; input.dataset.key = def.key;
        const cssVar = THEME_CSS_MAP[def.key];
        const getDefaultVal = () => {
            const ss = getSettings();
            if (ss.activeThemeProfile && ss.savedThemes?.[ss.activeThemeProfile]) return ss.savedThemes[ss.activeThemeProfile][def.key] ?? '';
            const selEl = container.querySelector('#scp-theme-profile-select');
            const selVal = selEl?.value || '';
            if (selVal.startsWith('__preset__')) {
                const pk = selVal.replace('__preset__', '');
                return (THEME_PRESETS[pk] || THEME_PRESETS.default)[def.key] ?? '';
            }
            return THEME_PRESETS.default[def.key] ?? '';
        };
        const resetBtn = document.createElement('button');
        resetBtn.className = 'scp-theme-var-reset'; resetBtn.title = 'Reset to profile default'; resetBtn.textContent = '↺';
        const updateResetState = val => { resetBtn.disabled = !val || val === getDefaultVal(); };
        updateResetState(curVal);

        let _fontDebounce = null;
        const applyVal = val => {
            const s2 = getSettings();
            if (!s2.customTheme) s2.customTheme = {};
            s2.customTheme[def.key] = val;
            saveSettings();
            _markDirty('theme');
            if (isColorKey) {
                if (cssVar) [getWindowEl(), document.getElementById('scp-lb-overlay'), document.getElementById('scp-diff-modal')]
                    .filter(Boolean).forEach(t => t.style.setProperty(cssVar, val));
                preview.style.background = val;
                preview.style.display = val ? '' : 'none';
            } else if (isFontKey) {
                clearTimeout(_fontDebounce);
                _fontDebounce = setTimeout(() => {
                    const fontVal = val.trim();
                    const targets = [getWindowEl(), document.getElementById('scp-lb-overlay'),
                        document.getElementById('scp-diff-modal'), document.getElementById('scp-settings-overlay'),
                        document.getElementById('scp-picker-overlay')].filter(Boolean);
                    targets.forEach(t => fontVal
                        ? t.style.setProperty('--scp-font', fontVal)
                        : t.style.removeProperty('--scp-font'));
                }, 600);
            } else {
                if (cssVar) [getWindowEl(), document.getElementById('scp-lb-overlay'), document.getElementById('scp-diff-modal')]
                    .filter(Boolean).forEach(t => t.style.setProperty(cssVar, val));
            }
            if (input.value !== val) input.value = val;
            updateResetState(val);
        };
        input.addEventListener('input', () => applyVal(input.value));
        resetBtn.addEventListener('click', () => {
            const dv = getDefaultVal();
            applyVal(isFontKey ? (dv || '') : (dv || ''));
        });
        if (isColorKey) {
            preview.addEventListener('click', () => showColorPicker(preview, input.value || '#7c6dfa', val => applyVal(val)));
        }
        wrap.appendChild(preview); wrap.appendChild(input); wrap.appendChild(resetBtn);
        item.appendChild(label); item.appendChild(wrap); grid.appendChild(item);
    }
    container.appendChild(grid);
}


// ─── char Badge ─────────────────────────────────────────────────────────────

export function updateCharBadge() {
    const badge = $('scp-char-badge'); if (!badge) return;
    const ctx = SillyTavern.getContext(); const char = ctx.characters?.[ctx.characterId];
    if (char) { badge.textContent = char.name; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
}

export async function updateProfilesList() {
    const profSel = $('scp-conn-profile'); if (!profSel) return;
    const ctx = SillyTavern.getContext();
    let profiles = [];

    if (ctx.ConnectionManagerRequestService && typeof ctx.ConnectionManagerRequestService.getSupportedProfiles === 'function') {
        profiles = ctx.ConnectionManagerRequestService.getSupportedProfiles();
    } else {
        profiles = ctx.extensionSettings?.connectionManager?.profiles || [];
    }

    const s = getSettings(); 
    const currentVal = s.connectionProfileId || '';
    profSel.innerHTML = '<option value="">-- Select Profile --</option>';

    if (profiles && profiles.length > 0) {
        profiles.forEach(p => {
            const newOpt = document.createElement('option');
            newOpt.value = p.id;
            newOpt.textContent = p.name;
            profSel.appendChild(newOpt);
        });
    }
    if (Array.from(profSel.options).some(o => o.value === currentVal)) profSel.value = currentVal;
}
