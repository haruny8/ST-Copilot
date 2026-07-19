/**
 * util-debug.js
 * In-memory session debug logger: records events, snapshots settings to
 * detect drift, patches console.error/toastr to auto-capture errors, and
 * lets the user download the whole log as a .txt for bug reports.
 *
 * Moved from original index.js "Debug Logger" section (lines 11–148) plus
 * `dbgDownload` (lines ~296–336 of the old file).
 */

import { EXT_DISPLAY } from '../constants.js';
import { getExtVersion } from '../state.js';
import { getSettings } from '../settings.js';

const _DBG = { log: [], MAX: 3000, sessionStart: new Date().toISOString(), _snapshot: null, _diffTid: null };
const _DBG_SKIP = new Set(['customTheme', 'savedThemes', 'sessions', 'starredMessages', 'stats', 'quickPromptSets', 'customSounds', 'completionSoundData', 'quickPrompts', 'profiles', 'promptPresets', 'altGreetingIndices', 'windowBgUrl', 'customBackgrounds']);

function _dbgStrip(s) {
    const r = {};
    for (const [k, v] of Object.entries(s)) { if (!_DBG_SKIP.has(k)) r[k] = v; }
    return r;
}

export function dbgAdd(type, payload) {
    _DBG.log.push({ ts: Date.now(), type, payload });
    if (_DBG.log.length > _DBG.MAX) _DBG.log.splice(0, _DBG.log.length - _DBG.MAX);
}

export function dbgSnapshotSettings() {
    try {
        const s = _dbgStrip(getSettings());
        _DBG._snapshot = JSON.parse(JSON.stringify(s));
        dbgAdd('SETTINGS_SNAPSHOT', s);
    } catch (_) {}
}

export function dbgDiffSettings() {
    if (!_DBG._snapshot) return;
    try {
        const cur = _dbgStrip(getSettings());
        const diff = {};
        const keys = new Set([...Object.keys(cur), ...Object.keys(_DBG._snapshot)]);
        for (const k of keys) {
            if (JSON.stringify(cur[k]) !== JSON.stringify(_DBG._snapshot[k])) {
                diff[k] = { prev: _DBG._snapshot[k], now: cur[k] };
            }
        }
        if (Object.keys(diff).length) {
            dbgAdd('SETTINGS_CHANGED', diff);
            _DBG._snapshot = JSON.parse(JSON.stringify(cur));
        }
    } catch (_) {}
}

export function dbgSetupGlobalErrorHandlers() {
    const origErr = console.error;
    console.error = function (...a) {
        origErr.apply(console, a);
        try {
            dbgAdd('CONSOLE_ERROR', a.map(x =>
                x instanceof Error ? (x.stack || x.message) :
                (typeof x === 'object' ? JSON.stringify(x) : String(x))
            ).join(' '));
        } catch (_) {}
    };
    window.addEventListener('error', e => {
        dbgAdd('WINDOW_ERROR', { msg: e.message, src: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
    });
    window.addEventListener('unhandledrejection', e => {
        dbgAdd('UNHANDLED_REJECTION', { msg: String(e.reason), stack: e.reason?.stack });
    });

    if (typeof toastr !== 'undefined') {
        const origToastrError = toastr.error;
        toastr.error = function (message, title, options) {
            try {
                dbgAdd('UI_ERROR_POPUP', { title: title || 'Error', message: String(message) });
            } catch (_) {}
            return origToastrError.apply(toastr, [message, title, options]);
        };

        const origToastrWarning = toastr.warning;
        toastr.warning = function (message, title, options) {
            try {
                dbgAdd('UI_WARNING_POPUP', { title: title || 'Warning', message: String(message) });
            } catch (_) {}
            return origToastrWarning.apply(toastr, [message, title, options]);
        };
    }
}

export function dbgDownload() {
    const ctx = SillyTavern.getContext();

    let activeId = null;
    const nativeSel = document.getElementById('connection_profile');
    if (nativeSel && typeof nativeSel.value === 'string') {
        activeId = nativeSel.value;
    }

    let profiles = [];
    if (ctx.ConnectionManagerRequestService && typeof ctx.ConnectionManagerRequestService.getSupportedProfiles === 'function') {
        profiles = ctx.ConnectionManagerRequestService.getSupportedProfiles();
    } else {
        profiles = ctx.extensionSettings?.connectionManager?.profiles || [];
    }

    let activeProfileName = 'default';
    if (activeId && activeId !== 'default' && activeId !== 'gui') {
        const found = profiles.find(p => p.id === activeId);
        activeProfileName = found ? found.name : activeId;
    }

    const stEnv = {
        mainApi: ctx.api_server || document.getElementById('main_api')?.value || 'unknown',
        characterId: ctx.characterId,
        chatId: ctx.chatId,
        activeConnectionProfile: activeProfileName,
        connectionProfiles: profiles.map(p => ({
            id: p.id,
            name: p.name,
            type: p.type || p.api || 'unknown',
        })),
    };

    const lines = [
        '=== ST-Copilot Debug Log ===',
        `Version: ${getExtVersion()} | Session Start: ${_DBG.sessionStart} | Downloaded: ${new Date().toISOString()}`,
        `Entries: ${_DBG.log.length} / ${_DBG.MAX} max`,
        '='.repeat(70),
        '=== SillyTavern Global Environment ===',
        JSON.stringify(stEnv, null, 2),
        '='.repeat(70), '',
    ];
    for (const e of _DBG.log) {
        const d = new Date(e.ts);
        const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
        lines.push(`[${t}] ── ${e.type}`);
        lines.push(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2));
        lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `st-copilot-debug-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Debug log downloaded.', EXT_DISPLAY);
}
