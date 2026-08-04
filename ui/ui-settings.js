/**
 * ui-settings.js
 * The Settings Panel: the big multi-tab overlay (global config tab +
 * per-session override tab) plus the small always-visible ST drawer
 * controls that mirror a subset of the same settings.
 *
 * Two responsibilities live here side by side because the original code
 * kept them side by side and they're tightly coupled — almost every
 * setting has a "ST drawer" control AND a "Settings Panel" (global/override)
 * control that must stay in sync (see syncOverlayUI / syncSPFromSettings):
 *   - Settings Panel Handlers: builds/refreshes the overlay's state
 *     (syncSPFromSettings, updateSPConnProfileList, refreshSPProfilesDropdown,
 *     updateSPBindingSection) and the small ST-drawer-side handlers
 *     (setupSettingsHandlers, updateSettingsUI, syncOverlayUI).
 *   - Settings Panel Listeners: wires every control inside the overlay
 *     itself (setupSettingsPanelListeners) plus open/close (openSettingsPanel,
 *     closeSettingsPanel, openExtensionSettings).
 *
 * Moved from original index.js "Settings Panel Handlers" (old lines
 * 12176-13164) and "Settings Panel Listeners" (old lines 13165-13869),
 * 1694 lines total, unchanged apart from de-indenting out of the closure,
 * adding imports/exports, and the two fixes below.
 *
 * NAMING FIX: the old private `_syncBgToOverlay` is renamed to the public
 * `syncBgToOverlay` here — ui-window.js's Theme section already imports it
 * under that name as one of its two forward-deps (see ui-window.js's own
 * header), so the underscore was stale the moment this function needed to
 * be called from outside its original closure.
 *
 * FORWARD DEPS: this file is being built before ui-widgets.js (Quick
 * Prompts / Prompt Presets / Session Dropdown) and before the Chat Change /
 * Changelog sections land in index.js's bootstrap wiring. Five calls reach
 * forward into code that doesn't exist as a module yet:
 *   buildQPSettingsUI, buildQPSetManager, buildPromptPresetManager  (-> ui-widgets.js)
 *   onChatChanged                                                   (-> index.js bootstrap)
 *   openChangelog                                                   (-> index.js bootstrap, Changelog section)
 * Same pattern as ui-window.js/feature-lorebook-ui.js: no-op stubs here,
 * wired for real via setForwardDeps() once those modules exist:
 *   import { buildQPSettingsUI, buildQPSetManager, buildPromptPresetManager } from './ui-widgets.js'; // future
 *   import { onChatChanged, openChangelog } from '../index.js'; // future
 *   setForwardDeps({ buildQPSettingsUI, buildQPSetManager, buildPromptPresetManager, onChatChanged, openChangelog });
 */

import { EXT_DISPLAY, THEME_PRESETS } from '../constants.js';
import { DEFAULT_CHAR_EDIT_DIRECTIVE, DEFAULT_CHAT_EDIT_DIRECTIVE, DEFAULT_LB_MANAGE_PROMPT, DEFAULT_SYSTEM_PROMPT } from '../default-prompts.js';
import { getSettings, saveSettings } from '../settings.js';
import {
    clearAllSessionOverrides, getChatBucket, getCurrentSession, getEffectiveSettings,
    getSessionOverrides, hasSessionOverrides, initChatBucket, saveSessionsToMetadata,
    setSessionOverride, updateDepthSlidersMax, updateSPOverrideIndicators, updateSessionOverrideIndicator,
} from '../session.js';
import { $, showCustomDialog } from '../utils/util-dom.js';
import { dbgDownload } from '../utils/util-debug.js';
import { getBindingKey } from '../utils/util-st.js';
import {
    _clearDirty, _markDirty, _setupBgUpload, _updateDirtyDots,
    applyCustomTheme, applyWindowBackground, buildBackgroundSettingsUI, buildSoundSettingsUI,
    buildThemeEditor, deleteProfile, hideWindow, isConfigProfileDirty, loadProfile,
    refreshProfilesDropdown, saveProfile, setupGhostHotkey, setupHotkey, setupSearchHotkey,
    showWindow, updateBindingSection, updateIconVisibility, updateProfilesList,
    isGhostModeActive,
} from './ui-window.js';
import { updateMsgCount } from './ui-chat.js';
import { refreshAltGreetingsPickers } from '../features/feature-character-engine.js';
import { buildLorebookContextBlock } from '../features/feature-lorebook-engine.js';
import { renderEntryList, updateLBFooterInfo, getLbActiveBook, getLbSearchQuery } from '../features/feature-lorebook-ui.js';
import { renderStatsPane } from '../features/feature-stats.js';
import { getWindowEl } from '../state.js';

// ── Forward deps: ui-widgets.js and index.js bootstrap don't exist as
// modules yet. Real functions get swapped in via setForwardDeps() once
// they do; until then these no-ops keep the Settings Panel from throwing. ──
let _buildQPSettingsUI = () => {};
let _buildQPSetManager = () => {};
let _buildPromptPresetManager = () => {};
let _onChatChanged = () => {};
let _openChangelog = () => {};

export function setForwardDeps({ buildQPSettingsUI, buildQPSetManager, buildPromptPresetManager, onChatChanged, openChangelog } = {}) {
    if (buildQPSettingsUI) _buildQPSettingsUI = buildQPSettingsUI;
    if (buildQPSetManager) _buildQPSetManager = buildQPSetManager;
    if (buildPromptPresetManager) _buildPromptPresetManager = buildPromptPresetManager;
    if (onChatChanged) _onChatChanged = onChatChanged;
    if (openChangelog) _openChangelog = openChangelog;
}

// ─── Settings Panel Handlers ─────────────────────────────────────────────────

export function syncOverlayUI(key, val) {
    const gIdMap = {
        connectionSource: 'scp-sp-conn-source',
        connectionProfileId: 'scp-sp-conn-profile',
        includeSystemPrompt: 'scp-sp-include-sysprompt',
        includeUserPersonality: 'scp-sp-include-persona',
        applyRegexToContext: 'scp-sp-apply-regex',
        includeInlineSummaryOriginals: 'scp-sp-inline-summary-originals',
        contextDepth: 'scp-sp-depth-slider',
        wobbleWindow: 'scp-sp-wobble-window',
        performanceMode: 'scp-sp-perf-mode'
    };
    const gId = gIdMap[key];
    if (gId) {
        const gEl = document.getElementById(gId);
        if (gEl) {
            if (gEl.type === 'checkbox') gEl.checked = !!val;
            else gEl.value = val ?? '';
        }
        if (key === 'connectionSource') {
            const gPg = document.getElementById('scp-sp-global-profile-group');
            if (gPg) gPg.style.display = val === 'profile' ? '' : 'none';
        }
        if (key === 'contextDepth') {
            const gDv = document.getElementById('scp-sp-depth-val');
            if (gDv) gDv.textContent = val ?? 15;
        }
    }

    if (key === 'forceStreaming') {
        const streamVal = val === true ? 'on' : (val === false ? 'auto' : (val || 'auto'));
        
        document.querySelectorAll('.scp-stream-btn:not(.scp-ov-stream-btn)').forEach(b => {
            b.classList.toggle('active', b.dataset.stream === streamVal);
        });

        const ov = getSessionOverrides();
        if (!('forceStreaming' in ov)) {
            document.querySelectorAll('.scp-ov-stream-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.stream === streamVal);
            });
        }
        return;
    }

    const ov = getSessionOverrides();
    if (key in ov) return;

    const eff = getEffectiveSettings();
    const ovIdMap = {
        connectionSource: 'scp-sp-ov-conn-source',
        connectionProfileId: 'scp-sp-ov-conn-profile',
        includeSystemPrompt: 'scp-sp-ov-include-sysprompt',
        includeUserPersonality: 'scp-sp-ov-include-persona',
        applyRegexToContext: 'scp-sp-ov-apply-regex',
        includeInlineSummaryOriginals: 'scp-sp-ov-inline-summary-originals',
        contextDepth: 'scp-sp-ov-depth-slider',
        charField_tags: 'scp-sp-ov-ce-tags',
        charField_description: 'scp-sp-ov-ce-description',
        charField_personality: 'scp-sp-ov-ce-personality',
        charField_scenario: 'scp-sp-ov-ce-scenario',
        charField_first_mes: 'scp-sp-ov-ce-first-mes',
        charField_mes_example: 'scp-sp-ov-ce-mes-example',
        charField_authors_note: 'scp-sp-ov-ce-authors-note',
        charField_alternate_greetings: 'scp-sp-ov-ce-alt-greetings',
    };

    const ovId = ovIdMap[key];
    if (ovId) {
        const ovEl = document.getElementById(ovId);
        if (ovEl) {
            if (ovEl.type === 'checkbox') {
                if (key.startsWith('charField_')) {
                    const fKey = key.replace('charField_', '');
                    ovEl.checked = !!(getSettings().charEditFields || {})[fKey];
                } else {
                    ovEl.checked = !!eff[key];
                }
            }
            else ovEl.value = eff[key] ?? '';
        }
        if (key === 'connectionSource') {
            const pg = document.getElementById('scp-sp-ov-profile-group');
            if (pg) pg.style.display = eff.connectionSource === 'profile' ? '' : 'none';
        }
        if (key === 'contextDepth') {
            const dv = document.getElementById('scp-sp-ov-depth-val');
            if (dv) dv.textContent = eff.contextDepth ?? 15;
        }
        
        if (key === 'charField_alternate_greetings') {
            const picker = document.getElementById('scp-sp-ov-ce-alt-greetings-picker');
            if (picker) {
                picker.style.display = ovEl && ovEl.checked ? '' : 'none';
                refreshAltGreetingsPickers();
            }
        }
    }
}

export function updateSettingsUI() {
    const s = getSettings();
    const setC = (id, key) => { const el = $(id); if (el) el.checked = !!s[key]; };
    const setI = (id, key) => { const el = $(id); if (el) el.value = s[key] ?? ''; };
    
    setC('scp-enabled', 'enabled');
    setC('scp-hotkey-enabled', 'hotkeyEnabled');
    setC('scp-search-hotkey-enabled', 'searchHotkeyEnabled');
    setI('scp-search-hotkey', 'searchHotkey');
    setC('scp-include-sysprompt', 'includeSystemPrompt');
    setC('scp-include-persona', 'includeUserPersonality');
    setC('scp-apply-regex', 'applyRegexToContext');
    setC('scp-inline-summary-originals', 'includeInlineSummaryOriginals');
    setC('scp-icon-persistent', 'floatingIconPersistent');
    setC('scp-ghost-hotkey-enabled', 'ghostModeHotkeyEnabled');
    setI('scp-hotkey', 'hotkey');
    setI('scp-max-tokens', 'maxTokens');
    setI('scp-history-limit', 'localHistoryLimit');
    setI('scp-depth-slider', 'contextDepth');
    setI('scp-reasoning-trim', 'reasoningTrimStrings');
    setI('scp-ghost-hotkey', 'ghostModeHotkey');
    const wobbleEl = $('scp-wobble-window'); if (wobbleEl) wobbleEl.checked = s.wobbleWindow !== false;
    setC('scp-perf-mode', 'performanceMode');
    setC('scp-char-edit-enabled', 'charEditAIEnabled');

    const fsVal = s.forceStreaming === true ? 'on' : (s.forceStreaming === false ? 'auto' : (s.forceStreaming || 'auto'));
    document.querySelectorAll('#scp-st-stream-auto, #scp-st-stream-on, #scp-st-stream-off').forEach(b => {
        const active = b.dataset.stream === fsVal;
        b.classList.toggle('active', active);
        b.style.color = active ? 'var(--SmartThemeQuoteColor,#a99bfb)' : '';
        b.style.borderColor = active ? 'rgba(124,109,250,0.5)' : '';
        b.style.background = active ? 'rgba(124,109,250,0.12)' : '';
    });
    const cePromptEl = $('scp-char-edit-prompt');
    if (cePromptEl) cePromptEl.value = s.charEditPrompt || DEFAULT_CHAR_EDIT_DIRECTIVE.trim();

    const ceFields = s.charEditFields || {};
    const setCe = (id, k) => { const el = $(id); if (el) el.checked = ceFields[k] !== false; };
    setCe('scp-ce-tags', 'tags');
    setCe('scp-ce-description', 'description');
    setCe('scp-ce-personality', 'personality');
    setCe('scp-ce-scenario', 'scenario');
    setCe('scp-ce-first-mes', 'first_mes');
    setCe('scp-ce-mes-example', 'mes_example');
    setCe('scp-ce-authors-note', 'authors_note');
    const agEl = $('scp-ce-alt-greetings'); if (agEl) agEl.checked = !!ceFields.alternate_greetings;

    const opSlider = $('scp-opacity-slider');
    const opVal = $('scp-opacity-val');
    if (opSlider) opSlider.value = s.opacity ?? 95;
    if (opVal) opVal.textContent = `${s.opacity ?? 95}%`;

    const ghOp = $('scp-ghost-opacity');
    const ghOpVal = $('scp-ghost-opacity-val');
    if (ghOp) ghOp.value = s.ghostModeOpacity ?? 15;
    if (ghOpVal) ghOpVal.textContent = `${s.ghostModeOpacity ?? 15}%`;
    
    const dv = $('scp-depth-val');
    if (dv) dv.textContent = s.contextDepth ?? 15;
    
    const cs = $('scp-conn-source');
    if (cs) {
        cs.value = s.connectionSource ?? 'default';
        const gGroup = $('scp-profile-group');
        if (gGroup) gGroup.style.display = cs.value === 'profile' ? '' : 'none';
    }
    
    const spEl = $('scp-sysprompt');
    if (spEl) spEl.value = s.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    
    const profSel = $('scp-conn-profile');
    if (profSel) profSel.value = s.connectionProfileId ?? '';

    const wand = $('scp-wand-btn');
    if (wand) wand.style.display = s.enabled ? '' : 'none';
    buildBackgroundSettingsUI(document.getElementById('scp-bg-settings'));

    const pickerLinesEl = $('scp-picker-lines');
    if (pickerLinesEl) pickerLinesEl.value = s.pickerPreviewLines ?? 1;
    const pickerLastEl = $('scp-picker-last-lines');
    if (pickerLastEl) pickerLastEl.value = s.pickerPreviewLastLines ?? 0;

    const imageModeEl = $('scp-image-mode');
    if (imageModeEl) imageModeEl.value = s.imageAnalysisMode || 'direct';

    const soundUnfocusedEl = $('scp-sound-unfocused');
    if (soundUnfocusedEl) soundUnfocusedEl.checked = !!s.completionSoundOnlyWhenUnfocused;

    if (typeof buildThemeEditor === 'function') buildThemeEditor();
    buildSoundSettingsUI($('scp-sound-settings'));
    refreshAltGreetingsPickers();

    const lbPromptEl3 = $('scp-lb-manage-prompt');
    if (lbPromptEl3) lbPromptEl3.value = s.lorebookManagePrompt || DEFAULT_LB_MANAGE_PROMPT;
    setI('scp-lb-st-scan-depth', 'lorebookSTScanDepth');
    setI('scp-lb-copilot-scan-depth', 'lorebookCopilotScanDepth');
    const lbAiStEl2 = $('scp-lb-ai-enabled-st');
    if (lbAiStEl2) lbAiStEl2.checked = !!s.lorebookAIManageEnabled;
    const lbKwStEl2 = $('scp-lb-auto-kw-st');
    if (lbKwStEl2) lbKwStEl2.checked = !!s.lorebookAutoKeyword;

    const chatEditEnabledStEl = $('scp-chat-edit-enabled-st');
    if (chatEditEnabledStEl) chatEditEnabledStEl.checked = !!s.chatEditAIEnabled;
    const chatEditPromptStEl = $('scp-chat-edit-prompt-st');
    if (chatEditPromptStEl) chatEditPromptStEl.value = s.chatEditPrompt || DEFAULT_CHAT_EDIT_DIRECTIVE.trim();
}

export function setupSettingsHandlers() {
    const s = getSettings();

    const updCtx = () => updateMsgCount(getCurrentSession());

    const bindCheck = (id, key, cb) => {
        const el = $(id); if (!el) return;
        el.checked = !!s[key];
        el.addEventListener('change', () => { 
            getSettings()[key] = el.checked; saveSettings(); 
            syncOverlayUI(key, el.checked);
            _markDirty('config');
            if (cb) cb(); 
        });
    };
    const bindInput = (id, key, toVal, cb) => {
        const el = $(id); if (!el) return;
        el.value = s[key] ?? '';
        el.addEventListener('input', () => { 
            const v = toVal ? toVal(el.value) : el.value;
            getSettings()[key] = v; saveSettings(); 
            syncOverlayUI(key, v);
            _markDirty('config');
            if (cb) cb(); 
        });
    };
    const bindSelect = (id, key, cb) => {
        const el = $(id); if (!el) return;
        el.value = s[key] ?? '';
        el.addEventListener('change', () => { 
            getSettings()[key] = el.value; saveSettings(); 
            syncOverlayUI(key, el.value);
            _markDirty('config');
            if (cb) cb(el.value); 
        });
    };

    bindCheck('scp-enabled', 'enabled', () => {
        const ss = getSettings();
        const btn = $('scp-wand-btn');
        if (btn) btn.style.display = ss.enabled ? '' : 'none';
        if (!ss.enabled) hideWindow();
        updateIconVisibility();
        setupHotkey();
    });
    
    bindCheck('scp-hotkey-enabled', 'hotkeyEnabled');
    bindCheck('scp-include-sysprompt', 'includeSystemPrompt', updCtx);
    bindCheck('scp-include-persona', 'includeUserPersonality', updCtx);
    bindCheck('scp-apply-regex', 'applyRegexToContext');
    bindCheck('scp-inline-summary-originals', 'includeInlineSummaryOriginals', updCtx);
    
    const stUpdateStreamBtns = (val) => {
        document.querySelectorAll('#scp-st-stream-auto, #scp-st-stream-on, #scp-st-stream-off').forEach(b => {
            const active = b.dataset.stream === val;
            b.classList.toggle('active', active);
            b.style.color = active ? 'var(--SmartThemeQuoteColor,#a99bfb)' : '';
            b.style.borderColor = active ? 'rgba(124,109,250,0.5)' : '';
            b.style.background = active ? 'rgba(124,109,250,0.12)' : '';
        });
    };
    ['scp-st-stream-auto', 'scp-st-stream-on', 'scp-st-stream-off'].forEach(id => {
        const btn = $(id); if (!btn) return;
        btn.addEventListener('click', () => {
            const val = btn.dataset.stream;
            getSettings().forceStreaming = val; 
            saveSettings();
            syncOverlayUI('forceStreaming', val);
            _markDirty('config');
        });
    });
    
    bindCheck('scp-icon-persistent', 'floatingIconPersistent', updateIconVisibility);
    bindCheck('scp-wobble-window', 'wobbleWindow');
    bindCheck('scp-perf-mode', 'performanceMode', () => {
        applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    });

    // Opacity slider (ST drawer)
    const opSlider = $('scp-opacity-slider');
    const opVal = $('scp-opacity-val');
    if (opSlider) {
        opSlider.value = s.opacity ?? 95;
        if (opVal) opVal.textContent = `${opSlider.value}%`;
        opSlider.addEventListener('input', () => { if (opVal) opVal.textContent = `${opSlider.value}%`; });
        opSlider.addEventListener('change', () => {
            const v = parseInt(opSlider.value);
            getSettings().opacity = v; saveSettings();
            if (!isGhostModeActive() && getWindowEl()) getWindowEl().style.opacity = (v / 100).toString();
            const spOpSlider = document.getElementById('scp-sp-opacity-slider');
            const spOpVal = document.getElementById('scp-sp-opacity-val');
            if (spOpSlider) spOpSlider.value = v;
            if (spOpVal) spOpVal.textContent = `${v}%`;
        });
    }

    // Ghost mode (ST drawer)
    const ghOp = $('scp-ghost-opacity');
    const ghOpVal = $('scp-ghost-opacity-val');
    if (ghOp) {
        ghOp.value = s.ghostModeOpacity ?? 15;
        if (ghOpVal) ghOpVal.textContent = `${ghOp.value}%`;
        ghOp.addEventListener('input', () => { if (ghOpVal) ghOpVal.textContent = `${ghOp.value}%`; });
        ghOp.addEventListener('change', () => {
            const v = parseInt(ghOp.value);
            getSettings().ghostModeOpacity = v; saveSettings();
            if (isGhostModeActive() && getWindowEl()) getWindowEl().style.opacity = (v / 100).toString();
            const spGhOp = document.getElementById('scp-sp-ghost-opacity');
            const spGhOpVal = document.getElementById('scp-sp-ghost-opacity-val');
            if (spGhOp) spGhOp.value = v;
            if (spGhOpVal) spGhOpVal.textContent = `${v}%`;
        });
    }
    bindCheck('scp-ghost-hotkey-enabled', 'ghostModeHotkeyEnabled', setupGhostHotkey);
    bindInput('scp-ghost-hotkey', 'ghostModeHotkey', null, setupGhostHotkey);
    bindCheck('scp-search-hotkey-enabled', 'searchHotkeyEnabled', setupSearchHotkey);
    bindInput('scp-search-hotkey', 'searchHotkey', null, setupSearchHotkey);
    const reasoningTrimEl = $('scp-reasoning-trim');
    if (reasoningTrimEl) {
        reasoningTrimEl.value = getSettings().reasoningTrimStrings || '';
        reasoningTrimEl.addEventListener('input', () => { getSettings().reasoningTrimStrings = reasoningTrimEl.value; saveSettings(); });
    }
    bindInput('scp-hotkey', 'hotkey');
    bindInput('scp-max-tokens', 'maxTokens', Number);
    bindInput('scp-history-limit', 'localHistoryLimit', Number, updCtx);
    bindSelect('scp-conn-source', 'connectionSource', v => {
        const g = $('scp-profile-group');
        if (g) g.style.display = v === 'profile' ? '' : 'none';
    });

    if ($('scp-profile-group')) {
        $('scp-profile-group').style.display = s.connectionSource === 'profile' ? '' : 'none';
    }

    const spEl = $('scp-sysprompt');
    if (spEl) {
        spEl.value = s.systemPrompt || DEFAULT_SYSTEM_PROMPT;
        spEl.addEventListener('input', () => { getSettings().systemPrompt = spEl.value; saveSettings(); updCtx(); });
    }

    bindCheck('scp-char-edit-enabled', 'charEditAIEnabled', updCtx);
    
    const charEditPromptEl = $('scp-char-edit-prompt');
    if (charEditPromptEl) {
        charEditPromptEl.value = s.charEditPrompt || DEFAULT_CHAR_EDIT_DIRECTIVE.trim();
        charEditPromptEl.addEventListener('input', () => {
            const val = charEditPromptEl.value;
            getSettings().charEditPrompt = (val.trim() === DEFAULT_CHAR_EDIT_DIRECTIVE.trim()) ? '' : val;
            saveSettings();
            _markDirty('config');
        });
    }
    
    const bGCharFieldST = (id, fieldKey) => {
        const el = $(id); if (!el) return;
        const ceF = getSettings().charEditFields || {};
        el.checked = ceF[fieldKey] !== false;
        el.addEventListener('change', () => {
            const s = getSettings();
            if (!s.charEditFields) s.charEditFields = {};
            s.charEditFields[fieldKey] = el.checked;
            saveSettings(); updateMsgCount(getCurrentSession());
            const ovEl = document.getElementById(`scp-sp-ce-${fieldKey.replace(/_/g, '-')}`);
            if (ovEl) ovEl.checked = el.checked;
            _markDirty('config');
        });
        syncOverlayUI('charField_' + fieldKey, el.checked);
    };
    bGCharFieldST('scp-ce-tags', 'tags');
    bGCharFieldST('scp-ce-description', 'description');
    bGCharFieldST('scp-ce-personality', 'personality');
    bGCharFieldST('scp-ce-scenario', 'scenario');
    bGCharFieldST('scp-ce-first-mes', 'first_mes');
    bGCharFieldST('scp-ce-mes-example', 'mes_example');
    bGCharFieldST('scp-ce-authors-note', 'authors_note');
    bGCharFieldST('scp-ce-alt-greetings', 'alternate_greetings');
    $('scp-ce-alt-greetings')?.addEventListener('change', () => {
        const picker = document.getElementById('scp-ce-alt-greetings-picker');
        if (picker) { picker.style.display = getSettings().charEditFields?.alternate_greetings ? '' : 'none'; refreshAltGreetingsPickers(); }
    });

    $('scp-reset-char-edit-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Char Edit Prompt', message: 'Reset to built-in default prompt?' });
        if (!ok) return;
        getSettings().charEditPrompt = '';
        saveSettings();
        _markDirty('config');
        const el = $('scp-char-edit-prompt');
        if (el) el.value = DEFAULT_CHAR_EDIT_DIRECTIVE.trim();
        const ovEl = $('scp-sp-char-edit-prompt');
        if (ovEl) ovEl.value = DEFAULT_CHAR_EDIT_DIRECTIVE.trim();
        toastr.success('Char edit prompt reset.', EXT_DISPLAY);
    });

    $('scp-reset-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset System Prompt', message: 'Reset to default? Your current prompt will be lost.' });
        if (!ok) return;
        getSettings().systemPrompt = DEFAULT_SYSTEM_PROMPT;
        if (spEl) spEl.value = DEFAULT_SYSTEM_PROMPT;
        saveSettings(); updCtx(); toastr.success('System prompt reset.', EXT_DISPLAY);
    });

    $('scp-hotkey')?.addEventListener('change', setupHotkey);
    $('scp-hotkey-enabled')?.addEventListener('change', setupHotkey);

    const profSel = $('scp-conn-profile');
    if (profSel) {
        profSel.addEventListener('mouseenter', updateProfilesList);
        profSel.addEventListener('focus', updateProfilesList);
        profSel.addEventListener('change', () => { 
            getSettings().connectionProfileId = profSel.value; 
            saveSettings(); 
            syncOverlayUI('connectionProfileId', profSel.value);
        });
    }

    // Config profiles
    refreshProfilesDropdown();

    $('scp-profile-select')?.addEventListener('change', async () => {
        const sel = $('scp-profile-select');
        const name = sel.value;
        
        if (isConfigProfileDirty()) {
            const ok = await showCustomDialog({ 
                type: 'confirm', 
                title: 'Unsaved Configuration', 
                message: 'You have unsaved changes in your current configuration profile. Are you sure you want to switch?' 
            });
            if (!ok) {
                sel.value = getSettings().activeProfile || '';
                return;
            }
        }
        
        if (name) loadProfile(name);
        updateBindingSection();
    });

    $('scp-profile-save')?.addEventListener('click', async () => {
        const sel = $('scp-profile-select');
        let name = sel?.value;
        if (!name) {
            name = await showCustomDialog({ type: 'prompt', title: 'Save Configuration', message: 'Enter a name for this configuration:', placeholder: 'My Config' });
            if (!name?.trim()) return;
            name = name.trim();
        }
        saveProfile(name); refreshProfilesDropdown();
        if (sel) sel.value = name;
        updateBindingSection(); toastr.success(`Saved "${name}"`, EXT_DISPLAY);
        _clearDirty('config');
    });

    $('scp-profile-create-new')?.addEventListener('click', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'New Configuration', message: 'Enter a name for the new default profile:', placeholder: 'New Config' });
        if (!name?.trim()) return;
        const n = name.trim();
        const s2 = getSettings();
        s2.profiles[n] = {
            systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true,
            includeAuthorsNote: true, includeCharacterCard: true,
            includeUserPersonality: true, contextDepth: 15,
            localHistoryLimit: 50,
            connectionSource: 'default', connectionProfileId: '',
            maxTokens: 8200,
        };
        saveSettings(); refreshProfilesDropdown();
        loadProfile(n);
        const sel = $('scp-profile-select'); if (sel) sel.value = n;
        updateBindingSection(); toastr.success(`Created "${n}"`, EXT_DISPLAY);
    });

    $('scp-profile-duplicate')?.addEventListener('click', async () => {
        const sel = $('scp-profile-select');
        if (!sel?.value) return toastr.info('No configuration selected.', EXT_DISPLAY);
        const defaultName = sel.value + ' (Copy)';
        const newName = await showCustomDialog({ type: 'prompt', title: 'Duplicate Configuration', message: 'Name for the new profile:', defaultValue: defaultName });
        if (!newName?.trim()) return;
        const n = newName.trim();
        const s2 = getSettings();
        const p = s2.profiles[sel.value];
        if (!p) return;
        s2.profiles[n] = JSON.parse(JSON.stringify(p));
        saveSettings(); refreshProfilesDropdown(); refreshSPProfilesDropdown();
        loadProfile(n);
        const newSel = $('scp-profile-select'); if (newSel) newSel.value = n;
        updateBindingSection(); toastr.success(`Duplicated as "${n}"`, EXT_DISPLAY);
    });

    $('scp-profile-rename')?.addEventListener('click', async () => {
        const sel = $('scp-profile-select');
        if (!sel?.value) return toastr.info('No configuration selected.', EXT_DISPLAY);
        const newName = await showCustomDialog({ type: 'prompt', title: 'Rename Configuration', message: 'New name:', defaultValue: sel.value });
        if (!newName?.trim() || newName.trim() === sel.value) return;
        const s2 = getSettings(); const p = s2.profiles[sel.value]; if (!p) return;
        s2.profiles[newName.trim()] = p; delete s2.profiles[sel.value];
        if (s2.activeProfile === sel.value) s2.activeProfile = newName.trim();
        for (const k in s2.profileBindings) { if (s2.profileBindings[k] === sel.value) s2.profileBindings[k] = newName.trim(); }
        saveSettings(); refreshProfilesDropdown();
        const newSel = $('scp-profile-select'); if (newSel) newSel.value = newName.trim();
        updateBindingSection(); toastr.success('Renamed.', EXT_DISPLAY);
    });

    $('scp-profile-delete')?.addEventListener('click', async () => {
        const sel = $('scp-profile-select'); if (!sel?.value) return;
        const s2 = getSettings();
        if (Object.keys(s2.profiles).length <= 1) {
            toastr.warning('Cannot delete the last remaining configuration profile.', EXT_DISPLAY);
            return;
        }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Configuration', message: `Delete "${sel.value}"?` });
        if (!ok) return;
        deleteProfile(sel.value); refreshProfilesDropdown(); updateBindingSection();
        toastr.success('Deleted.', EXT_DISPLAY);
    });

    $('scp-bind-char')?.addEventListener('click', () => {
        const sel = $('scp-profile-select'); if (!sel?.value) return;
        const s2 = getSettings(); const { charId } = getBindingKey(); const key = `char_${charId}`;
        if (s2.profileBindings[key] === sel.value) delete s2.profileBindings[key];
        else s2.profileBindings[key] = sel.value;
        saveSettings(); updateBindingSection();
    });

    $('scp-bind-chat')?.addEventListener('click', () => {
        const sel = $('scp-profile-select'); if (!sel?.value) return;
        const s2 = getSettings(); const { charId, chatId } = getBindingKey(); const key = `chat_${charId}_${chatId}`;
        if (s2.profileBindings[key] === sel.value) delete s2.profileBindings[key];
        else s2.profileBindings[key] = sel.value;
        saveSettings(); updateBindingSection();
    });

    $('scp-open-window')?.addEventListener('click', showWindow);
    $('scp-download-debug')?.addEventListener('click', dbgDownload);
    const handleClearAllSessions = async () => {
        const ok = await showCustomDialog({ 
            type: 'confirm', 
            title: 'Clear All Sessions', 
            message: 'Delete ALL Copilot sessions from global storage AND clear sessions for the CURRENT chat? (Cannot clear other inactive chats). This cannot be undone.',
            delayConfirm: 3
        });
        if (!ok) return;
        getSettings().sessions = {}; saveSettings(); 
        const ctx = SillyTavern.getContext();
        if (ctx.chatMetadata) delete ctx.chatMetadata.st_copilot;
        await initChatBucket();
        _onChatChanged();
        toastr.success('Sessions cleared.', EXT_DISPLAY);
    };
    document.getElementById('scp-clear-sessions')?.addEventListener('click', handleClearAllSessions);

    updateProfilesList();
    buildThemeEditor();

    // LB and Auto-Keywords toggles (ST drawer)
    const lbAiStEl = $('scp-lb-ai-enabled-st');
    if (lbAiStEl) {
        lbAiStEl.checked = !!getSettings().lorebookAIManageEnabled;
        lbAiStEl.addEventListener('change', () => {
            getSettings().lorebookAIManageEnabled = lbAiStEl.checked; saveSettings();
            const spEl2 = document.getElementById('scp-sp-lb-ai-enabled');
            if (spEl2) spEl2.checked = lbAiStEl.checked;
        });
    }
    const lbKwStEl = $('scp-lb-auto-kw-st');
    if (lbKwStEl) {
        lbKwStEl.checked = !!getSettings().lorebookAutoKeyword;
        lbKwStEl.addEventListener('change', async () => {
            const s2 = getSettings(); s2.lorebookAutoKeyword = lbKwStEl.checked; saveSettings();
            await buildLorebookContextBlock(s2);
            updateLBFooterInfo();
            if (getLbActiveBook()) await renderEntryList(getLbActiveBook(), getLbSearchQuery());
            updateMsgCount(getCurrentSession());
            const spEl2 = document.getElementById('scp-sp-lb-auto-kw');
            if (spEl2) spEl2.checked = lbKwStEl.checked;
        });
    }

    bindInput('scp-lb-st-scan-depth', 'lorebookSTScanDepth', Number);
    bindInput('scp-lb-copilot-scan-depth', 'lorebookCopilotScanDepth', Number);

    const lbPromptEl = $('scp-lb-manage-prompt');
    if (lbPromptEl) {
        lbPromptEl.value = s.lorebookManagePrompt || DEFAULT_LB_MANAGE_PROMPT;
        lbPromptEl.addEventListener('input', () => { getSettings().lorebookManagePrompt = lbPromptEl.value; saveSettings(); });
    }
    $('scp-reset-lb-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Lorebook Prompt', message: 'Reset to default?' });
        if (!ok) return;
        getSettings().lorebookManagePrompt = DEFAULT_LB_MANAGE_PROMPT;
        const el = $('scp-lb-manage-prompt'); if (el) el.value = DEFAULT_LB_MANAGE_PROMPT;
        saveSettings(); toastr.success('Lorebook prompt reset.', EXT_DISPLAY);
    });

    // Chat Edit handlers (ST drawer)
    const chatEditEnabledStEl = $('scp-chat-edit-enabled-st');
    if (chatEditEnabledStEl) {
        chatEditEnabledStEl.checked = !!getSettings().chatEditAIEnabled;
        chatEditEnabledStEl.addEventListener('change', () => {
            getSettings().chatEditAIEnabled = chatEditEnabledStEl.checked; saveSettings();
            const spEl2 = document.getElementById('scp-sp-chat-edit-enabled');
            if (spEl2) spEl2.checked = chatEditEnabledStEl.checked;
            updateMsgCount(getCurrentSession());
        });
    }
    const chatEditPromptStEl = $('scp-chat-edit-prompt-st');
    if (chatEditPromptStEl) {
        chatEditPromptStEl.value = getSettings().chatEditPrompt || DEFAULT_CHAT_EDIT_DIRECTIVE.trim();
        chatEditPromptStEl.addEventListener('input', () => {
            const val = chatEditPromptStEl.value;
            getSettings().chatEditPrompt = (val.trim() === DEFAULT_CHAT_EDIT_DIRECTIVE.trim()) ? '' : val;
            saveSettings();
            _markDirty('config');
            const spEl2 = document.getElementById('scp-sp-chat-edit-prompt');
            if (spEl2) spEl2.value = chatEditPromptStEl.value;
        });
    }
    $('scp-reset-chat-edit-prompt-st')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Chat Edit Prompt', message: 'Reset to default?' });
        if (!ok) return;
        getSettings().chatEditPrompt = ''; saveSettings(); _markDirty('config');
        if (chatEditPromptStEl) chatEditPromptStEl.value = DEFAULT_CHAT_EDIT_DIRECTIVE.trim();
        const spEl2 = document.getElementById('scp-sp-chat-edit-prompt');
        if (spEl2) spEl2.value = DEFAULT_CHAT_EDIT_DIRECTIVE.trim();
        toastr.success('Chat edit prompt reset.', EXT_DISPLAY);
    });

    // ── NEW SETTINGS ──

    // Sound unfocused (ST)
    const soundUnfocusedEl = $('scp-sound-unfocused');
    if (soundUnfocusedEl) {
        soundUnfocusedEl.checked = !!getSettings().completionSoundOnlyWhenUnfocused;
        soundUnfocusedEl.addEventListener('change', () => {
            getSettings().completionSoundOnlyWhenUnfocused = soundUnfocusedEl.checked;
            saveSettings();
            const spEl = document.getElementById('scp-sp-sound-unfocused');
            if (spEl) spEl.checked = soundUnfocusedEl.checked;
        });
    }

    // Background (ST)
    const _bindBg = (typeId, urlId, urlGrpId, dimId, dimGrpId, dimValId) => {
        const typeEl = $(typeId);
        const urlEl = $(urlId);
        const urlGrp = $(urlGrpId);
        const dimEl = $(dimId);
        const dimGrp = $(dimGrpId);
        const dimValEl = $(dimValId);
        const s2 = getSettings();
        if (typeEl) {
            typeEl.value = s2.windowBgType || 'none';
            typeEl.addEventListener('change', () => {
                getSettings().windowBgType = typeEl.value;
                saveSettings();
                if (urlGrp) urlGrp.style.display = typeEl.value !== 'none' ? '' : 'none';
                if (dimGrp) dimGrp.style.display = typeEl.value !== 'none' ? '' : 'none';
                applyWindowBackground();
                syncBgToOverlay();
            });
        }
        if (urlEl) {
            urlEl.value = s2.windowBgUrl || '';
            urlEl.addEventListener('input', () => {
                getSettings().windowBgUrl = urlEl.value;
                saveSettings();
                applyWindowBackground();
                syncBgToOverlay();
            });
        }
        if (dimEl) {
            dimEl.value = s2.windowBgDim ?? 50;
            if (dimValEl) dimValEl.textContent = `${dimEl.value}%`;
            dimEl.addEventListener('input', () => {
                if (dimValEl) dimValEl.textContent = `${dimEl.value}%`;
            });
            dimEl.addEventListener('change', () => {
                getSettings().windowBgDim = parseInt(dimEl.value);
                saveSettings();
                applyWindowBackground();
                syncBgToOverlay();
            });
        }
    };
    _bindBg('scp-bg-type','scp-bg-url','scp-bg-url-group','scp-bg-dim','scp-bg-dim-group','scp-bg-dim-val');

    bindInput('scp-picker-lines', 'pickerPreviewLines', Number);
    bindInput('scp-picker-last-lines', 'pickerPreviewLastLines', Number);

    bindSelect('scp-image-mode', 'imageAnalysisMode', () => {
        const spEl = document.getElementById('scp-sp-image-mode');
        if (spEl) spEl.value = getSettings().imageAnalysisMode;
    });

    _setupBgUpload('scp-bg-upload-btn', 'scp-bg-url');
}

export function syncBgToOverlay() {
    const s = getSettings();
    const bgType = s.windowBgType || 'none';
    ['scp-sp-bg-type','scp-bg-type'].forEach(id => { const el = document.getElementById(id); if (el) el.value = bgType; });
    ['scp-sp-bg-url','scp-bg-url'].forEach(id => { const el = document.getElementById(id); if (el) el.value = s.windowBgUrl || ''; });
    ['scp-sp-bg-dim','scp-bg-dim'].forEach(id => { const el = document.getElementById(id); if (el) el.value = s.windowBgDim ?? 50; });
    ['scp-sp-bg-dim-val','scp-bg-dim-val'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = `${s.windowBgDim ?? 50}%`; });
    [['scp-sp-bg-url-group','scp-bg-url-group'],['scp-sp-bg-dim-group','scp-bg-dim-group']].forEach(([a,b]) => {
        [a,b].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = bgType !== 'none' ? '' : 'none'; });
    });
}

export function openSettingsPanel() {
    const overlay = document.getElementById('scp-settings-overlay');
    if (!overlay) return;
    applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    syncSPFromSettings();
    buildThemeEditor(document.getElementById('scp-sp-theme-section'));
    _updateDirtyDots();
    buildSoundSettingsUI(document.getElementById('scp-sp-sound-settings'));
    _buildQPSettingsUI(document.getElementById('scp-sp-qp-container'));
    refreshAltGreetingsPickers();
    _buildQPSetManager(document.getElementById('scp-sp-qp-set-manager'), () => {
        _buildQPSettingsUI(document.getElementById('scp-sp-qp-container'));
    });

    _buildPromptPresetManager(
        document.getElementById('scp-sp-prompt-preset-manager'),
        () => document.getElementById('scp-sp-ov-sysprompt')?.value || '',
        (text) => {
            const ta = document.getElementById('scp-sp-ov-sysprompt');
            if (!ta) return;
            ta.value = text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
    );
    _buildPromptPresetManager(document.getElementById('scp-sp-ov-char-preset-manager'), 
        () => document.getElementById('scp-sp-ov-char-edit-prompt')?.value || '', 
        (text) => { const ta = document.getElementById('scp-sp-ov-char-edit-prompt'); if(ta) { ta.value = text; ta.dispatchEvent(new Event('input', {bubbles:true})); } }, 
        'charEditPromptPresets');

    _buildPromptPresetManager(document.getElementById('scp-sp-ov-lb-preset-manager'), 
        () => document.getElementById('scp-sp-ov-lb-manage-prompt')?.value || '', 
        (text) => { const ta = document.getElementById('scp-sp-ov-lb-manage-prompt'); if(ta) { ta.value = text; ta.dispatchEvent(new Event('input', {bubbles:true})); } }, 
        'lbEditPromptPresets');

    _buildPromptPresetManager(document.getElementById('scp-sp-ov-chat-preset-manager'), 
        () => document.getElementById('scp-sp-ov-chat-edit-prompt')?.value || '', 
        (text) => { const ta = document.getElementById('scp-sp-ov-chat-edit-prompt'); if(ta) { ta.value = text; ta.dispatchEvent(new Event('input', {bubbles:true})); } }, 
        'chatEditPromptPresets');

    overlay.style.display = 'flex';
    updateSessionOverrideIndicator();
    overlay.querySelectorAll('.scp-sp-tab').forEach(t => t.classList.toggle('active', t.dataset.sptab === 'global'));
    overlay.querySelectorAll('.scp-sp-tab-pane').forEach(p => { p.style.display = p.id === 'scp-sp-pane-global' ? '' : 'none'; });
}

export function closeSettingsPanel() {
    const overlay = document.getElementById('scp-settings-overlay');
    if (overlay) overlay.style.display = 'none';
}

export function syncSPFromSettings() {
    const s = getSettings();
    const ov = getSessionOverrides();
    const eff = getEffectiveSettings();

    updateDepthSlidersMax();

    const g = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    const gC = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

    // Global tab
    gC('scp-sp-search-hotkey-enabled', s.searchHotkeyEnabled);
    g('scp-sp-search-hotkey', s.searchHotkey);
    gC('scp-sp-enabled', s.enabled);
    gC('scp-sp-perf-mode', s.performanceMode);
    gC('scp-sp-hotkey-enabled', s.hotkeyEnabled);
    g('scp-sp-hotkey', s.hotkey);
    gC('scp-sp-icon-persistent', s.floatingIconPersistent);
    gC('scp-sp-wobble-window', s.wobbleWindow !== false);
    gC('scp-sp-changelog-auto', s.changelogAutoShow);

    const spOpSlider = document.getElementById('scp-sp-opacity-slider');
    const spOpVal = document.getElementById('scp-sp-opacity-val');
    if (spOpSlider) spOpSlider.value = s.opacity ?? 95;
    if (spOpVal) spOpVal.textContent = `${s.opacity ?? 95}%`;

    const spGhOp = document.getElementById('scp-sp-ghost-opacity');
    const spGhOpVal = document.getElementById('scp-sp-ghost-opacity-val');
    if (spGhOp) spGhOp.value = s.ghostModeOpacity ?? 15;
    if (spGhOpVal) spGhOpVal.textContent = `${s.ghostModeOpacity ?? 15}%`;
    gC('scp-sp-ghost-hotkey-enabled', s.ghostModeHotkeyEnabled);
    g('scp-sp-ghost-hotkey', s.ghostModeHotkey);
    
    // Force Streaming global
    gC('scp-sp-force-streaming', s.forceStreaming);
    const streamVal = s.forceStreaming === true ? 'on' : (s.forceStreaming === false ? 'auto' : (s.forceStreaming || 'auto'));
    document.querySelectorAll('.scp-stream-btn:not(.scp-ov-stream-btn)').forEach(b => {
        const active = b.dataset.stream === streamVal;
        b.classList.toggle('active', active);
        b.style.color = '';
        b.style.borderColor = '';
        b.style.background = '';
    });
    
    g('scp-sp-conn-source', s.connectionSource ?? 'default');
    const gCp = document.getElementById('scp-sp-global-profile-group');
    if (gCp) gCp.style.display = s.connectionSource === 'profile' ? '' : 'none';
    g('scp-sp-max-tokens', s.maxTokens);
    g('scp-sp-history-limit', s.localHistoryLimit);
    
    const spDs = document.getElementById('scp-sp-depth-slider');
    const spDv = document.getElementById('scp-sp-depth-val');
    if (spDs) spDs.value = s.contextDepth ?? 15;
    if (spDv) spDv.textContent = s.contextDepth ?? 15;
    
    gC('scp-sp-include-sysprompt', s.includeSystemPrompt);
    gC('scp-sp-include-persona', s.includeUserPersonality);
    gC('scp-sp-apply-regex', s.applyRegexToContext);
    gC('scp-sp-inline-summary-originals', s.includeInlineSummaryOriginals);
    g('scp-sp-reasoning-trim', s.reasoningTrimStrings);
    g('scp-sp-sysprompt', s.systemPrompt || DEFAULT_SYSTEM_PROMPT);
    g('scp-sp-lb-manage-prompt', s.lorebookManagePrompt || DEFAULT_LB_MANAGE_PROMPT);
    g('scp-sp-lb-st-scan-depth', s.lorebookSTScanDepth);
    g('scp-sp-lb-copilot-scan-depth', s.lorebookCopilotScanDepth);
    gC('scp-sp-lb-ai-enabled', s.lorebookAIManageEnabled);
    gC('scp-sp-lb-auto-kw', s.lorebookAutoKeyword);

    gC('scp-sp-char-edit-enabled', s.charEditAIEnabled);
    g('scp-sp-char-edit-prompt', s.charEditPrompt || DEFAULT_CHAR_EDIT_DIRECTIVE.trim());
    const ceFields = s.charEditFields || {};
    gC('scp-sp-ce-tags', ceFields.tags !== false);
    gC('scp-sp-ce-description', ceFields.description !== false);
    gC('scp-sp-ce-personality', ceFields.personality !== false);
    gC('scp-sp-ce-scenario', ceFields.scenario !== false);
    gC('scp-sp-ce-first-mes', ceFields.first_mes !== false);
    gC('scp-sp-ce-mes-example', ceFields.mes_example !== false);
    gC('scp-sp-ce-authors-note', ceFields.authors_note !== false);
    gC('scp-sp-ce-alt-greetings', !!ceFields.alternate_greetings);

    gC('scp-sp-chat-edit-enabled', s.chatEditAIEnabled);
    g('scp-sp-chat-edit-prompt', s.chatEditPrompt || DEFAULT_CHAT_EDIT_DIRECTIVE.trim());

    refreshSPProfilesDropdown();
    updateSPConnProfileList();

    // ── Session tab ──
    const ovDs = document.getElementById('scp-sp-ov-depth-slider');
    const ovDv = document.getElementById('scp-sp-ov-depth-val');
    if (ovDs) ovDs.value = eff.contextDepth ?? 15;
    if (ovDv) ovDv.textContent = eff.contextDepth ?? 15;

    g('scp-sp-ov-conn-source', eff.connectionSource ?? 'default');
    const ovPg = document.getElementById('scp-sp-ov-profile-group');
    if (ovPg) ovPg.style.display = eff.connectionSource === 'profile' ? '' : 'none';
    
    g('scp-sp-ov-conn-profile', eff.connectionProfileId ?? '');

    const ovi = (id, key) => { const el = document.getElementById(id); if (el) el.value = key in ov ? (ov[key] ?? '') : ''; };
    ovi('scp-sp-ov-max-tokens', 'maxTokens');
    ovi('scp-sp-ov-history-limit', 'localHistoryLimit');
    ovi('scp-sp-ov-reasoning-trim', 'reasoningTrimStrings');
    ovi('scp-sp-ov-sysprompt', 'systemPrompt');
    
    // AI Prompts overrides
    ovi('scp-sp-ov-char-edit-prompt', 'charEditPrompt');
    ovi('scp-sp-ov-lb-manage-prompt', 'lorebookManagePrompt');
    ovi('scp-sp-ov-chat-edit-prompt', 'chatEditPrompt');

    gC('scp-sp-ov-include-sysprompt', eff.includeSystemPrompt);
    gC('scp-sp-ov-include-persona', eff.includeUserPersonality);
    gC('scp-sp-ov-apply-regex', eff.applyRegexToContext);
    gC('scp-sp-ov-inline-summary-originals', eff.includeInlineSummaryOriginals);

    // Sync streaming override buttons
    const ovStreamVal = eff.forceStreaming === true ? 'on' : (eff.forceStreaming === false ? 'auto' : (eff.forceStreaming || 'auto'));
    document.querySelectorAll('.scp-ov-stream-btn').forEach(b => {
        const active = b.dataset.stream === ovStreamVal;
        b.classList.toggle('active', active);
        b.style.color = active ? 'var(--scp-accent)' : '';
        b.style.borderColor = active ? 'var(--scp-accent-dim)' : '';
        b.style.background = active ? 'var(--scp-accent-bg)' : '';
    });

    const ovCe = (id, k) => {
        const el = document.getElementById(id);
        if (el) el.checked = k in ov ? !!ov[k] : !!(s.charEditFields || {})[k.replace('charField_', '')];
    };
    ovCe('scp-sp-ov-ce-tags', 'charField_tags');
    ovCe('scp-sp-ov-ce-description', 'charField_description');
    ovCe('scp-sp-ov-ce-personality', 'charField_personality');
    ovCe('scp-sp-ov-ce-scenario', 'charField_scenario');
    ovCe('scp-sp-ov-ce-first-mes', 'charField_first_mes');
    ovCe('scp-sp-ov-ce-mes-example', 'charField_mes_example');
    ovCe('scp-sp-ov-ce-authors-note', 'charField_authors_note');
    ovCe('scp-sp-ov-ce-alt-greetings', 'charField_alternate_greetings');

    // Main ai modules overrides toggles
    const ovC = (id, key) => {
        const el = document.getElementById(id);
        if (el) el.checked = key in ov ? !!ov[key] : !!eff[key];
    };
    ovC('scp-sp-ov-char-edit-enabled', 'charEditAIEnabled');
    ovC('scp-sp-ov-lb-ai-enabled', 'lorebookAIManageEnabled');
    ovC('scp-sp-ov-chat-edit-enabled', 'chatEditAIEnabled');
    ovC('scp-sp-ov-lb-auto-kw', 'lorebookAutoKeyword');

    const altGreetingsOvEl = document.getElementById('scp-sp-ov-ce-alt-greetings');
    if (altGreetingsOvEl) {
        const picker = document.getElementById('scp-sp-ov-ce-alt-greetings-picker');
        if (picker) {
            picker.style.display = altGreetingsOvEl.checked ? '' : 'none';
            refreshAltGreetingsPickers();
        }
    }

    updateSPOverrideIndicators();

    const spSoundUnf = document.getElementById('scp-sp-sound-unfocused');
    if (spSoundUnf) spSoundUnf.checked = !!s.completionSoundOnlyWhenUnfocused;
    
    buildBackgroundSettingsUI(document.getElementById('scp-sp-bg-settings'));
    
    const spPl = document.getElementById('scp-sp-picker-lines');
    if (spPl) spPl.value = s.pickerPreviewLines ?? 1;
    const spPll = document.getElementById('scp-sp-picker-last-lines');
    if (spPll) spPll.value = s.pickerPreviewLastLines ?? 0;
    const spIm = document.getElementById('scp-sp-image-mode');
    if (spIm) spIm.value = s.imageAnalysisMode || 'direct';
}

export async function updateSPConnProfileList() {
    const selIds = ['scp-sp-conn-profile', 'scp-sp-ov-conn-profile'];
    const s = getSettings();
    const eff = getEffectiveSettings();
    const ctx = SillyTavern.getContext();
    let profiles = [];

    if (ctx.ConnectionManagerRequestService && typeof ctx.ConnectionManagerRequestService.getSupportedProfiles === 'function') {
        profiles = ctx.ConnectionManagerRequestService.getSupportedProfiles();
    } else {
        profiles = ctx.extensionSettings?.connectionManager?.profiles || [];
    }

    selIds.forEach(sid => {
        const sel = document.getElementById(sid); if (!sel) return;
        const isOverride = sid === 'scp-sp-ov-conn-profile';
        const targetVal = isOverride ? (eff.connectionProfileId || '') : (s.connectionProfileId || '');
        sel.innerHTML = '<option value="">-- Select Profile --</option>';
        profiles.forEach(p => { 
            const o = document.createElement('option'); 
            o.value = p.id; 
            o.textContent = p.name; 
            sel.appendChild(o); 
        });
        if (Array.from(sel.options).some(o => o.value === targetVal)) sel.value = targetVal;
    });
}

export function refreshSPProfilesDropdown() {
    const sel = document.getElementById('scp-sp-profile-select'); if (!sel) return;
    const s = getSettings();
    if (!Object.keys(s.profiles).length) {
        s.profiles['Default'] = { systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true, includeAuthorsNote: true, includeCharacterCard: true, includeUserPersonality: true, contextDepth: 15, localHistoryLimit: 50, connectionSource: 'default', connectionProfileId: '', maxTokens: 8200, applyRegexToContext: true, includeInlineSummaryOriginals: false };
        s.activeProfile = 'Default'; saveSettings();
    }
    sel.innerHTML = '';
    for (const name of Object.keys(s.profiles)) {
        const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
        if (name === s.activeProfile) opt.selected = true;
        sel.appendChild(opt);
    }
    updateSPBindingSection();
}

export function updateSPBindingSection() {
    const sel = document.getElementById('scp-sp-profile-select');
    const section = document.getElementById('scp-sp-binding-section');
    if (!section) return;
    section.style.display = sel?.value ? '' : 'none';
    if (!sel?.value) return;
    const s = getSettings(); const { charId, chatId } = getBindingKey();
    document.getElementById('scp-sp-bind-char')?.classList.toggle('active', s.profileBindings[`char_${charId}`] === sel.value);
    document.getElementById('scp-sp-bind-chat')?.classList.toggle('active', s.profileBindings[`chat_${charId}_${chatId}`] === sel.value);
}

export function openExtensionSettings() { openSettingsPanel(); }

// ─── Settings Panel Listeners ────────────────────────────────────────────────

export function setupSettingsPanelListeners() {
    const overlay = document.getElementById('scp-settings-overlay');
    if (!overlay) return;

    document.getElementById('scp-sp-close')?.addEventListener('click', closeSettingsPanel);
    let _spMouseDown = null;
    overlay.addEventListener('mousedown', e => { _spMouseDown = e.target; });
    overlay.addEventListener('click', e => { if (e.target === overlay && _spMouseDown === overlay) closeSettingsPanel(); });

    overlay.querySelectorAll('.scp-sp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            overlay.querySelectorAll('.scp-sp-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const pane = tab.dataset.sptab;
            overlay.querySelectorAll('.scp-sp-tab-pane').forEach(p => {
                p.style.display = p.id === `scp-sp-pane-${pane}` ? '' : 'none';
            });
            if (pane === 'stats') {
                const statsContainer = document.getElementById('scp-sp-stats-container');
                if (statsContainer) renderStatsPane(statsContainer);
            }
        });
    });

    // ── GLOBAL SETTINGS ──

    const saveGlobal = (key, val, cb) => {
        getSettings()[key] = val; saveSettings();
        _markDirty('config');
        const stEl = document.getElementById({
            enabled:'scp-enabled', hotkeyEnabled:'scp-hotkey-enabled', hotkey:'scp-hotkey',
            searchHotkeyEnabled:'scp-search-hotkey-enabled', searchHotkey:'scp-search-hotkey',
            floatingIconPersistent:'scp-icon-persistent', connectionSource:'scp-conn-source',
            maxTokens:'scp-max-tokens', localHistoryLimit:'scp-history-limit',
            contextDepth:'scp-depth-slider', includeSystemPrompt:'scp-include-sysprompt',
            includeAuthorsNote:'scp-include-anote', includeCharacterCard:'scp-include-charcard',
            includeUserPersonality:'scp-include-persona', reasoningTrimStrings:'scp-reasoning-trim',
            systemPrompt:'scp-sysprompt', lorebookManagePrompt:'scp-lb-manage-prompt',
            lorebookSTScanDepth:'scp-lb-st-scan-depth', lorebookCopilotScanDepth:'scp-lb-copilot-scan-depth',
            connectionProfileId:'scp-conn-profile',
            opacity:'scp-opacity-slider', ghostModeOpacity:'scp-ghost-opacity',
            ghostModeHotkeyEnabled:'scp-ghost-hotkey-enabled', ghostModeHotkey:'scp-ghost-hotkey',
            applyRegexToContext:'scp-apply-regex',
            includeInlineSummaryOriginals:'scp-inline-summary-originals',
            charEditAIEnabled: 'scp-char-edit-enabled',
            charEditPrompt: 'scp-char-edit-prompt',
            lorebookAIManageEnabled: 'scp-lb-ai-enabled-st',
            lorebookAutoKeyword: 'scp-lb-auto-kw-st',
            wobbleWindow: 'scp-wobble-window', performanceMode: 'scp-perf-mode',
        }[key]);
        if (stEl) {
            if (stEl.type === 'checkbox') stEl.checked = !!val;
            else if (key === 'charEditPrompt') stEl.value = val || DEFAULT_CHAR_EDIT_DIRECTIVE.trim();
            else stEl.value = val ?? '';
            
            if (key === 'connectionSource') {
                const stGroup = document.getElementById('scp-profile-group');
                if (stGroup) stGroup.style.display = val === 'profile' ? '' : 'none';
            }
        }

        syncOverlayUI(key, val);
        _pruneMatchingOverrides();

        if (cb) cb(val);
    };

    const bGCheck = (spId, key, cb) => {
        const el = document.getElementById(spId); if (!el) return;
        el.addEventListener('change', () => saveGlobal(key, el.checked, cb));
    };
    const bGInput = (spId, key, toVal, cb) => {
        const el = document.getElementById(spId); if (!el) return;
        el.addEventListener('input', () => saveGlobal(key, toVal ? toVal(el.value) : el.value, cb));
    };
    const bGSelect = (spId, key, cb) => {
        const el = document.getElementById(spId); if (!el) return;
        el.addEventListener('change', () => saveGlobal(key, el.value, cb));
    };

    bGCheck('scp-sp-enabled', 'enabled', () => {
        const ss = getSettings();
        const btn = document.getElementById('scp-wand-btn');
        if (btn) btn.style.display = ss.enabled ? '' : 'none';
        if (!ss.enabled) hideWindow();
        updateIconVisibility();
        setupHotkey();
    });
    
    bGCheck('scp-sp-perf-mode', 'performanceMode', () => {
        applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    });
    
    bGCheck('scp-sp-hotkey-enabled', 'hotkeyEnabled', setupHotkey);
    bGInput('scp-sp-hotkey', 'hotkey', null, setupHotkey);

    bGCheck('scp-sp-search-hotkey-enabled', 'searchHotkeyEnabled', setupSearchHotkey);
    bGInput('scp-sp-search-hotkey', 'searchHotkey', null, setupSearchHotkey);
    
    bGCheck('scp-sp-icon-persistent', 'floatingIconPersistent', updateIconVisibility);
    bGCheck('scp-sp-wobble-window', 'wobbleWindow');
    bGCheck('scp-sp-changelog-auto', 'changelogAutoShow');
    document.getElementById('scp-sp-open-changelog')?.addEventListener('click', () => { closeSettingsPanel(); _openChangelog(); });

    // Window opacity
    const spOpSlider = document.getElementById('scp-sp-opacity-slider');
    const spOpVal = document.getElementById('scp-sp-opacity-val');
    if (spOpSlider) {
        spOpSlider.addEventListener('input', () => { if (spOpVal) spOpVal.textContent = `${spOpSlider.value}%`; });
        spOpSlider.addEventListener('change', () => {
            const v = parseInt(spOpSlider.value);
            saveGlobal('opacity', v, () => {
                if (!isGhostModeActive() && getWindowEl()) getWindowEl().style.opacity = (v / 100).toString();
            });
        });
    }

    // Ghost mode settings
    bGCheck('scp-sp-ghost-hotkey-enabled', 'ghostModeHotkeyEnabled', setupGhostHotkey);
    bGInput('scp-sp-ghost-hotkey', 'ghostModeHotkey', null, setupGhostHotkey);

    // Streaming 3-state buttons
    const updateStreamBtns = (val) => {
        document.querySelectorAll('.scp-stream-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.stream === val);
            b.style.color = b.dataset.stream === val ? 'var(--scp-accent)' : '';
            b.style.borderColor = b.dataset.stream === val ? 'var(--scp-accent-dim)' : '';
            b.style.background = b.dataset.stream === val ? 'var(--scp-accent-bg)' : '';
        });
    };
    document.querySelectorAll('.scp-stream-btn:not(.scp-ov-stream-btn)').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.stream;
            saveGlobal('forceStreaming', val, null);
        });
    });

    const spGhOp = document.getElementById('scp-sp-ghost-opacity');
    const spGhOpVal = document.getElementById('scp-sp-ghost-opacity-val');
    if (spGhOp) {
        spGhOp.addEventListener('input', () => { if (spGhOpVal) spGhOpVal.textContent = `${spGhOp.value}%`; });
        spGhOp.addEventListener('change', () => {
            const v = parseInt(spGhOp.value);
            saveGlobal('ghostModeOpacity', v, () => {
                if (isGhostModeActive() && getWindowEl()) getWindowEl().style.opacity = (v / 100).toString();
            });
        });
    }

    bGSelect('scp-sp-conn-source', 'connectionSource', v => {
        const gCp = document.getElementById('scp-sp-global-profile-group');
        if (gCp) gCp.style.display = v === 'profile' ? '' : 'none';
        if (v === 'profile') updateSPConnProfileList();
    });
    document.getElementById('scp-sp-conn-profile')?.addEventListener('mouseenter', updateSPConnProfileList);
    document.getElementById('scp-sp-conn-profile')?.addEventListener('change', e => saveGlobal('connectionProfileId', e.target.value));

    bGInput('scp-sp-max-tokens', 'maxTokens', Number);
    bGInput('scp-sp-history-limit', 'localHistoryLimit', Number, () => updateMsgCount(getCurrentSession()));

    const spDs = document.getElementById('scp-sp-depth-slider');
    const spDv = document.getElementById('scp-sp-depth-val');
    if (spDs) {
        spDs.addEventListener('input', () => { if (spDv) spDv.textContent = spDs.value; });
        spDs.addEventListener('change', () => {
            saveGlobal('contextDepth', parseInt(spDs.value), () => updateMsgCount(getCurrentSession()));
            const stSlider = document.getElementById('scp-depth-slider');
            const stVal = document.getElementById('scp-depth-val');
            if (stSlider) stSlider.value = spDs.value;
            if (stVal) stVal.textContent = spDs.value;
        });
    }

    bGCheck('scp-sp-include-sysprompt', 'includeSystemPrompt', () => updateMsgCount(getCurrentSession()));
    bGCheck('scp-sp-include-persona', 'includeUserPersonality', () => updateMsgCount(getCurrentSession()));
    bGCheck('scp-sp-apply-regex', 'applyRegexToContext');
    bGCheck('scp-sp-inline-summary-originals', 'includeInlineSummaryOriginals', () => updateMsgCount(getCurrentSession()));
    bGInput('scp-sp-reasoning-trim', 'reasoningTrimStrings');

    document.getElementById('scp-sp-conn-source')?.addEventListener('change', e => {
        const v = e.target.value;
        saveGlobal('connectionSource', v, null);
        const gCp = document.getElementById('scp-sp-global-profile-group');
        if (gCp) gCp.style.display = v === 'profile' ? '' : 'none';
        if (v === 'profile') updateSPConnProfileList();
    });
    document.getElementById('scp-sp-conn-profile')?.addEventListener('mouseenter', updateSPConnProfileList);
    document.getElementById('scp-sp-conn-profile')?.addEventListener('change', e => saveGlobal('connectionProfileId', e.target.value, null));

    const spPrompt = document.getElementById('scp-sp-sysprompt');
    if (spPrompt) spPrompt.addEventListener('input', () => saveGlobal('systemPrompt', spPrompt.value, () => updateMsgCount(getCurrentSession())));
    document.getElementById('scp-sp-reset-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset System Prompt', message: 'Reset to default?' });
        if (!ok) return;
        getSettings().systemPrompt = DEFAULT_SYSTEM_PROMPT;
        saveSettings();
        if (spPrompt) spPrompt.value = DEFAULT_SYSTEM_PROMPT;
        const stPrompt = document.getElementById('scp-sysprompt');
        if (stPrompt) stPrompt.value = DEFAULT_SYSTEM_PROMPT;
        updateMsgCount(getCurrentSession());
        toastr.success('System prompt reset.', EXT_DISPLAY);
    });

    bGInput('scp-sp-lb-manage-prompt', 'lorebookManagePrompt');
    document.getElementById('scp-sp-reset-lb-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset LB Prompt', message: 'Reset to default?' });
        if (!ok) return;
        getSettings().lorebookManagePrompt = DEFAULT_LB_MANAGE_PROMPT;
        saveSettings();
        const el = document.getElementById('scp-sp-lb-manage-prompt'); if (el) el.value = DEFAULT_LB_MANAGE_PROMPT;
        const stEl = document.getElementById('scp-lb-manage-prompt'); if (stEl) stEl.value = DEFAULT_LB_MANAGE_PROMPT;
        toastr.success('Lorebook prompt reset.', EXT_DISPLAY);
    });
    bGInput('scp-sp-lb-st-scan-depth', 'lorebookSTScanDepth', Number);
    bGInput('scp-sp-lb-copilot-scan-depth', 'lorebookCopilotScanDepth', Number);

    // LB and Auto-Keywords toggles (settings overlay)
    document.getElementById('scp-sp-lb-ai-enabled')?.addEventListener('change', e => {
        saveGlobal('lorebookAIManageEnabled', e.target.checked, null);
        const stEl = document.getElementById('scp-lb-ai-enabled-st');
        if (stEl) stEl.checked = e.target.checked;
    });
    document.getElementById('scp-sp-lb-auto-kw')?.addEventListener('change', async e => {
        saveGlobal('lorebookAutoKeyword', e.target.checked, null);
        const s2 = getSettings();
        await buildLorebookContextBlock(s2);
        updateLBFooterInfo();
        if (getLbActiveBook()) await renderEntryList(getLbActiveBook(), getLbSearchQuery());
        updateMsgCount(getCurrentSession());
        const stEl = document.getElementById('scp-lb-auto-kw-st');
        if (stEl) stEl.checked = e.target.checked;
    });

    // Character card AI edits
    const bGCharField = (id, fieldKey) => {
        const el = document.getElementById(id); if (!el) return;
        el.addEventListener('change', () => {
            const s = getSettings();
            if (!s.charEditFields) s.charEditFields = {};
            s.charEditFields[fieldKey] = el.checked;
            saveSettings(); updateMsgCount(getCurrentSession());
            const stIdMap = {
                description: 'scp-ce-description', personality: 'scp-ce-personality',
                scenario: 'scp-ce-scenario', first_mes: 'scp-ce-first-mes',
                mes_example: 'scp-ce-mes-example', authors_note: 'scp-ce-authors-note',
                alternate_greetings: 'scp-ce-alt-greetings',
            };
            const stEl = document.getElementById(stIdMap[fieldKey]);
            if (stEl) stEl.checked = el.checked;
            
            syncOverlayUI('charField_' + fieldKey, el.checked);
            _markDirty('config');
        });
    };
    bGCheck('scp-sp-char-edit-enabled', 'charEditAIEnabled', () => updateMsgCount(getCurrentSession()));
    bGCharField('scp-sp-ce-tags', 'tags');
    bGCharField('scp-sp-ce-description', 'description');
    bGCharField('scp-sp-ce-personality', 'personality');
    bGCharField('scp-sp-ce-scenario', 'scenario');
    bGCharField('scp-sp-ce-first-mes', 'first_mes');
    bGCharField('scp-sp-ce-mes-example', 'mes_example');
    bGCharField('scp-sp-ce-authors-note', 'authors_note');
    bGCharField('scp-sp-ce-alt-greetings', 'alternate_greetings');
    document.getElementById('scp-sp-ce-alt-greetings')?.addEventListener('change', () => {
        const picker = document.getElementById('scp-sp-ce-alt-greetings-picker');
        if (picker) { picker.style.display = getSettings().charEditFields?.alternate_greetings ? '' : 'none'; refreshAltGreetingsPickers(); }
    });
    document.getElementById('scp-sp-char-edit-prompt')?.addEventListener('input', e => {
        const val = e.target.value;
        getSettings().charEditPrompt = (val.trim() === DEFAULT_CHAR_EDIT_DIRECTIVE.trim()) ? '' : val;
        saveSettings();
        _markDirty('config');
    });
    document.getElementById('scp-sp-reset-char-edit-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Char Edit Prompt', message: 'Reset to built-in default prompt?' });
        if (!ok) return;
        getSettings().charEditPrompt = '';
        saveSettings();
        _markDirty('config');
        const el = document.getElementById('scp-sp-char-edit-prompt');
        if (el) el.value = DEFAULT_CHAR_EDIT_DIRECTIVE.trim();
        toastr.success('Char edit prompt reset to default.', EXT_DISPLAY);
    });
    bGCheck('scp-sp-chat-edit-enabled', 'chatEditAIEnabled', () => {
        updateMsgCount(getCurrentSession());
        const stEl = document.getElementById('scp-chat-edit-enabled-st');
        if (stEl) stEl.checked = getSettings().chatEditAIEnabled;
    });
    document.getElementById('scp-sp-chat-edit-prompt')?.addEventListener('input', e => {
        const val = e.target.value;
        getSettings().chatEditPrompt = (val.trim() === DEFAULT_CHAT_EDIT_DIRECTIVE.trim()) ? '' : val;
        saveSettings();
        _markDirty('config');
        const stEl = document.getElementById('scp-chat-edit-prompt-st');
        if (stEl) stEl.value = val;
    });
    document.getElementById('scp-sp-reset-chat-edit-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Chat Edit Prompt', message: 'Reset to default?' });
        if (!ok) return;
        getSettings().chatEditPrompt = ''; saveSettings(); _markDirty('config');
        const spEl = document.getElementById('scp-sp-chat-edit-prompt');
        if (spEl) spEl.value = DEFAULT_CHAT_EDIT_DIRECTIVE.trim();
        const stEl = document.getElementById('scp-chat-edit-prompt-st');
        if (stEl) stEl.value = DEFAULT_CHAT_EDIT_DIRECTIVE.trim();
        toastr.success('Chat edit prompt reset.', EXT_DISPLAY);
    });

    // Config profiles
    document.getElementById('scp-sp-profile-select')?.addEventListener('change', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        if (isConfigProfileDirty()) {
            const ok = await showCustomDialog({ type: 'confirm', title: 'Unsaved Configuration', message: 'Unsaved changes in current profile. Switch anyway?' });
            if (!ok) { sel.value = getSettings().activeProfile || ''; return; }
        }
        loadProfile(sel.value);
        syncSPFromSettings();
        updateSettingsUI();
        updateSPBindingSection();
    });
    document.getElementById('scp-sp-profile-save')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select');
        let name = sel?.value;
        if (!name) {
            name = await showCustomDialog({ type: 'prompt', title: 'Save Configuration', message: 'Profile name:', placeholder: 'My Config' });
            if (!name?.trim()) return;
            name = name.trim();
        }
        saveProfile(name); refreshSPProfilesDropdown(); refreshProfilesDropdown();
        if (sel) sel.value = name;
        updateSPBindingSection(); toastr.success(`Saved "${name}"`, EXT_DISPLAY);
        _clearDirty('config');
    });
    document.getElementById('scp-sp-profile-create')?.addEventListener('click', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'New Configuration', message: 'Name:', placeholder: 'New Config' });
        if (!name?.trim()) return;
        const n = name.trim(); const s = getSettings();
        s.profiles[n] = { systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true, includeAuthorsNote: true, includeCharacterCard: true, includeUserPersonality: true, contextDepth: 15, localHistoryLimit: 50, connectionSource: 'default', connectionProfileId: '', maxTokens: 8200, applyRegexToContext: true, includeInlineSummaryOriginals: false };
        saveSettings(); refreshSPProfilesDropdown(); refreshProfilesDropdown();
        loadProfile(n); syncSPFromSettings(); updateSettingsUI();
        const sel = document.getElementById('scp-sp-profile-select'); if (sel) sel.value = n;
        updateSPBindingSection(); toastr.success(`Created "${n}"`, EXT_DISPLAY);
    });
    document.getElementById('scp-sp-profile-duplicate')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select');
        if (!sel?.value) return toastr.info('No configuration selected.', EXT_DISPLAY);
        const defaultName = sel.value + ' (Copy)';
        const newName = await showCustomDialog({ type: 'prompt', title: 'Duplicate Configuration', message: 'Name for the new profile:', defaultValue: defaultName });
        if (!newName?.trim()) return;
        const n = newName.trim();
        const s2 = getSettings();
        const p = s2.profiles[sel.value];
        if (!p) return;
        s2.profiles[n] = JSON.parse(JSON.stringify(p));
        saveSettings(); refreshSPProfilesDropdown(); refreshProfilesDropdown();
        loadProfile(n); syncSPFromSettings(); updateSettingsUI();
        const newSel = document.getElementById('scp-sp-profile-select'); if (newSel) newSel.value = n;
        updateSPBindingSection(); toastr.success(`Duplicated as "${n}"`, EXT_DISPLAY);
    });
    document.getElementById('scp-sp-profile-rename')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const newName = await showCustomDialog({ type: 'prompt', title: 'Rename', message: 'New name:', defaultValue: sel.value });
        if (!newName?.trim() || newName.trim() === sel.value) return;
        const s = getSettings(); const p = s.profiles[sel.value]; if (!p) return;
        s.profiles[newName.trim()] = p; delete s.profiles[sel.value];
        if (s.activeProfile === sel.value) s.activeProfile = newName.trim();
        for (const k in s.profileBindings) { if (s.profileBindings[k] === sel.value) s.profileBindings[k] = newName.trim(); }
        saveSettings(); refreshSPProfilesDropdown(); refreshProfilesDropdown();
        const newSel = document.getElementById('scp-sp-profile-select'); if (newSel) newSel.value = newName.trim();
        updateSPBindingSection(); toastr.success('Renamed.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-profile-delete')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const s = getSettings();
        if (Object.keys(s.profiles).length <= 1) { toastr.warning('Cannot delete the last profile.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Profile', message: `Delete "${sel.value}"?` });
        if (!ok) return;
        deleteProfile(sel.value); refreshSPProfilesDropdown(); refreshProfilesDropdown();
        updateSPBindingSection(); toastr.success('Deleted.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-bind-char')?.addEventListener('click', () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); const { charId } = getBindingKey(); const key = `char_${charId}`;
        if (s.profileBindings[key] === sel.value) delete s.profileBindings[key];
        else s.profileBindings[key] = sel.value;
        saveSettings(); updateSPBindingSection(); updateBindingSection();
    });
    document.getElementById('scp-sp-bind-chat')?.addEventListener('click', () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); const { charId, chatId } = getBindingKey(); const key = `chat_${charId}_${chatId}`;
        if (s.profileBindings[key] === sel.value) delete s.profileBindings[key];
        else s.profileBindings[key] = sel.value;
        saveSettings(); updateSPBindingSection(); updateBindingSection();
    });

    document.getElementById('scp-sp-download-debug')?.addEventListener('click', dbgDownload);
    const handleClearAllSessions = async () => {
        const ok = await showCustomDialog({ 
            type: 'confirm', 
            title: 'Clear All Sessions', 
            message: 'Delete ALL Copilot sessions from global storage AND clear sessions for the CURRENT chat? (Cannot clear other inactive chats). This cannot be undone.',
            delayConfirm: 3
        });
        if (!ok) return;
        getSettings().sessions = {}; saveSettings(); 
        const ctx = SillyTavern.getContext();
        if (ctx.chatMetadata) delete ctx.chatMetadata.st_copilot;
        await initChatBucket();
        _onChatChanged();
        toastr.success('Sessions cleared.', EXT_DISPLAY);
    };
    document.getElementById('scp-sp-clear-sessions')?.addEventListener('click', handleClearAllSessions);

    // Sound unfocused (overlay)
    const spSoundUnfocusedEl = document.getElementById('scp-sp-sound-unfocused');
    if (spSoundUnfocusedEl) {
        spSoundUnfocusedEl.checked = !!getSettings().completionSoundOnlyWhenUnfocused;
        spSoundUnfocusedEl.addEventListener('change', () => {
            getSettings().completionSoundOnlyWhenUnfocused = spSoundUnfocusedEl.checked;
            saveSettings();
            const stEl = document.getElementById('scp-sound-unfocused');
            if (stEl) stEl.checked = spSoundUnfocusedEl.checked;
        });
    }

    // Background (overlay)
    const spBgType = document.getElementById('scp-sp-bg-type');
    const spBgUrl = document.getElementById('scp-sp-bg-url');
    const spBgUrlGrp = document.getElementById('scp-sp-bg-url-group');
    const spBgDim = document.getElementById('scp-sp-bg-dim');
    const spBgDimGrp = document.getElementById('scp-sp-bg-dim-group');
    const spBgDimVal = document.getElementById('scp-sp-bg-dim-val');
    if (spBgType) {
        spBgType.value = getSettings().windowBgType || 'none';
        spBgType.addEventListener('change', () => {
            getSettings().windowBgType = spBgType.value;
            saveSettings();
            if (spBgUrlGrp) spBgUrlGrp.style.display = spBgType.value !== 'none' ? '' : 'none';
            if (spBgDimGrp) spBgDimGrp.style.display = spBgType.value !== 'none' ? '' : 'none';
            applyWindowBackground();
            syncBgToOverlay();
        });
    }
    if (spBgUrl) {
        spBgUrl.value = getSettings().windowBgUrl || '';
        spBgUrl.addEventListener('input', () => {
            getSettings().windowBgUrl = spBgUrl.value;
            saveSettings();
            applyWindowBackground();
            syncBgToOverlay();
        });
    }
    if (spBgDim) {
        spBgDim.value = getSettings().windowBgDim ?? 50;
        if (spBgDimVal) spBgDimVal.textContent = `${spBgDim.value}%`;
        spBgDim.addEventListener('input', () => {
            if (spBgDimVal) spBgDimVal.textContent = `${spBgDim.value}%`;
        });
        spBgDim.addEventListener('change', () => {
            getSettings().windowBgDim = parseInt(spBgDim.value);
            saveSettings();
            applyWindowBackground();
            syncBgToOverlay();
        });
    }

    // Picker lines (overlay)
    const spPickerLines = document.getElementById('scp-sp-picker-lines');
    if (spPickerLines) {
        spPickerLines.value = getSettings().pickerPreviewLines ?? 1;
        spPickerLines.addEventListener('input', () => {
            getSettings().pickerPreviewLines = parseInt(spPickerLines.value) || 1;
            saveSettings();
            const stEl = document.getElementById('scp-picker-lines');
            if (stEl) stEl.value = spPickerLines.value;
        });
    }
    const spPickerLast = document.getElementById('scp-sp-picker-last-lines');
    if (spPickerLast) {
        spPickerLast.value = getSettings().pickerPreviewLastLines ?? 0;
        spPickerLast.addEventListener('input', () => {
            getSettings().pickerPreviewLastLines = parseInt(spPickerLast.value) || 0;
            saveSettings();
            const stEl = document.getElementById('scp-picker-last-lines');
            if (stEl) stEl.value = spPickerLast.value;
        });
    }

    // Image mode (overlay)
    const spImgMode = document.getElementById('scp-sp-image-mode');
    if (spImgMode) {
        spImgMode.value = getSettings().imageAnalysisMode || 'direct';
        spImgMode.addEventListener('change', () => {
            getSettings().imageAnalysisMode = spImgMode.value;
            saveSettings();
            const stEl = document.getElementById('scp-image-mode');
            if (stEl) stEl.value = spImgMode.value;
        });
    }

    // ── SESSION OVERRIDES ──

    function syncOvClear(key, newVal) {
        let globalVal = getSettings()[key];
        if (key.startsWith('charField_')) {
            const fKey = key.replace('charField_', '');
            globalVal = (getSettings().charEditFields || {})[fKey] !== false;
        }

        const isDefault = (newVal === undefined || newVal === null || newVal === '')
            ? true
            : (typeof globalVal === 'boolean'
                ? newVal === globalVal
                : String(newVal) === String(globalVal));
        
        if (isDefault) setSessionOverride(key, undefined);
        else setSessionOverride(key, newVal);
        
        updateSPOverrideIndicators();
        updateMsgCount(getCurrentSession());
    }

    function _pruneMatchingOverrides() {
        const s = getSettings();
        const bucket = getChatBucket();
        let changed = false;
        bucket.sessions.forEach(sess => {
            if (!sess.overrides) return;
            for (const key of Object.keys(sess.overrides)) {
                let globalVal = s[key];
                if (key.startsWith('charField_')) {
                    const fKey = key.replace('charField_', '');
                    globalVal = (s.charEditFields || {})[fKey] !== false;
                }
                if (sess.overrides[key] === globalVal) {
                    delete sess.overrides[key];
                    changed = true;
                }
            }
        });
        if (changed) {
            saveSessionsToMetadata();
            updateSessionOverrideIndicator();
        }
    }

    const bindOvCheck = (spId, key) => {
        const el = document.getElementById(spId); if (!el) return;
        el.addEventListener('change', () => syncOvClear(key, el.checked));
    };
    const bindOvInput = (spId, key, toVal) => {
        const el = document.getElementById(spId); if (!el) return;
        el.addEventListener('input', () => {
            const raw = el.value === '' ? undefined : (toVal ? toVal(el.value) : el.value);
            syncOvClear(key, raw);
        });
    };

    const ovDs = document.getElementById('scp-sp-ov-depth-slider');
    const ovDv = document.getElementById('scp-sp-ov-depth-val');
    if (ovDs) {
        ovDs.addEventListener('input', () => { if (ovDv) ovDv.textContent = ovDs.value; });
        ovDs.addEventListener('change', () => syncOvClear('contextDepth', parseInt(ovDs.value)));
    }

    document.getElementById('scp-sp-ov-conn-source')?.addEventListener('change', e => {
        syncOvClear('connectionSource', e.target.value);
        const pg = document.getElementById('scp-sp-ov-profile-group');
        if (pg) pg.style.display = e.target.value === 'profile' ? '' : 'none';
        if (e.target.value === 'profile') updateSPConnProfileList();
    });
    document.getElementById('scp-sp-ov-conn-profile')?.addEventListener('mouseenter', updateSPConnProfileList);
    document.getElementById('scp-sp-ov-conn-profile')?.addEventListener('change', e => {
        syncOvClear('connectionProfileId', e.target.value);
    });

    bindOvInput('scp-sp-ov-max-tokens', 'maxTokens', Number);
    bindOvInput('scp-sp-ov-history-limit', 'localHistoryLimit', Number);
    bindOvInput('scp-sp-ov-reasoning-trim', 'reasoningTrimStrings');
    bindOvInput('scp-sp-ov-char-edit-prompt', 'charEditPrompt');
    bindOvInput('scp-sp-ov-lb-manage-prompt', 'lorebookManagePrompt');
    bindOvInput('scp-sp-ov-chat-edit-prompt', 'chatEditPrompt');

    const ovPrompt = document.getElementById('scp-sp-ov-sysprompt');
    if (ovPrompt) ovPrompt.addEventListener('input', () => syncOvClear('systemPrompt', ovPrompt.value || undefined));

    bindOvCheck('scp-sp-ov-include-sysprompt', 'includeSystemPrompt');
    bindOvCheck('scp-sp-ov-include-persona', 'includeUserPersonality');
    bindOvCheck('scp-sp-ov-apply-regex', 'applyRegexToContext');
    bindOvCheck('scp-sp-ov-inline-summary-originals', 'includeInlineSummaryOriginals');
    bindOvCheck('scp-sp-ov-char-edit-enabled', 'charEditAIEnabled');
    bindOvCheck('scp-sp-ov-lb-ai-enabled', 'lorebookAIManageEnabled');
    bindOvCheck('scp-sp-ov-chat-edit-enabled', 'chatEditAIEnabled');
    bindOvCheck('scp-sp-ov-ce-alt-greetings', 'charField_alternate_greetings');
    bindOvCheck('scp-sp-ov-lb-auto-kw', 'lorebookAutoKeyword');
    document.getElementById('scp-sp-ov-ce-alt-greetings')?.addEventListener('change', (e) => {
        const picker = document.getElementById('scp-sp-ov-ce-alt-greetings-picker');
        if (picker) { picker.style.display = e.target.checked ? '' : 'none'; refreshAltGreetingsPickers(); }
    });

    document.querySelectorAll('.scp-ov-stream-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.stream;
            syncOvClear('forceStreaming', val);
            document.querySelectorAll('.scp-ov-stream-btn').forEach(b => {
                const active = b.dataset.stream === val;
                b.classList.toggle('active', active);
                b.style.color = active ? 'var(--scp-accent)' : '';
                b.style.borderColor = active ? 'var(--scp-accent-dim)' : '';
                b.style.background = active ? 'var(--scp-accent-bg)' : '';
            });
        });
    });
    
    bindOvCheck('scp-sp-ov-ce-tags', 'charField_tags');
    bindOvCheck('scp-sp-ov-ce-description', 'charField_description');
    bindOvCheck('scp-sp-ov-ce-personality', 'charField_personality');
    bindOvCheck('scp-sp-ov-ce-scenario', 'charField_scenario');
    bindOvCheck('scp-sp-ov-ce-first-mes', 'charField_first_mes');
    bindOvCheck('scp-sp-ov-ce-mes-example', 'charField_mes_example');
    bindOvCheck('scp-sp-ov-ce-authors-note', 'charField_authors_note');
    bindOvCheck('scp-sp-ov-ce-alt-greetings', 'charField_alternate_greetings');

    overlay.querySelectorAll('.scp-sp-ov-clear[data-ovkey]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.ovkey;
            setSessionOverride(key, undefined);
            const eff = getEffectiveSettings();
            const ov = getSessionOverrides();
            const elMap = {
                contextDepth: ['scp-sp-ov-depth-slider', 'scp-sp-ov-depth-val'],
                maxTokens: ['scp-sp-ov-max-tokens'],
                localHistoryLimit: ['scp-sp-ov-history-limit'],
                reasoningTrimStrings: ['scp-sp-ov-reasoning-trim'],
                systemPrompt: ['scp-sp-ov-sysprompt'],
                connectionSource: ['scp-sp-ov-conn-source'],
                connectionProfileId: ['scp-sp-ov-conn-profile'],
                includeSystemPrompt: ['scp-sp-ov-include-sysprompt'],
                includeUserPersonality: ['scp-sp-ov-include-persona'],
                applyRegexToContext: ['scp-sp-ov-apply-regex'],
                includeInlineSummaryOriginals: ['scp-sp-ov-inline-summary-originals'],
                charField_tags: ['scp-sp-ov-ce-tags'],
                charField_description: ['scp-sp-ov-ce-description'],
                charField_personality: ['scp-sp-ov-ce-personality'],
                charField_scenario: ['scp-sp-ov-ce-scenario'],
                charField_first_mes: ['scp-sp-ov-ce-first-mes'],
                charField_mes_example: ['scp-sp-ov-ce-mes-example'],
                charField_authors_note: ['scp-sp-ov-ce-authors-note'],
                charField_alternate_greetings: ['scp-sp-ov-ce-alt-greetings'],
                charEditAIEnabled: ['scp-sp-ov-char-edit-enabled'],
                charEditPrompt: ['scp-sp-ov-char-edit-prompt'],
                lorebookAIManageEnabled: ['scp-sp-ov-lb-ai-enabled'],
                lorebookManagePrompt: ['scp-sp-ov-lb-manage-prompt'],
                lorebookAutoKeyword: ['scp-sp-ov-lb-auto-kw'],
                chatEditAIEnabled: ['scp-sp-ov-chat-edit-enabled'],
                chatEditPrompt: ['scp-sp-ov-chat-edit-prompt'],
            };
            (elMap[key] || []).forEach(id => {
                const el = document.getElementById(id); if (!el) return;
                if (id.includes('depth-val')) { el.textContent = eff.contextDepth ?? 15; return; }
                
                if (el.type === 'checkbox') {
                    if (key.startsWith('charField_')) {
                        const fKey = key.replace('charField_', '');
                        el.checked = (getSettings().charEditFields || {})[fKey] !== false;
                    } else {
                        el.checked = !!eff[key];
                    }
                }
                else if (el.type === 'range') el.value = eff[key] ?? 15;
                else if (id === 'scp-sp-ov-conn-source') {
                    el.value = eff.connectionSource ?? 'default';
                    const pg = document.getElementById('scp-sp-ov-profile-group');
                    if (pg) pg.style.display = el.value === 'profile' ? '' : 'none';
                }
                else if (id === 'scp-sp-ov-conn-profile') {
                    el.value = eff.connectionProfileId ?? '';
                }
                else el.value = (key in ov ? ov[key] : '') ?? '';
            });
            if (key === 'forceStreaming') {
                const streamVal = eff.forceStreaming === true ? 'on' : (eff.forceStreaming === false ? 'auto' : (eff.forceStreaming || 'auto'));
                document.querySelectorAll('.scp-ov-stream-btn').forEach(b => {
                    const active = b.dataset.stream === streamVal;
                    b.classList.toggle('active', active);
                    b.style.color = active ? 'var(--scp-accent)' : '';
                    b.style.borderColor = active ? 'var(--scp-accent-dim)' : '';
                    b.style.background = active ? 'var(--scp-accent-bg)' : '';
                });
            }
            updateSPOverrideIndicators();
            updateMsgCount(getCurrentSession());
        });
    });

    document.getElementById('scp-sp-reset-all-overrides')?.addEventListener('click', async () => {
        if (!hasSessionOverrides()) { toastr.info('No session overrides active.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Session Overrides', message: 'Clear all session overrides for this session?' });
        if (!ok) return;
        clearAllSessionOverrides();
        syncSPFromSettings();
        updateMsgCount(getCurrentSession());
        toastr.success('Session overrides cleared.', EXT_DISPLAY);
    });

    _setupBgUpload('scp-sp-bg-upload-btn', 'scp-sp-bg-url');
}

