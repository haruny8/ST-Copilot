/**
 * index.js
 * Bootstrap entry point. This is what SillyTavern actually loads as the
 * extension's ES module. Its job is narrow and specific:
 *   1. Resolve the extension's own install path (must happen synchronously
 *      at module-evaluation time, via document.currentScript — see
 *      state.js's resolveExtPath).
 *   2. Wire the four cross-module `setForwardDeps()` calls that earlier
 *      passes left as no-op stubs, now that every module they point at
 *      actually exists.
 *   3. Own the handful of "glue" functions that fan out into nearly every
 *      other module and therefore can't live anywhere else without
 *      creating an import cycle: `attachWindowListeners`, `onChatChanged`,
 *      `addWandButton`, the Changelog modal, `injectUI`, and `init` itself.
 *   4. Kick everything off on DOMContentLoaded (or immediately if the
 *      document has already finished loading).
 *
 * Moved from original index.js: "Window Event Listeners" (13870-14149),
 * "Chat Change" (14150-14174), "Wand Button" (14175-14188), "Changelog"
 * (14189-14256), "DOM References" (8241-8277, `injectUI`/`windowEl`/
 * `iconEl`/`modalEl` only — `$` itself lives in utils/util-dom.js), and
 * "Init" (14602-14867), plus the extension-path-resolution IIFE that used
 * to sit at the very top of the file (old lines 153-164, now
 * `resolveExtPath()` in state.js, called once below at module top level).
 *
 * Every other file in this split is written so it can be imported and used
 * standalone with no knowledge of index.js; this file is the one place
 * that's allowed to know about everything.
 */

import {
    EXT_DISPLAY, WIN_ID, ICON_ID, MODAL_ID, ICON_STORAGE_KEY, CHANGELOG, ICONS,
} from './constants.js';
import {
    setSTWorldInfo, setSTUtils, setExtVersion, getExtPath, resolveExtPath,
    getWindowEl, setWindowEl, getIconEl, setIconEl, setModalEl, getModalEl,
    isCopilotActive, setCopilotActive,
} from './state.js';
import { getSettings, saveSettings } from './settings.js';
import {
    $, escHtml, autoResize, copyText, showCustomDialog, showSessionDialog,
} from './utils/util-dom.js';
import { dbgAdd, dbgSnapshotSettings, dbgSetupGlobalErrorHandlers } from './utils/util-debug.js';
import {
    getChatBucket, createSession, deleteCurrentSession, getCurrentSession,
    saveSessionsToMetadata, updateDepthSlidersMax, initChatBucket,
    updateSessionOverrideIndicator, resetLastChatLen,
} from './session.js';
import { getAbortController, formatPayloadAsText, getLastInspectorMessages } from './api.js';
import { clearWiCache } from './features/feature-lorebook-engine.js';
import { openFavoritesPanel, closeFavoritesPanel } from './features/feature-favorites.js';
import { refreshAltGreetingsPickers } from './features/feature-character-engine.js';
import {
    openLorebookManager, setupLorebookManagerListeners, setForwardDeps as setLorebookUiForwardDeps,
} from './features/feature-lorebook-ui.js';
import {
    setupMessagesScrollTracking, handleSend, handleRegen,
    isGenerating, setGeneratingState, setupSearchListeners,
    renderSession, updateMsgCount, setForwardDeps as setUiChatForwardDeps,
} from './ui/ui-chat.js';
import {
    refreshSessionDropdown, closeSessPanel, exportCurrentSession, importSession,
    setupDepthClickEdit, setupChatPickerListeners, openChatPicker,
    renderQuickPromptsBar, updatePickBtnState,
    buildQPSettingsUI, buildQPSetManager, buildPromptPresetManager,
} from './ui/ui-widgets.js';
import {
    makeDraggable, makeResizable, makeIconDraggable, minimize, hideWindow,
    toggleGhostMode, setupGhostHotkey, setupHotkey, setupSearchHotkey,
    restoreWindowState, updateIconVisibility, _takeProfileSnapshot,
    updateProfilesList, _setupAttachButton, updateCharBadge, autoLoadBoundProfile,
    toggleVisibility, playCompletionSound, applyCustomTheme, openInspector,
    setForwardDeps as setUiWindowForwardDeps,
} from './ui/ui-window.js';
import {
    setupSettingsHandlers, updateSettingsUI, setupSettingsPanelListeners,
    openExtensionSettings, syncOverlayUI, syncBgToOverlay,
    setForwardDeps as setUiSettingsForwardDeps,
} from './ui/ui-settings.js';

// Local shorthand alias for the ICONS constant, used by injectUI's
// `${I.iconName}` template substitution (matches the pattern used in
// ui-widgets.js for the same constant).
const I = ICONS;

// ── Wire the forward-dependency stubs left by earlier passes ──────────────
// Each module below was built before the modules it needed existed yet, so
// each got a `setForwardDeps()` escape hatch. Now that every module exists,
// resolve them all here, once, before init() runs.
setUiWindowForwardDeps({ updateSettingsUI, syncBgToOverlay });
setLorebookUiForwardDeps({ applyCustomTheme });
setUiChatForwardDeps({ playCompletionSound });
setUiSettingsForwardDeps({
    buildQPSettingsUI, buildQPSetManager, buildPromptPresetManager,
    onChatChanged, openChangelog,
});

// Resolve the extension's own install path. Must run synchronously at
// module-evaluation time (relies on document.currentScript), not inside an
// async function — this is why it's a bare top-level call and not part of
// init(). (Moved verbatim from the top of the old index.js closure.)
resolveExtPath();

// ─── DOM References / injectUI ────────────────────────────────────────────

async function injectUI() {
    const ctx = SillyTavern.getContext();

    const parseTemplate = (html) => {
        if (!html) return '';
        return html.replace(/\$\{I\.([a-zA-Z0-9_]+)\}/g, (_, iconName) => I[iconName] || '');
    };

    const loadAndInject = async (templateName) => {
        const html = await ctx.renderExtensionTemplateAsync(getExtPath(), templateName);
        if (html) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = parseTemplate(html);
            while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);
        } else {
            console.error(`[${EXT_DISPLAY}] Couldn't load HTML: ${templateName}.html`);
        }
    };

    const templates = ['window', 'lorebook_manager', 'settings_overlay', 'chat_picker'];
    await Promise.all(templates.map(loadAndInject));

    setWindowEl(document.getElementById(WIN_ID));
    setIconEl(document.getElementById(ICON_ID));
    setModalEl(document.getElementById(MODAL_ID));

    const iconEl = getIconEl();
    if (iconEl && iconEl.parentElement !== document.body) {
        document.body.appendChild(iconEl);
    }
}

// ─── Window Event Listeners ────────────────────────────────────────────────

function attachWindowListeners() {
    const windowEl = getWindowEl();
    const iconEl = getIconEl();
    const modalEl = getModalEl();

    makeDraggable($('scp-drag-handle'), windowEl);
    makeResizable(windowEl);
    setupMessagesScrollTracking();

    document.addEventListener('pointerdown', e => {
        const win = document.getElementById(WIN_ID);
        if (!win || win.style.display === 'none') {
            setCopilotActive(false);
            return;
        }
        const clickedInside = win.contains(e.target) ||
                              e.target.closest('.scp-dialog-overlay') ||
                              document.getElementById('scp-settings-overlay')?.contains(e.target) ||
                              document.getElementById('scp-lb-overlay')?.contains(e.target) ||
                              document.getElementById('scp-picker-overlay')?.contains(e.target) ||
                              document.getElementById('scp-diff-modal')?.contains(e.target);
        setCopilotActive(!!clickedInside);
    }, true);

    window.addEventListener('resize', () => {
        const windowEl = getWindowEl();
        const iconEl = getIconEl();
        if (windowEl && windowEl.style.display !== 'none') {
            const r = windowEl.getBoundingClientRect();
            const s = getSettings();
            if (s.windowX !== null && s.windowY !== null) {
                const maxLeft = Math.max(0, window.innerWidth - r.width);
                const maxTop = Math.max(0, window.innerHeight - r.height);
                windowEl.style.left = `${Math.max(0, Math.min(s.windowX, maxLeft))}px`;
                windowEl.style.top = `${Math.max(0, Math.min(s.windowY, maxTop))}px`;
            }
        }
        if (iconEl && iconEl.style.display !== 'none') {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const iconSize = 46;
            const savedIconPos = localStorage.getItem(ICON_STORAGE_KEY);
            if (savedIconPos) {
                try {
                    const pos = JSON.parse(savedIconPos);
                    const left = parseFloat(pos.left);
                    const top = parseFloat(pos.top);
                    if (!isNaN(left) && !isNaN(top)) {
                        let newLeft = Math.max(0, Math.min(left, vw - iconSize));
                        let newTop = Math.max(0, Math.min(top, vh - iconSize));
                        iconEl.style.left = `${newLeft}px`;
                        iconEl.style.top = `${newTop}px`;
                    }
                } catch(e) {}
            }
        }
    });

    $('scp-min-btn')?.addEventListener('click', minimize);
    $('scp-close-btn')?.addEventListener('click', hideWindow);
    $('scp-ext-settings-btn')?.addEventListener('click', openExtensionSettings);
    if (iconEl) makeIconDraggable(iconEl);

    // Ghost mode
    $('scp-ghost-btn')?.addEventListener('click', toggleGhostMode);

    // Session dropdown
    $('scp-sess-trigger')?.addEventListener('click', e => {
        e.stopPropagation();
        if (isGenerating()) {
            toastr.warning('Please wait for generation to finish.', EXT_DISPLAY);
            return;
        }
        const panel = $('scp-sess-panel'); const trigger = $('scp-sess-trigger');
        const isOpen = panel.classList.contains('open');
        panel.classList.toggle('open', !isOpen); trigger.classList.toggle('open', !isOpen);
        if (!isOpen) refreshSessionDropdown();
    });
    document.addEventListener('click', e => {
        const dd = $('scp-sess-dropdown');
        if (dd && !dd.contains(e.target)) closeSessPanel();
        if (!e.target.closest('.scp-lb-proposal-world-dd')) {
            document.querySelectorAll('.scp-lb-proposal-world-panel.open').forEach(p => {
                p.classList.remove('open');
                p.previousElementSibling?.classList.remove('open');
            });
        }
    });
    $('scp-new-sess-btn')?.addEventListener('click', async () => {
        closeSessPanel();
        const bucket = getChatBucket();

        const activeSess = bucket.sessions.find(s => s.id === bucket.activeSessionId);
        if (activeSess && activeSess.isTemporary) {
            const ok = await showCustomDialog({
                type: 'confirm',
                title: 'Delete Temporary Session?',
                message: 'Your current session is temporary. Creating a new one will permanently delete it. Continue?'
            });
            if (!ok) return;
        }

        const defaultName = `Session ${bucket.sessions.length + 1}`;
        const result = await showSessionDialog({ defaultName });
        if (result === null) return;
        createSession(result.name.trim() || defaultName, result.isTemporary);
        refreshSessionDropdown(); renderSession(getCurrentSession());
    });

    $('scp-rename-sess-btn')?.addEventListener('click', async () => {
        const sess = getCurrentSession();
        const oldName = sess.name;
        const newName = await showCustomDialog({ type: 'prompt', title: 'Rename Session', message: 'New session name:', defaultValue: sess.name });
        if (!newName?.trim() || newName.trim() === oldName) return;
        sess.name = newName.trim(); saveSessionsToMetadata(); refreshSessionDropdown();
        dbgAdd('SESSION_RENAMED', { id: sess.id, oldName, newName: sess.name });
    });

    $('scp-del-sess-btn')?.addEventListener('click', async () => {
        const bucket = getChatBucket();
        if (!bucket.sessions.length) return;
        const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Session', message: 'Delete this session and all its messages? This cannot be undone.' });
        if (!ok) return;
        const newSess = deleteCurrentSession();
        refreshSessionDropdown(); renderSession(newSess);
    });

    $('scp-export-sess-btn')?.addEventListener('click', () => { closeSessPanel(); exportCurrentSession(); });
    $('scp-import-sess-btn')?.addEventListener('click', () => { closeSessPanel(); importSession(); });

    // Depth slider
    const depthSlider = $('scp-depth-slider');
    if (depthSlider) {
        depthSlider.value = getSettings().contextDepth;
        $('scp-depth-val').textContent = depthSlider.value;

        depthSlider.addEventListener('input', () => {
            $('scp-depth-val').textContent = depthSlider.value;
        });

        depthSlider.addEventListener('change', () => {
            const val = parseInt(depthSlider.value);
            getSettings().contextDepth = val;
            saveSettings();
            syncOverlayUI('contextDepth', val);
            updateMsgCount(getCurrentSession());
        });
    }
    setupDepthClickEdit();
    _setupAttachButton();

    // Actions
    $('scp-inspect-btn')?.addEventListener('click', openInspector);
    $('scp-regen-btn')?.addEventListener('click', handleRegen);
    const lbBtn = $('scp-lb-btn');
    if (lbBtn) {
        let _lbTouchPending = false;
        lbBtn.addEventListener('touchend', e => {
            e.preventDefault();
            _lbTouchPending = true;
            openLorebookManager();
            setTimeout(() => { _lbTouchPending = false; }, 400);
        }, { passive: false });
        lbBtn.addEventListener('click', () => { if (!_lbTouchPending) openLorebookManager(); });
    }

    // Search (DOM wiring for open/close/prev/next/word-toggle/input all
    // lives in ui-chat.js's setupSearchListeners, since it needs to touch
    // that module's private search state directly)
    setupSearchListeners();

    // Chat Message Picker
    $('scp-pick-btn')?.addEventListener('click', openChatPicker);

    // Favorites
    $('scp-fav-btn')?.addEventListener('click', () => {
        const panel = document.getElementById('scp-fav-panel');
        if (panel?.style.display === 'none' || !panel?.style.display) openFavoritesPanel();
        else closeFavoritesPanel();
    });
    $('scp-fav-close')?.addEventListener('click', closeFavoritesPanel);

    // Quick Prompts toggle
    $('scp-qp-toggle-btn')?.addEventListener('click', () => {
        const s = getSettings();
        s.quickPromptsVisible = !s.quickPromptsVisible;
        saveSettings(); renderQuickPromptsBar();
    });

    // Desktop horizontal scroll for QP bar
    const qpBar = $('scp-qp-bar');
    if (qpBar) {
        qpBar.addEventListener('wheel', e => {
            if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
            e.preventDefault();
            const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 200 : e.deltaY;
            qpBar.scrollLeft += delta;
        }, { passive: false });
    }

    $('scp-stop-btn')?.addEventListener('click', () => {
        getAbortController()?.abort();
        const { stopGeneration } = SillyTavern.getContext();
        if (typeof stopGeneration === 'function') stopGeneration();
    });

    // Input
    const inputEl = $('scp-input');
    if (inputEl) {
        inputEl.addEventListener('input', () => {
            autoResize(inputEl);
            updateMsgCount(getCurrentSession());
        });
        inputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                const isMobile = window.innerWidth <= 900 || ('ontouchstart' in window);
                if (!isMobile) {
                    e.preventDefault();
                    handleSend();
                }
            }
        });
    }
    $('scp-send-btn')?.addEventListener('click', handleSend);

    // Modal
    $('scp-modal-close')?.addEventListener('click', () => { modalEl.style.display = 'none'; });
    let _modalMouseDown = null;
    modalEl?.addEventListener('mousedown', e => { _modalMouseDown = e.target; });
    modalEl?.addEventListener('click', e => { if (e.target === modalEl && _modalMouseDown === modalEl) modalEl.style.display = 'none'; });
    document.querySelectorAll('.scp-modal-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.scp-modal-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const isFormatted = tab.dataset.tab === 'formatted';
            const isJson = tab.dataset.tab === 'json';

            const fmtEl = $('scp-ctx-formatted');
            const jsonEl = $('scp-ctx-json');

            if (fmtEl) fmtEl.style.display = isFormatted ? '' : 'none';
            if (jsonEl) jsonEl.style.display = isJson ? '' : 'none';

            setTimeout(() => {
                const targetEl = isJson ? jsonEl : document.getElementById('scp-ctx-body');
                if (targetEl) {
                    const prevBehavior = targetEl.style.scrollBehavior;
                    targetEl.style.scrollBehavior = 'auto';
                    targetEl.scrollTop = targetEl.scrollHeight;
                    targetEl.style.scrollBehavior = prevBehavior;
                }
            }, 0);
        });
    });
    $('scp-ctx-copy-btn')?.addEventListener('click', () => {
        const activeTab = document.querySelector('.scp-modal-tab.active');
        const text = activeTab?.dataset.tab === 'json'
            ? $('scp-ctx-json')?.textContent || ''
            : formatPayloadAsText(getLastInspectorMessages() || []);
        copyText(text);
    });
}

// ─── Chat Change ───────────────────────────────────────────────────────────

async function onChatChanged() {
    if (isGenerating()) {
        getAbortController()?.abort();
        setGeneratingState(false);
    }
    resetLastChatLen();
    clearWiCache();
    closeFavoritesPanel();
    updateCharBadge();

    await initChatBucket();

    refreshSessionDropdown();
    renderSession(getCurrentSession());
    autoLoadBoundProfile();
    updateSessionOverrideIndicator();
    updateDepthSlidersMax();
    renderQuickPromptsBar();
    updatePickBtnState();
    refreshAltGreetingsPickers();
}

// ─── Wand Button ───────────────────────────────────────────────────────────

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('scp-wand-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'scp-wand-btn';
    btn.classList.add('list-group-item', 'flex-container', 'flexGap5');
    btn.innerHTML = `<div class="fa-solid fa-robot extensionsMenuExtensionButton"></div><span>${EXT_DISPLAY}</span>`;
    btn.style.display = getSettings().enabled ? '' : 'none';
    btn.addEventListener('click', toggleVisibility);
    menu.appendChild(btn);
}

// ─── Changelog ─────────────────────────────────────────────────────────────

function buildChangelogHTML() {
    const current = CHANGELOG[0];
    const past = CHANGELOG.slice(1);

    const notesHTML = current.notes
        .map(n => `<li>${n}</li>`)
        .join('');

    let historyHTML = '';
    if (past.length) {
        historyHTML = `<div class="scp-cl-history">` +
            past.map(entry => {
                const li = (entry.notes || []).map(n => `<li>${n}</li>`).join('');
                return `<details class="scp-cl-entry">
                    <summary class="scp-cl-entry-summary">
                        <span class="scp-cl-entry-ver">v${escHtml(entry.version)}</span>
                        <span style="flex:1;opacity:.5">${escHtml(entry.date || '')}</span>
                    </summary>
                    <div class="scp-cl-entry-body"><ul>${li}</ul></div>
                </details>`;
            }).join('') +
            `</div>`;
    }

    return `<div class="scp-cl-current">
        <div class="scp-cl-version-badge">✦ Version ${escHtml(current.version)} ${current.date ? '· ' + escHtml(current.date) : ''}</div>
        <div class="scp-cl-notes"><ul>${notesHTML}</ul></div>
    </div>${historyHTML}`;
}

function openChangelog() {
    const modal = document.getElementById('scp-changelog-modal');
    if (!modal) return;
    const body = document.getElementById('scp-changelog-body');
    if (body) body.innerHTML = buildChangelogHTML();
    modal.style.display = 'flex';
}

function closeChangelog() {
    const modal = document.getElementById('scp-changelog-modal');
    if (modal) modal.style.display = 'none';
}

function checkChangelogAutoShow() {
    const s = getSettings();
    const current = CHANGELOG[0];
    const currentVersion = current?.version || '';
    if (s.changelogAutoShow && current?.announce !== false && s.lastSeenVersion !== currentVersion) {
        s.lastSeenVersion = currentVersion;
        saveSettings();
        setTimeout(openChangelog, 800);
    } else if (s.lastSeenVersion !== currentVersion) {
        s.lastSeenVersion = currentVersion;
        saveSettings();
    }
}

function setupChangelogListeners() {
    const modal = document.getElementById('scp-changelog-modal');
    if (!modal) return;
    document.getElementById('scp-changelog-close')?.addEventListener('click', closeChangelog);
    let _mdTarget = null;
    modal.addEventListener('mousedown', e => { _mdTarget = e.target; });
    modal.addEventListener('click', e => { if (e.target === modal && _mdTarget === modal) closeChangelog(); });
}

// ─── Init ──────────────────────────────────────────────────────────────────

async function loadManifestVersion() {
    try {
        const res = await fetch(`/scripts/extensions/${getExtPath()}/manifest.json`);
        if (res.ok) {
            const manifest = await res.json();
            setExtVersion(manifest.version || CHANGELOG[0]?.version || '?');
        } else {
            setExtVersion(CHANGELOG[0]?.version || '?');
        }
    } catch (_) {
        setExtVersion(CHANGELOG[0]?.version || '?');
    }
}

async function init() {
    dbgSetupGlobalErrorHandlers();
    try { setSTWorldInfo(await import('/scripts/world-info.js')); } catch(e) { console.warn('ST-Copilot: Could not import world-info.js'); }
    try { setSTUtils(await import('/scripts/utils.js')); } catch(e) { console.warn('ST-Copilot: Could not import utils.js'); }
    await loadManifestVersion();
    getSettings(); await injectUI();
    const ctx = SillyTavern.getContext();
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (container) {
        try {
            const html = await ctx.renderExtensionTemplateAsync(getExtPath(), 'settings');
            if (html) container.insertAdjacentHTML('beforeend', html);
        } catch (e) {}
    }
    restoreWindowState(); attachWindowListeners(); setupSettingsHandlers(); updateSettingsUI(); setupLorebookManagerListeners(); setupSettingsPanelListeners(); setupChatPickerListeners(); setupChangelogListeners();

    const s = getSettings();

    if (s.windowVisible && !s.minimized) {
        getWindowEl().style.display = 'flex';
        setCopilotActive(true);
    } else {
        getWindowEl().style.display = 'none';
        setCopilotActive(false);
    }

    updateIconVisibility();

    onChatChanged();
    const es = ctx.eventSource || window.eventSource;
    const et = ctx.event_types || window.event_types || {};

    if (es) {
        es.on(et.CHAT_CHANGED || 'chat_changed', onChatChanged);
        es.on(et.CHARACTER_SELECTED || 'character_selected', onChatChanged);
        es.on(et.APP_READY || 'app_ready', updateProfilesList);

        const dynEvents =[
            et.MESSAGE_RECEIVED || 'message_received',
            et.MESSAGE_SENT || 'message_sent',
            et.MESSAGE_DELETED || 'message_deleted',
            et.MESSAGE_UPDATED || 'message_updated',
            et.MESSAGE_SWIPED || 'message_swiped'
        ];

        dynEvents.forEach(e => {
            if (e) es.on(e, updateDepthSlidersMax);
        });
    }

    setupHotkey(); setupSearchHotkey(); setupGhostHotkey(); addWandButton();
    checkChangelogAutoShow();
    _takeProfileSnapshot();
    dbgSnapshotSettings();

    window.addEventListener('message', e => {
        if (!e.data || typeof e.data !== 'object') return;
        if (e.data.type === 'scp-iframe-h') {
            document.querySelectorAll('.scp-html-block-iframe').forEach(f => {
                try {
                    if (f.contentWindow === e.source) {
                        f.style.height = `${Math.max(40, Math.min(1200, e.data.h + 16))}px`;
                    }
                } catch(_) {}
            });
        } else if (e.data.type === 'scp-iframe-bg') {
            document.querySelectorAll('.scp-html-block-iframe').forEach(f => {
                try {
                    if (f.contentWindow === e.source) {
                        f.style.background = e.data.hasBg ? 'transparent' : '#ffffff';
                    }
                } catch(_) {}
            });
        } else if (e.data.type === 'scp-iframe-err') {
            document.querySelectorAll('.scp-html-block-iframe').forEach(f => {
                try {
                    if (f.contentWindow === e.source) {
                        const errEl = f.closest('.scp-html-block')?.querySelector('.scp-html-block-error');
                        if (errEl) { errEl.textContent = `⚠ ${e.data.msg}`; errEl.style.display = ''; }
                    }
                } catch(_) {}
            });
        }
    });

    const preventSpinBug = e => {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'number') {
            e.stopPropagation();
        }
    };
    [
        getWindowEl(),
        document.getElementById('scp-settings-overlay'),
        document.getElementById('scp-lb-overlay'),
        document.getElementById('scp-picker-overlay')
    ].filter(Boolean).forEach(el => {
        el.addEventListener('mousedown', preventSpinBug);
        el.addEventListener('mouseup', preventSpinBug);
        el.addEventListener('pointerdown', preventSpinBug);
        el.addEventListener('pointerup', preventSpinBug);
    });

    console.log(`[${EXT_DISPLAY}] Initialized.`);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else setTimeout(init, 0);
