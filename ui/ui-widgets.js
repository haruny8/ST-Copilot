/**
 * ui-widgets.js
 * Standalone floating UI widgets used throughout the window and the
 * Settings Panel: Quick Prompt chips + their settings editor, the generic
 * floating "preset dropdown" panel (and the two preset managers built on
 * top of it — prompt presets, quick-prompt sets), the Chat Message Picker
 * overlay, the Session Dropdown, and the Depth Slider's click-to-type
 * behavior. Grouped together because they're all small, mostly
 * self-contained floating-panel widgets rather than one big feature.
 *
 * Moved from original index.js:
 *   "SVG Icons" (7443-7475) — just the `I` icon-shorthand alias; the actual
 *     icon strings were already exported as `ICONS` from constants.js, so
 *     that duplicate object literal was dropped in favor of `const I = ICONS`.
 *   "Quick Prompts" (7476-7551)
 *   "Preset Dropdown" (7552-7671)
 *   "Prompt Preset Manager" (7672-7795)
 *   "Quick Prompt Sets Manager" (7796-8023)
 *   "Chat Message Picker" (8024-8240)
 *   "Session Dropdown" (11513-11678)
 *   "Depth Slider Click-to-Type" (11679-11711)
 *
 * NOT included from "Session Dropdown"'s neighboring sections: the old
 * "Profile System" section (11712-11834) that directly follows Session
 * Dropdown in the original file was already moved into ui-window.js in an
 * earlier pass (it's tightly coupled to Dirty State Tracking/Theme Editor
 * there) — re-checked here to confirm no duplication before writing this
 * file.
 *
 * UPDATE (later pass): "Session Import / Export" (10340-10399,
 * `exportCurrentSession` / `importSession`) has now been added to this file
 * too, even though it sits elsewhere in the original file next to
 * `setGeneratingState`/`handleSend` (which live in ui-chat.js instead). It
 * belongs here because it needs `closeSessPanel`/`refreshSessionDropdown`
 * (this file) and `renderSession` (ui-chat.js) — putting it in session.js
 * instead would create a session.js -> ui-widgets.js import cycle. The
 * dead `{ charId, chatId } = getBindingKey()` destructure from the
 * original `exportCurrentSession` (never actually used) was dropped.
 *
 * BUGS FOUND AND FIXED while wiring this file's imports (both in
 * session.js, unrelated to this file's own content):
 *   - `saveSessionFile` / `loadSessionFile` were private (unexported) in
 *     session.js because only session.js itself used them before. The
 *     Session Dropdown's orphaned-session recovery flow needs both
 *     directly, so both are now exported.
 *   - `updateDepthSlidersMax` (old "ST Context Helpers" line 6693) was
 *     never extracted into any module at all — it's called from both this
 *     file (Depth Slider Click-to-Type) and ui-settings.js (Settings Panel
 *     Handlers), so it now lives in session.js (added there, plus
 *     ui-settings.js's import list, in this same pass) to avoid a circular
 *     import between the two UI modules.
 *
 * FORWARD DEP: `setupDepthClickEdit` and the preset dropdown both call
 * `syncOverlayUI`, which lives in ui-settings.js. That's a plain one-way
 * import (ui-widgets.js -> ui-settings.js) with no cycle, since
 * ui-settings.js reaches back into this file only via forward-dep stubs
 * wired at bootstrap time, never a static import.
 */

import { EXT_DISPLAY, ICONS, THEME_PRESETS } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import {
    commitBucketChanges, genId, getChatBucket, getCurrentSession, loadSessionFile,
    getEffectiveSettings, makeChatPickKey, parseChatPickKey, saveSessionFile,
    saveSessionsToMetadata, setActiveSession, updateDepthSlidersMax,
} from '../session.js';
import { $, autoResize, escHtml, showCustomDialog } from '../utils/util-dom.js';
import { getBindingKey } from '../utils/util-st.js';
import { recordStat, STAT } from '../features/feature-stats.js';
import { getCharInfo, getMainChatMessageEntries } from '../api.js';
import { renderSession, updateMsgCount } from './ui-chat.js';
import { syncOverlayUI } from './ui-settings.js';
import { applyCustomTheme } from './ui-window.js';

// ─── SVG Icons ──────────────────────────────────────────────────────────────

// Local shorthand alias for the ICONS constant (imported from constants.js)
// -- keeps this file's icon references (I.trash, I.plus, etc.) unchanged from the original.
const I = ICONS;

// ─── Quick Prompts ───────────────────────────────────────────────────────────

const QP_ICON_POOL = [
    '🔍','💡','📋','✨','🎭','📖','🗺️','⚔️','🧠','💬',
    '🎯','🔮','📝','🌍','❓','🎨','💭','🔥','⚡','🎲',
    '👁️','🧩','📚','🗣️','💫','🌟','🎬','🧪','🏆','🎵',
    '🌙','☀️','🌊','🍃','💎','🛡️','🗡️','🏰','🐉','🦋',
    '🎪','🌀','🔑','💀','🌹','🍷','🎩','🧿','🔔','⭐',
    '🐺','🦊','🐦','🌸','🍄','🔴','🟣','🔵','🟡','🟢',
];

export function renderQuickPromptsBar() {
    const bar = document.getElementById('scp-qp-bar');
    const toggleBtn = document.getElementById('scp-qp-toggle-btn');
    if (!bar) return;
    const s = getSettings();
    const prompts = s.quickPrompts || [];
    const visible = s.quickPromptsVisible && prompts.length > 0;

    bar.innerHTML = '';
    for (const qp of prompts) {
        const btn = document.createElement('button');
        btn.className = 'scp-qp-chip';
        const truncTitle = qp.text.length > 100 ? qp.text.slice(0, 100) + '…' : qp.text;
        btn.title = truncTitle;
        btn.innerHTML = `<span class="scp-qp-icon">${escHtml(qp.icon || '⚡')}</span><span class="scp-qp-label">${escHtml(qp.label || '')}</span>`;
        btn.addEventListener('click', () => {
            const input = document.getElementById('scp-input');
            if (!input) return;
            input.value = qp.text;
            autoResize(input);
            input.focus();
            recordStat(STAT.qp);
        });
        bar.appendChild(btn);
    }

    if (visible) {
        bar.classList.add('scp-qp-bar--open');
    } else {
        bar.classList.remove('scp-qp-bar--open');
    }
    if (toggleBtn) toggleBtn.classList.toggle('active', s.quickPromptsVisible);
}

let _qpIconPickerEl = null;

function showQPIconPicker(anchorEl, currentIcon, onSelect) {
    if (_qpIconPickerEl) { _qpIconPickerEl.remove(); _qpIconPickerEl = null; }
    const pop = document.createElement('div');
    pop.className = 'scp-qp-icon-picker';
    for (const emoji of QP_ICON_POOL) {
        const btn = document.createElement('button');
        btn.className = `scp-qp-icon-option${emoji === currentIcon ? ' active' : ''}`;
        btn.textContent = emoji;
        btn.addEventListener('click', () => { onSelect(emoji); pop.remove(); _qpIconPickerEl = null; });
        pop.appendChild(btn);
    }
    document.body.appendChild(pop);
    _qpIconPickerEl = pop;
    const rect = anchorEl.getBoundingClientRect();
    pop.style.cssText = `position:fixed;z-index:999999;top:${rect.bottom + 4}px;left:${rect.left}px`;
    requestAnimationFrame(() => {
        const pr = pop.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8) pop.style.left = `${window.innerWidth - pr.width - 8}px`;
        if (pr.bottom > window.innerHeight - 8) pop.style.top = `${rect.top - pr.height - 6}px`;
    });
    const onOut = e => {
        if (!pop.contains(e.target) && e.target !== anchorEl) {
            pop.remove(); _qpIconPickerEl = null;
            document.removeEventListener('mousedown', onOut, true);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', onOut, true), 0);
}

// ─── Preset Dropdown (beautiful floating panel) ───────────────────────────────

let _activePresetPanel = null;

function openPresetDropdown(triggerEl, groups, onSelect, opts = {}) {
    // groups: [{ label, items: [{ name, value, preview, badge }] }]
    const { placeholder = 'Search…', width = 320, emptyText = 'Nothing here' } = opts;

    if (_activePresetPanel) {
        _activePresetPanel.remove();
        _activePresetPanel = null;
        triggerEl.classList.remove('open');
        return; // toggle close
    }

    triggerEl.classList.add('open');

    const panel = document.createElement('div');
    panel.className = 'scp-pdd-panel';
    panel.style.width = `${width}px`;
    _activePresetPanel = panel;

    const allItems = groups.flatMap(g => g.items);

    if (allItems.length > 6) {
        const sw = document.createElement('div');
        sw.className = 'scp-pdd-search-wrap';
        const si = document.createElement('input');
        si.type = 'text'; si.placeholder = placeholder;
        si.className = 'scp-pdd-search';
        si.addEventListener('input', () => renderContent(si.value.trim().toLowerCase()));
        sw.appendChild(si);
        panel.appendChild(sw);
        setTimeout(() => si.focus(), 60);
    }

    const listEl = document.createElement('div');
    listEl.className = 'scp-pdd-list';
    panel.appendChild(listEl);

    const renderContent = (q = '') => {
        listEl.innerHTML = '';
        let totalShown = 0;
        groups.forEach(group => {
            const filtered = q
                ? group.items.filter(it => it.name.toLowerCase().includes(q) || (it.preview || '').toLowerCase().includes(q))
                : group.items;
            if (!filtered.length) return;
            totalShown += filtered.length;
            if (group.label) {
                const hdr = document.createElement('div');
                hdr.className = 'scp-pdd-group-label';
                hdr.textContent = group.label;
                listEl.appendChild(hdr);
            }
            filtered.forEach(item => {
                const row = document.createElement('div');
                row.className = 'scp-pdd-item';
                const top = document.createElement('div');
                top.className = 'scp-pdd-item-top';
                const name = document.createElement('span');
                name.className = 'scp-pdd-item-name';
                name.textContent = item.name;
                top.appendChild(name);
                if (item.badge) {
                    const b = document.createElement('span');
                    b.className = `scp-pdd-badge scp-pdd-badge--${item.badge}`;
                    b.textContent = item.badge;
                    top.appendChild(b);
                }
                row.appendChild(top);
                if (item.preview) {
                    const prev = document.createElement('div');
                    prev.className = 'scp-pdd-item-preview';
                    prev.textContent = item.preview;
                    row.appendChild(prev);
                }
                row.addEventListener('click', () => {
                    onSelect(item.value, item.name, item);
                    closePresetPanel();
                });
                listEl.appendChild(row);
            });
        });
        if (!totalShown) {
            const empty = document.createElement('div');
            empty.className = 'scp-pdd-empty';
            empty.textContent = q ? 'No results' : emptyText;
            listEl.appendChild(empty);
        }
    };

    renderContent();
    document.body.appendChild(panel);

    const rect = triggerEl.getBoundingClientRect();
    panel.style.cssText += `;position:fixed;z-index:999999;top:${rect.bottom + 5}px;left:${rect.left}px;max-width:calc(100vw - 16px)`;
    requestAnimationFrame(() => {
        const pr = panel.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8) panel.style.left = `${window.innerWidth - pr.width - 8}px`;
        if (pr.bottom > window.innerHeight - 8) panel.style.top = `${rect.top - pr.height - 5}px`;
    });

    setTimeout(() => {
        const onOut = e => {
            if (!panel.contains(e.target) && e.target !== triggerEl) {
                closePresetPanel();
                document.removeEventListener('mousedown', onOut, true);
            }
        };
        document.addEventListener('mousedown', onOut, true);
    }, 0);
}

function closePresetPanel() {
    if (_activePresetPanel) { _activePresetPanel.remove(); _activePresetPanel = null; }
    document.querySelectorAll('.scp-pdd-trigger.open, .scp-preset-mgr-trigger.open')
        .forEach(el => el.classList.remove('open'));
}

// ─── Prompt Preset Manager ────────────────────────────────────────────────────

export function buildPromptPresetManager(containerEl, getTextFn, setTextFn, dictKey = 'promptPresets') {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    const s = getSettings();
    if (!s[dictKey]) s[dictKey] = {};

    let _activeName = '';
    let _activeSource = '';

    const bar = document.createElement('div');
    bar.className = 'scp-preset-mgr-bar';

    // Trigger
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'scp-preset-mgr-trigger';
    trigger.innerHTML = `<span class="scp-pmt-label">Select a preset…</span><svg class="scp-pmt-chevron" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    const labelEl = trigger.querySelector('.scp-pmt-label');

    const setActive = (name, source) => {
        _activeName = name;
        _activeSource = source;
        labelEl.textContent = name || 'Select a preset…';
        trigger.classList.toggle('scp-pmt--has-value', !!name);
        updateBtnStates();
    };

    const buildGroups = () => {
        const groups = [];
        const profileItems = Object.keys(s.profiles || {})
            .filter(n => s.profiles[n].systemPrompt)
            .map(n => ({
                name: n,
                value: s.profiles[n].systemPrompt,
                preview: (s.profiles[n].systemPrompt || '').replace(/\s+/g, ' ').slice(0, 80),
                badge: 'profile',
                _source: 'profile',
            }));
        if (profileItems.length) groups.push({ label: 'From Profiles', items: profileItems });

        const customItems = Object.keys(s[dictKey])
            .map(n => ({
                name: n,
                value: s[dictKey][n],
                preview: (s[dictKey][n] || '').replace(/\s+/g, ' ').slice(0, 80),
                badge: 'custom',
                _source: 'custom',
            }));
        if (customItems.length) groups.push({ label: 'Custom Presets', items: customItems });
        return groups;
    };

    trigger.addEventListener('click', () => {
        const groups = buildGroups();
        openPresetDropdown(trigger, groups, (value, name, item) => {
            setTextFn(value);
            setActive(name, item._source || 'custom');
        }, { placeholder: 'Search presets…', width: 360, emptyText: 'No presets saved yet' });
    });

    // Action buttons
    const mkBtn = (icon, title, cls, cb) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `scp-preset-mgr-btn${cls ? ' ' + cls : ''}`;
        b.title = title;
        b.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
        b.addEventListener('click', cb);
        return b;
    };

    const saveBtn = mkBtn('floppy-disk', 'Save preset', '', async () => {
        if (_activeName && _activeSource === 'custom') {
            s[dictKey][_activeName] = getTextFn();
            saveSettings();
            toastr.success(`Saved preset "${escHtml(_activeName)}"`, EXT_DISPLAY);
        } else {
            const name = await showCustomDialog({ type: 'prompt', title: 'Save Prompt Preset', message: 'Preset name:', placeholder: 'My Preset' });
            if (!name?.trim()) return;
            s[dictKey][name.trim()] = getTextFn();
            saveSettings();
            setActive(name.trim(), 'custom');
            toastr.success(`Saved preset "${escHtml(name.trim())}"`, EXT_DISPLAY);
        }
    });

    const renameBtn = mkBtn('pen', 'Rename selected custom preset', '', async () => {
        if (!_activeName || _activeSource !== 'custom') { toastr.info('Select a custom preset first.', EXT_DISPLAY); return; }
        const newName = await showCustomDialog({ type: 'prompt', title: 'Rename Preset', message: 'New name:', defaultValue: _activeName });
        if (!newName?.trim() || newName.trim() === _activeName) return;
        s[dictKey][newName.trim()] = s[dictKey][_activeName];
        delete s[dictKey][_activeName];
        saveSettings();
        setActive(newName.trim(), 'custom');
    });

    const deleteBtn = mkBtn('trash', 'Delete selected custom preset', 'danger', async () => {
        if (!_activeName || _activeSource !== 'custom') { toastr.info('Only custom presets can be deleted.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Preset', message: `Delete "${_activeName}"?` });
        if (!ok) return;
        delete s[dictKey][_activeName];
        saveSettings();
        setActive('', '');
    });

    const updateBtnStates = () => {
        const isCustom = !!_activeName && _activeSource === 'custom';
        renameBtn.disabled = !isCustom;
        deleteBtn.disabled = !isCustom;
        renameBtn.style.opacity = isCustom ? '1' : '0.35';
        deleteBtn.style.opacity = isCustom ? '1' : '0.35';
    };
    updateBtnStates();

    bar.appendChild(trigger);
    bar.appendChild(saveBtn);
    bar.appendChild(renameBtn);
    bar.appendChild(deleteBtn);
    containerEl.appendChild(bar);
}

// ─── Quick Prompt Sets Manager ────────────────────────────────────────────────

export function buildQPSetManager(containerEl, onSetLoaded) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    const s = getSettings();
    if (!s.quickPromptSets) s.quickPromptSets = {};

    let _activeName = s.activeQuickPromptSet || '';

    const bar = document.createElement('div');
    bar.className = 'scp-preset-mgr-bar';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'scp-preset-mgr-trigger';
    const getLabel = name => {
        if (!name) return 'Select a set…';
        const count = (s.quickPromptSets[name] || []).length;
        return `${name}  (${count})`;
    };
    trigger.innerHTML = `<span class="scp-pmt-label">${escHtml(getLabel(_activeName))}</span><svg class="scp-pmt-chevron" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    const labelEl = trigger.querySelector('.scp-pmt-label');

    const setActive = name => {
        _activeName = name;
        labelEl.textContent = getLabel(name);
        trigger.classList.toggle('scp-pmt--has-value', !!name);
        updateBtnStates();
    };

    const buildGroups = () => {
        const items = Object.keys(s.quickPromptSets).map(name => ({
            name,
            value: name,
            preview: `${(s.quickPromptSets[name] || []).length} prompts: ` +
                (s.quickPromptSets[name] || []).map(q => `${q.icon || '⚡'} ${q.label}`).join(', ').slice(0, 80),
            badge: name === s.activeQuickPromptSet ? 'active' : null,
        }));
        return [{ label: items.length ? 'Saved Sets' : null, items }];
    };

    trigger.addEventListener('click', () => {
        openPresetDropdown(trigger, buildGroups(), (value) => {
            if (!s.quickPromptSets[value]) return;
            s.quickPrompts = JSON.parse(JSON.stringify(s.quickPromptSets[value]));
            s.activeQuickPromptSet = value;
            saveSettings();
            setActive(value);
            renderQuickPromptsBar();
            if (onSetLoaded) onSetLoaded();
            toastr.success(`Loaded set "${escHtml(value)}"`, EXT_DISPLAY);
        }, { placeholder: 'Search sets…', width: 340, emptyText: 'No sets saved yet. Save one below.' });
    });

    const mkBtn = (icon, title, cls, cb) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `scp-preset-mgr-btn${cls ? ' ' + cls : ''}`;
        b.title = title;
        b.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
        b.addEventListener('click', cb);
        return b;
    };

    const saveBtn = mkBtn('floppy-disk', 'Save current prompts to active set (or new)', '', async () => {
        let name = _activeName;
        if (!name) {
            name = await showCustomDialog({ type: 'prompt', title: 'Save Prompt Set', message: 'Set name:', placeholder: 'My Set' });
            if (!name?.trim()) return;
            name = name.trim();
        }
        s.quickPromptSets[name] = JSON.parse(JSON.stringify(s.quickPrompts));
        s.activeQuickPromptSet = name;
        saveSettings();
        setActive(name);
        toastr.success(`Saved set "${escHtml(name)}"`, EXT_DISPLAY);
    });

    const saveAsBtn = mkBtn('plus', 'Save current prompts as a new set', '', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'New Prompt Set', message: 'Set name:', placeholder: 'My New Set' });
        if (!name?.trim()) return;
        const n = name.trim();
        s.quickPromptSets[n] = JSON.parse(JSON.stringify(s.quickPrompts));
        s.activeQuickPromptSet = n;
        saveSettings();
        setActive(n);
        toastr.success(`Created set "${escHtml(n)}"`, EXT_DISPLAY);
    });

    const renameBtn = mkBtn('pen', 'Rename selected set', '', async () => {
        if (!_activeName) { toastr.info('Select a set first.', EXT_DISPLAY); return; }
        const newName = await showCustomDialog({ type: 'prompt', title: 'Rename Set', message: 'New name:', defaultValue: _activeName });
        if (!newName?.trim() || newName.trim() === _activeName) return;
        const n = newName.trim();
        s.quickPromptSets[n] = s.quickPromptSets[_activeName];
        delete s.quickPromptSets[_activeName];
        if (s.activeQuickPromptSet === _activeName) s.activeQuickPromptSet = n;
        saveSettings();
        setActive(n);
    });

    const deleteBtn = mkBtn('trash', 'Delete selected set', 'danger', async () => {
        if (!_activeName) { toastr.info('Select a set first.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Set', message: `Delete set "${_activeName}"?` });
        if (!ok) return;
        delete s.quickPromptSets[_activeName];
        if (s.activeQuickPromptSet === _activeName) s.activeQuickPromptSet = '';
        saveSettings();
        setActive('');
    });

    const updateBtnStates = () => {
        const has = !!_activeName;
        renameBtn.disabled = !has; renameBtn.style.opacity = has ? '1' : '0.35';
        deleteBtn.disabled = !has; deleteBtn.style.opacity = has ? '1' : '0.35';
    };
    updateBtnStates();

    bar.appendChild(trigger);
    bar.appendChild(saveBtn);
    bar.appendChild(saveAsBtn);
    bar.appendChild(renameBtn);
    bar.appendChild(deleteBtn);
    containerEl.appendChild(bar);
}

export function buildQPSettingsUI(container) {
    if (!container) return;
    container.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'scp-qp-settings-list';

    const renderList = () => {
        list.innerHTML = '';
        const curPrompts = getSettings().quickPrompts || [];
        if (!curPrompts.length) {
            list.innerHTML = `<div style="font-size:11px;color:var(--scp-text-muted);text-align:center;padding:10px 0">No quick prompts yet. Add one below.</div>`;
        }
        curPrompts.forEach((qp, idx) => {
            const row = document.createElement('div');
            row.className = 'scp-qp-settings-row';

            const iconBtn = document.createElement('button');
            iconBtn.className = 'scp-qp-settings-icon-btn';
            iconBtn.textContent = qp.icon || '⚡';
            iconBtn.title = 'Change icon';
            iconBtn.addEventListener('click', e => {
                e.stopPropagation();
                showQPIconPicker(iconBtn, qp.icon || '⚡', emoji => {
                    getSettings().quickPrompts[idx].icon = emoji;
                    saveSettings(); iconBtn.textContent = emoji; renderQuickPromptsBar();
                });
            });

            const labelInput = document.createElement('input');
            labelInput.type = 'text'; labelInput.className = 'scp-qp-settings-label-input scp-sp-input';
            labelInput.placeholder = 'Label'; labelInput.value = qp.label || '';
            labelInput.addEventListener('input', () => {
                getSettings().quickPrompts[idx].label = labelInput.value;
                saveSettings(); renderQuickPromptsBar();
            });

            const moveUpBtn = document.createElement('button');
            moveUpBtn.className = 'scp-qp-settings-move'; moveUpBtn.textContent = '↑';
            moveUpBtn.title = 'Move up'; moveUpBtn.disabled = idx === 0;
            moveUpBtn.addEventListener('click', () => {
                if (idx === 0) return;
                const arr = getSettings().quickPrompts;
                [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
                saveSettings(); renderList(); renderQuickPromptsBar();
            });

            const moveDnBtn = document.createElement('button');
            moveDnBtn.className = 'scp-qp-settings-move'; moveDnBtn.textContent = '↓';
            moveDnBtn.title = 'Move down'; moveDnBtn.disabled = idx === curPrompts.length - 1;
            moveDnBtn.addEventListener('click', () => {
                const arr = getSettings().quickPrompts;
                if (idx >= arr.length - 1) return;
                [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
                saveSettings(); renderList(); renderQuickPromptsBar();
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'scp-qp-settings-del'; delBtn.innerHTML = I.trash; delBtn.title = 'Delete';
            delBtn.addEventListener('click', async () => {
                const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Prompt', message: `Delete "${qp.label || 'this prompt'}"?` });
                if (!ok) return;
                getSettings().quickPrompts.splice(idx, 1);
                saveSettings(); renderList(); renderQuickPromptsBar();
            });

            const textArea = document.createElement('textarea');
            textArea.className = 'scp-qp-settings-text scp-sp-textarea';
            textArea.placeholder = 'Prompt text… (supports {{user}}, {{char}} macros)';
            textArea.rows = 2; textArea.value = qp.text || '';
            textArea.addEventListener('input', () => { getSettings().quickPrompts[idx].text = textArea.value; saveSettings(); });

            const controls = document.createElement('div');
            controls.className = 'scp-qp-settings-controls';
            controls.appendChild(moveUpBtn); controls.appendChild(moveDnBtn); controls.appendChild(delBtn);

            const top = document.createElement('div');
            top.className = 'scp-qp-settings-row-top';
            top.appendChild(iconBtn); top.appendChild(labelInput); top.appendChild(controls);

            row.appendChild(top); row.appendChild(textArea);
            list.appendChild(row);
        });
    };

    renderList();

    const addBtn = document.createElement('button');
    addBtn.className = 'scp-action-btn'; addBtn.style.marginTop = '8px';
    addBtn.innerHTML = `${I.plus}<span>Add Prompt</span>`;
    addBtn.addEventListener('click', async () => {
        const label = await showCustomDialog({ type: 'prompt', title: 'New Quick Prompt', message: 'Label for this prompt:', placeholder: 'My Prompt' });
        if (label === null) return;
        getSettings().quickPrompts.push({ id: genId('qp'), label: label.trim() || 'Prompt', icon: '⚡', text: '' });
        saveSettings(); renderList(); renderQuickPromptsBar();
    });

    container.appendChild(list); container.appendChild(addBtn);
}

// ─── Chat Message Picker ──────────────────────────────────────────────────────

let _pickerLastIdx = -1;

function getPickedChatIndices() {
    try { return getCurrentSession().pickedChatIndices || []; } catch(_) { return []; }
}

function setPickedChatIndices(indices) {
    try {
        const sess = getCurrentSession();
        sess.pickedChatIndices = [...indices].sort((a, b) => {
            const aParsed = parseChatPickKey(a);
            const bParsed = parseChatPickKey(b);
            return (aParsed?.chatIndex ?? 0) - (bParsed?.chatIndex ?? 0)
                || String(a).localeCompare(String(b), undefined, { numeric: true });
        });
        saveSessionsToMetadata();
        updatePickBtnState();
        updateMsgCount(sess);
    } catch(_) {}
}

export function updatePickBtnState() {
    const picked = getPickedChatIndices();
    const btn = document.getElementById('scp-pick-btn');
    const badge = document.getElementById('scp-pick-badge');
    const isActive = picked.length > 0;
    btn?.classList.toggle('active', isActive);
    if (badge) { badge.style.display = isActive ? '' : 'none'; badge.textContent = picked.length; }
    const depthSlider = document.getElementById('scp-depth-slider');
    const depthVal = document.getElementById('scp-depth-val');
    depthSlider?.classList.toggle('scp-slider-overridden', isActive);
    depthVal?.classList.toggle('scp-depth-val-overridden', isActive);
}

export function openChatPicker() {
    const overlay = document.getElementById('scp-picker-overlay');
    if (!overlay) return;
    applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    _pickerLastIdx = -1;
    renderPickerMessages();
    overlay.style.display = 'flex';
}

function closeChatPicker() {
    const overlay = document.getElementById('scp-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

function renderPickerMessages() {
    const body = document.getElementById('scp-picker-body');
    if (!body) return;
    const ctx = SillyTavern.getContext();
    const msgs = ctx.chat || [];
    const pickedSet = new Set(getPickedChatIndices());
    const charInfo = getCharInfo();
    const includeOriginals = !!getEffectiveSettings().includeInlineSummaryOriginals;
    const pickerMessages = msgs.flatMap((msg, idx) => {
        if (!includeOriginals) return [{ ...msg, chatIndex: idx, pickKey: idx, sourcePath: null }];
        const expanded = getMainChatMessageEntries(msg, idx, true);
        if (!expanded.length) return [{ ...msg, chatIndex: idx, pickKey: idx, sourcePath: null }];
        return expanded.map(message => ({
            ...msg,
            is_user: message.role === 'user',
            name: message.name,
            mes: message.content,
            chatIndex: idx,
            pickKey: makeChatPickKey(idx, message.inlineSummarySourcePath),
            sourcePath: message.inlineSummarySourcePath,
        }));
    });

    body.innerHTML = '';
    if (!msgs.length) {
        body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--scp-text-muted)">No messages in current chat</div>';
        _updatePickerCountEl(0);
        return;
    }

    const frag = document.createDocumentFragment();
    pickerMessages.forEach((msg, idx) => {
        const isUser = msg.is_user;
        const name = isUser ? (ctx.name1 || 'User') : (msg.name || charInfo?.name || 'Character');
        const isSelected = pickedSet.has(msg.pickKey)
            || (msg.sourcePath && pickedSet.has(msg.chatIndex));
        const row = document.createElement('div');
        row.className = `scp-picker-row${isSelected ? ' selected' : ''}${isUser ? ' user' : ''}`;
        row.dataset.idx = idx;
        row.dataset.pickKey = String(msg.pickKey);

        const cb = document.createElement('div');
        cb.className = `scp-picker-cb${isSelected ? ' checked' : ''}`;

        const meta = document.createElement('div');
        meta.className = 'scp-picker-meta';

        const idxEl = document.createElement('span');
        idxEl.className = 'scp-picker-idx';
        idxEl.textContent = msg.sourcePath
            ? `#${msg.chatIndex} original ${msg.sourcePath.join('.')}`
            : `#${msg.chatIndex}`;

        const nameEl = document.createElement('span');
        nameEl.className = 'scp-picker-name';
        nameEl.textContent = name;

        meta.appendChild(idxEl);
        meta.appendChild(nameEl);

        const textEl = document.createElement('div');
        textEl.className = 'scp-picker-text';
        const raw = (msg.mes || '').replace(/<[^>]+>/g, '').trim();
        const s2 = getSettings();
        const firstLines = Math.max(1, parseInt(s2.pickerPreviewLines) || 1);
        const lastLines = Math.max(0, parseInt(s2.pickerPreviewLastLines) || 0);
        let preview = '';
        if (lastLines > 0) {
            const allLines = raw.split('\n');
            const head = allLines.slice(0, firstLines).join('\n');
            const tail = allLines.length > firstLines
                ? allLines.slice(-lastLines).join('\n')
                : '';
            preview = tail && tail !== head ? head + '\n…\n' + tail : head;
        } else {
            preview = raw.split('\n').slice(0, firstLines).join('\n');
            if (preview.length < raw.length) preview += ' …';
        }
        textEl.textContent = preview;

        const infoCol = document.createElement('div');
        infoCol.className = 'scp-picker-info-col';
        infoCol.appendChild(meta);
        infoCol.appendChild(textEl);

        row.appendChild(cb);
        row.appendChild(infoCol);

        row.addEventListener('click', e => {
            const curIdx = parseInt(row.dataset.idx);
            const curMsg = pickerMessages[curIdx];

            if (e.ctrlKey || e.metaKey) {
                // Ctrl+click: toggle all messages by same sender
                const targetState = !row.classList.contains('selected');
                body.querySelectorAll('.scp-picker-row').forEach(r => {
                    const ri = parseInt(r.dataset.idx);
                    const rm = pickerMessages[ri];
                    if (rm && rm.is_user === curMsg.is_user && rm.name === curMsg.name) {
                        r.classList.toggle('selected', targetState);
                        r.querySelector('.scp-picker-cb')?.classList.toggle('checked', targetState);
                    }
                });
            } else if (e.altKey) {
                // Alt+click: toggle all messages NOT from this sender
                const targetState = !row.classList.contains('selected');
                body.querySelectorAll('.scp-picker-row').forEach(r => {
                    const ri = parseInt(r.dataset.idx);
                    const rm = pickerMessages[ri];
                    if (rm && !(rm.is_user === curMsg.is_user && rm.name === curMsg.name)) {
                        r.classList.toggle('selected', targetState);
                        r.querySelector('.scp-picker-cb')?.classList.toggle('checked', targetState);
                    }
                });
            } else if (e.shiftKey && _pickerLastIdx >= 0) {
                const lo = Math.min(_pickerLastIdx, curIdx);
                const hi = Math.max(_pickerLastIdx, curIdx);
                const targetState = !row.classList.contains('selected');
                body.querySelectorAll('.scp-picker-row').forEach(r => {
                    const ri = parseInt(r.dataset.idx);
                    if (ri >= lo && ri <= hi) {
                        r.classList.toggle('selected', targetState);
                        r.querySelector('.scp-picker-cb')?.classList.toggle('checked', targetState);
                    }
                });
            } else {
                const sel = row.classList.toggle('selected');
                cb.classList.toggle('checked', sel);
                _pickerLastIdx = curIdx;
            }
            _updatePickerCountEl();
        });

        frag.appendChild(row);
    });
    body.appendChild(frag);
    _updatePickerCountEl(pickedSet.size);
    const firstSel = body.querySelector('.scp-picker-row.selected');
    if (firstSel) setTimeout(() => firstSel.scrollIntoView({ block: 'center' }), 50);
}

function _updatePickerCountEl(count) {
    const el = document.getElementById('scp-picker-count');
    if (!el) return;
    const n = count !== undefined ? count : document.querySelectorAll('#scp-picker-body .scp-picker-row.selected').length;
    el.textContent = `${n} selected`;
}

export function setupChatPickerListeners() {
    const overlay = document.getElementById('scp-picker-overlay');
    if (!overlay) return;

    let _mouseDownTarget = null;
    overlay.addEventListener('mousedown', e => { _mouseDownTarget = e.target; });
    overlay.addEventListener('click', e => { if (e.target === overlay && _mouseDownTarget === overlay) closeChatPicker(); });

    document.getElementById('scp-picker-close')?.addEventListener('click', closeChatPicker);

    document.getElementById('scp-picker-all')?.addEventListener('click', () => {
        document.querySelectorAll('#scp-picker-body .scp-picker-row').forEach(r => {
            r.classList.add('selected');
            r.querySelector('.scp-picker-cb')?.classList.add('checked');
        });
        _updatePickerCountEl();
    });

    document.getElementById('scp-picker-invert')?.addEventListener('click', () => {
        document.querySelectorAll('#scp-picker-body .scp-picker-row').forEach(r => {
            const s = r.classList.toggle('selected');
            r.querySelector('.scp-picker-cb')?.classList.toggle('checked', s);
        });
        _updatePickerCountEl();
    });

    document.getElementById('scp-picker-clear')?.addEventListener('click', () => {
        document.querySelectorAll('#scp-picker-body .scp-picker-row').forEach(r => {
            r.classList.remove('selected');
            r.querySelector('.scp-picker-cb')?.classList.remove('checked');
        });
        _updatePickerCountEl();
    });

    document.getElementById('scp-picker-apply')?.addEventListener('click', () => {
        const rows = document.querySelectorAll('#scp-picker-body .scp-picker-row');
        const indices = [];
        rows.forEach(r => {
            if (!r.classList.contains('selected')) return;
            const pickKey = r.dataset.pickKey;
            indices.push(pickKey?.startsWith('ils:') ? pickKey : parseInt(pickKey));
        });
        setPickedChatIndices(indices);
        closeChatPicker();
    });
}

// ─── DOM References ─────────────────────────────────────────────────────────
// ─── Session Dropdown ────────────────────────────────────────────────────────

export function closeSessPanel() {
    $('scp-sess-panel')?.classList.remove('open');
    $('scp-sess-trigger')?.classList.remove('open');
}

export async function refreshSessionDropdown() {
    const bucket = getChatBucket();
    const nameEl = $('scp-sess-name'); const listEl = $('scp-sess-list');
    if (!nameEl || !listEl) return;
    const activeSess = bucket.sessions.find(s => s.id === bucket.activeSessionId);
    nameEl.textContent = activeSess?.name || 'No Sessions';
    listEl.innerHTML = '';
    
    if (!bucket.sessions.length) {
        listEl.innerHTML = `<div class="scp-sess-empty-label">No sessions — create one below</div>`;
    } else {
        for (const sess of bucket.sessions) {
            const item = document.createElement('div');
            item.className = `scp-sess-item${sess.id === bucket.activeSessionId ? ' active' : ''}`;
            item.dataset.id = sess.id;

            const dot = document.createElement('span');
            dot.className = 'scp-sess-item-dot';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'scp-sess-item-name';
            nameSpan.textContent = sess.name;

            const count = document.createElement('span');
            count.className = 'scp-sess-item-count';
            count.textContent = sess.messages.length;

            item.appendChild(dot);
            item.appendChild(nameSpan);
            item.appendChild(count);

            if (sess.isTemporary) {
                const badge = document.createElement('span');
                badge.className = 'scp-sess-tmp-badge';
                badge.title = 'Temporary session — will be deleted on switch';
                badge.textContent = 'tmp';
                item.appendChild(badge);
            }

            if (sess.id === bucket.activeSessionId) {
                const tmpBtn = document.createElement('button');
                tmpBtn.className = `scp-sess-tmp-btn${sess.isTemporary ? ' active' : ''}`;
                tmpBtn.title = sess.isTemporary ? 'Make permanent' : 'Make temporary';
                tmpBtn.innerHTML = '⏱';
                tmpBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    sess.isTemporary = !sess.isTemporary;
                    saveSessionsToMetadata();
                    refreshSessionDropdown();
                });
                item.appendChild(tmpBtn);
            }

            item.addEventListener('click', async () => {
                const activeSess = bucket.sessions.find(s => s.id === bucket.activeSessionId);
                if (activeSess && activeSess.isTemporary && activeSess.id !== sess.id) {
                    const ok = await showCustomDialog({
                        type: 'confirm',
                        title: 'Delete Temporary Session?',
                        message: 'Your current session is temporary. Switching will permanently delete it. Continue?'
                    });
                    if (!ok) return;
                }
                setActiveSession(sess.id);
                refreshSessionDropdown(); renderSession(getCurrentSession()); closeSessPanel();
            });
            listEl.appendChild(item);
        }
    }

    const s = getSettings();
    const orphanedSessions = [];
    const ctx2 = SillyTavern.getContext();
    const { charId, chatId } = getBindingKey();
    
    const currentCharName = ctx2.characters?.[ctx2.characterId]?.name;
    if (charId !== 'global' && currentCharName && s.sessions[charId]) {
        for (const chId in s.sessions[charId]) {
            const b = s.sessions[charId][chId];
            if (b && b.sessions && b.sessions.length > 0) {
                const validSessions = b.sessions.filter(sess => sess.messages && sess.messages.length > 0);
                if (validSessions.length > 0) {
                    orphanedSessions.push({ chId, sessions: validSessions, source: 'legacy' });
                }
            }
        }
    }

    try {
        const res = await fetch('/api/images/list', {
            method: 'POST',
            headers: { ...ctx2.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ directory: '' })
        }).catch(() => null);

        if (res && res.ok) {
            const data = await res.json();
            const files = Array.isArray(data) ? data : (data.files || []);
            const currentFileId = ctx2.chatMetadata?.st_copilot?.file_id;

            for (const f of files) {
                const fname = typeof f === 'string' ? f : f.name;
                if (fname && fname.startsWith('copilot_sess_') && fname.endsWith('.json') && fname !== currentFileId) {
                    const payload = await loadSessionFile(fname);
                    if (payload && payload.chat_id_reference === chatId && payload.bucket?.sessions?.length) {
                        orphanedSessions.push({ file_id: fname, sessions: payload.bucket.sessions, source: 'file' });
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[ST-Copilot] Orphan file scan failed', e);
    }

    if (orphanedSessions.length > 0) {
        const totalOrphaned = orphanedSessions.reduce((acc, curr) => acc + curr.sessions.length, 0);
        const recoverBtn = document.createElement('button');
        recoverBtn.className = 'scp-action-btn scp-recover-btn';
        recoverBtn.style.marginTop = '12px';
        recoverBtn.style.width = '100%';
        recoverBtn.style.justifyContent = 'center';
        recoverBtn.style.backgroundColor = 'rgba(255, 180, 50, 0.1)';
        recoverBtn.style.color = '#ffb432';
        recoverBtn.style.border = '1px solid rgba(255, 180, 50, 0.3)';
        recoverBtn.innerHTML = `<i class="fa-solid fa-life-ring"></i><span>Recover ${totalOrphaned} lost session(s)</span>`;
        recoverBtn.title = "Click to migrate hidden/lost sessions into this chat's metadata.";
        
        recoverBtn.addEventListener('click', async () => {
            const ok = await showCustomDialog({
                type: 'confirm',
                title: 'Recover Sessions',
                message: `Found ${totalOrphaned} session(s) belonging to this chat from storage. Move them permanently into THIS chat?`
            });
            if (!ok) return;
            
            for (const orphan of orphanedSessions) {
                bucket.sessions.push(...orphan.sessions.map(sess => ({
                    ...sess, name: sess.name.endsWith('(Recovered)') ? sess.name : sess.name + ' (Recovered)'
                })));
                
                if (orphan.source === 'legacy') {
                    delete s.sessions[charId][orphan.chId]; 
                } else if (orphan.source === 'file') {
                    await saveSessionFile(orphan.file_id, {
                        _version: 2, chat_id_reference: chatId, updated_at: Date.now(),
                        bucket: { activeSessionId: null, sessions: [] }
                    });
                }
            }
            
            if (orphanedSessions.some(o => o.source === 'legacy')) saveSettings();
            await commitBucketChanges(true);
            refreshSessionDropdown();
            toastr.success('Sessions successfully recovered and moved to chat metadata!', EXT_DISPLAY);
        });
        listEl.appendChild(recoverBtn);
    }
}

// ─── Depth Slider Click-to-Type ──────────────────────────────────────────────

export function setupDepthClickEdit() {
    const valEl = $('scp-depth-val'); if (!valEl) return;
    valEl.addEventListener('click', () => {
        const cur = getSettings().contextDepth;
        const input = document.createElement('input');
        input.type = 'number'; input.className = 'scp-depth-input';
        input.value = cur; input.min = 0;
        const el = $('scp-depth-val');
        if (!el) return;
        el.replaceWith(input); input.focus(); input.select();
        const commit = () => {
            const val = Math.max(0, parseInt(input.value) || 0);
            getSettings().contextDepth = val; saveSettings();
            
            updateDepthSlidersMax();
            syncOverlayUI('contextDepth', val);
            
            const span = document.createElement('span');
            span.className = 'scp-depth-val scp-depth-clickable'; span.id = 'scp-depth-val';
            span.title = 'Click to enter exact value'; span.textContent = val;
            input.replaceWith(span);
            setupDepthClickEdit();
            const slider = $('scp-depth-slider');
            if (slider) { slider.value = val; }
            updateMsgCount(getCurrentSession());
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') commit(); });
    });
}

// ─── Session Import / Export ──────────────────────────────────────────────────
// Moved from original index.js (10340-10399). Lives here rather than in
// session.js because it needs closeSessPanel/refreshSessionDropdown/
// renderSession from this file and ui-chat.js — putting it in session.js
// would create a session.js -> ui-widgets.js import cycle, since
// ui-widgets.js already imports several CRUD helpers from session.js.

export function exportCurrentSession() {
    try {
        const sess = getCurrentSession();
        const ctx = SillyTavern.getContext();
        const charName = ctx.characters?.[ctx.characterId]?.name || 'unknown';
        const exportData = {
            version: 1,
            exported: new Date().toISOString(),
            charName,
            session: JSON.parse(JSON.stringify(sess)),
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeName = sess.name.replace(/[^a-z0-9]/gi, '_').slice(0, 40) || 'session';
        a.download = `st-copilot-session-${safeName}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Session exported.', EXT_DISPLAY);
    } catch (e) {
        toastr.error(`Export failed: ${e.message}`, EXT_DISPLAY);
    }
}

export function importSession() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
        const file = inp.files?.[0]; if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.session || !data.session.id || !Array.isArray(data.session.messages)) {
                toastr.error('Invalid session file.', EXT_DISPLAY); return;
            }
            const ok = await showCustomDialog({
                type: 'confirm',
                title: 'Import Session',
                message: `Import session "${data.session.name || 'unnamed'}"${data.charName ? ` (from ${data.charName})` : ''}? It will be added to the current chat metadata.`,
            });
            if (!ok) return;
            const bucket = getChatBucket();
            const imported = { ...data.session, id: genId('sess'), name: `${data.session.name || 'Imported'} (imported)` };
            imported.isTemporary = false;
            bucket.sessions.push(imported);
            bucket.activeSessionId = imported.id;
            saveSessionsToMetadata();
            closeSessPanel();
            refreshSessionDropdown();
            renderSession(getCurrentSession());
            toastr.success(`Session "${escHtml(imported.name)}" imported.`, EXT_DISPLAY);
        } catch (e) {
            toastr.error(`Import failed: ${e.message}`, EXT_DISPLAY);
        }
    };
    inp.click();
}

