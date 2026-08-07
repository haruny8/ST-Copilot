/**
 * session.js
 * Per-chat "session bucket" storage: saves/loads a JSON file per chat via
 * SillyTavern's file API (debounced writes, base64/JSON-repair fallback
 * decoding, v3->v4 migration from old settings-embedded sessions), plus
 * CRUD for sessions and messages within the active bucket.
 *
 * This is NOT the same thing as extension settings (see settings.js) — this
 * is roleplay/copilot session history, one file per chat.
 *
 * Moved from original index.js "Storage Subsystem" section (lines
 * 6346–6650, 305 lines).
 */

import { EXT_DISPLAY } from './constants.js';
import { dbgAdd } from './utils/util-debug.js';
import { repairJSON } from './utils/util-text.js';
import { getBindingKey } from './utils/util-st.js';
import { getSettings, saveSettings } from './settings.js';
import { recordStat, STAT } from './features/feature-stats.js';

let _inMemoryBucket = { activeSessionId: null, sessions: [] };
let _currentSessionFileId = null;
const _saveQueue = new Map();

// ─── File I/O ────────────────────────────────────────────────────────────
export async function saveSessionFile(file_id, payload, useKeepalive = false) {
    const ctx = SillyTavern.getContext();
    try {
        const jsonStr = JSON.stringify(payload);
        const b64 = btoa(unescape(encodeURIComponent(jsonStr)));
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file_id, data: b64 }),
            keepalive: useKeepalive,
        });
        return res.ok;
    } catch (e) {
        dbgAdd('STORAGE_WRITE_FAILED', { file_id, error: e.message });
        console.error(`[${EXT_DISPLAY}] saveSessionFile error:`, e);
        return false;
    }
}

window.addEventListener('beforeunload', () => {
    for (const [fileId, item] of _saveQueue.entries()) {
        clearTimeout(item.timer);
        saveSessionFile(fileId, item.payload, true);
    }
});

function _decodeBase64Utf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
}

function _tryParseSessionPayload(text) {
    try { return JSON.parse(text); } catch (_) {}
    try { return JSON.parse(_decodeBase64Utf8(text)); } catch (_) {}
    try { return JSON.parse(repairJSON(text)); } catch (_) {}
    try { return JSON.parse(repairJSON(_decodeBase64Utf8(text))); } catch (_) {}
    return undefined;
}

export async function loadSessionFile(file_id) {
    try {
        const res = await fetch(`/user/files/${file_id}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const text = await res.text();
        const trimmed = text.trim();
        if (!trimmed) return null;

        if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
            dbgAdd('STORAGE_LOAD_HTML_REDIRECT', { file_id });
            return null;
        }

        const parsed = _tryParseSessionPayload(trimmed);
        if (parsed === undefined) throw new Error('Unrecoverable payload after base64/repair fallback');
        return parsed;
    } catch (e) {
        dbgAdd('STORAGE_LOAD_ERROR', { file_id, error: e.message });
        console.error(`[${EXT_DISPLAY}] loadSessionFile error:`, e);
        return false;
    }
}

// ─── Bucket lifecycle ──────────────────────────────────────────────────────
export async function initChatBucket({ forceReset = false } = {}) {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    const { charId, chatId } = getBindingKey();

    if (forceReset) {
        const prevMeta = ctx.chatMetadata.st_copilot || null;
        const freshId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;
        ctx.chatMetadata.st_copilot = { format: 'v4', file_id: freshId, chat_id: chatId };
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
        _currentSessionFileId = freshId;
        _inMemoryBucket = { activeSessionId: null, sessions: [] };
        await commitBucketChanges(true);
        dbgAdd('SESSION_FORCE_RESET', { charId, chatId, prevFileId: prevMeta?.file_id || null, newFileId: freshId });
        return;
    }

    for (const [fileId, item] of _saveQueue.entries()) {
        clearTimeout(item.timer);
        _saveQueue.delete(fileId);
        saveSessionFile(fileId, item.payload);
    }

    let meta = ctx.chatMetadata.st_copilot;
    let targetFileId = null;
    let payload = null;

    if (meta && meta.file_id && meta.format === 'v4') {
        if (meta.chat_id === chatId) {
            targetFileId = meta.file_id;
            payload = await loadSessionFile(targetFileId);
        } else {
            dbgAdd('STORAGE_CHAT_BRANCH_DETECTED', { oldChatId: meta.chat_id, newChatId: chatId });
            payload = await loadSessionFile(meta.file_id);
            targetFileId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;

            if (payload && payload !== false) {
                await saveSessionFile(targetFileId, payload);
            }

            ctx.chatMetadata.st_copilot = { format: 'v4', file_id: targetFileId, chat_id: chatId };
            if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
        }
    } else {
        targetFileId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;
        dbgAdd('STORAGE_MIGRATION_V4_INIT', { targetFileId });

        const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
        payload = await loadSessionFile(`copilot_sess_${safeChatId}.json`);

        if (!payload && meta && meta.file_id && meta.format !== 'v4') {
            payload = await loadSessionFile(meta.file_id);
        }

        if (!payload) {
            const s = getSettings();
            if (s.sessions && s.sessions[charId]) {
                if (s.sessions[charId][chatId] && s.sessions[charId][chatId].sessions?.length > 0) {
                    payload = { bucket: { ...s.sessions[charId][chatId] } };
                    delete s.sessions[charId][chatId]; saveSettings();
                } else if (s.sessions[charId]['unified'] && s.sessions[charId]['unified'].sessions?.length > 0) {
                    payload = { bucket: { ...s.sessions[charId]['unified'] } };
                    delete s.sessions[charId]['unified']; saveSettings();
                }
            }
        }

        ctx.chatMetadata.st_copilot = { format: 'v4', file_id: targetFileId, chat_id: chatId };
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
    }

    _currentSessionFileId = targetFileId;

    if (payload === false) {
        dbgAdd('STORAGE_LOAD_CORRUPTED_RECOVERY', { brokenFileId: targetFileId, charId, chatId });
        const recoveryFileId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;
        ctx.chatMetadata.st_copilot = { format: 'v4', file_id: recoveryFileId, chat_id: chatId, recoveredFrom: targetFileId };
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();

        targetFileId = recoveryFileId;
        _inMemoryBucket = { activeSessionId: null, sessions: [] };
        _currentSessionFileId = targetFileId;
        await commitBucketChanges(true);

        toastr.error('Copilot session file was corrupted and could not be recovered. Started a fresh session storage for this chat; the broken file was kept on disk for manual recovery.', EXT_DISPLAY, { timeOut: 15000 });
        return;
    }

    if (payload && payload.bucket) {
        _inMemoryBucket = payload.bucket;
        dbgAdd('STORAGE_BUCKET_LOADED', { charId, chatId, fileId: targetFileId, sessionCount: _inMemoryBucket.sessions?.length || 0 });
    } else {
        _inMemoryBucket = { activeSessionId: null, sessions: [] };
        dbgAdd('STORAGE_BUCKET_EMPTY_INIT', { charId, chatId, fileId: targetFileId, hadPayload: !!payload });
    }

    if (!payload || meta?.format !== 'v4') {
        await commitBucketChanges(true);
    }
}

export async function commitBucketChanges(force = false) {
    const fileName = _currentSessionFileId;
    if (!fileName) return;

    const { chatId } = getBindingKey();
    const snapshot = JSON.parse(JSON.stringify(_inMemoryBucket));

    const payloadToSave = {
        _version: 4,
        chat_id_reference: chatId,
        updated_at: Date.now(),
        bucket: snapshot,
    };

    if (force) {
        const existing = _saveQueue.get(fileName);
        if (existing) clearTimeout(existing.timer);
        _saveQueue.delete(fileName);

        const success = await saveSessionFile(fileName, payloadToSave);
        if (!success) dbgAdd('STORAGE_WRITE_FAILED', { fileName });
    } else {
        const existing = _saveQueue.get(fileName);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            _saveQueue.delete(fileName);
            saveSessionFile(fileName, payloadToSave);
        }, 1000);

        _saveQueue.set(fileName, { timer, payload: payloadToSave });
    }
}

export function saveSessionsToMetadata() {
    commitBucketChanges();
}

export function getChatBucket() {
    return _inMemoryBucket;
}

export function genId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

// ─── Session CRUD ──────────────────────────────────────────────────────────
export function createSession(name, isTemporary = false, recordStats = true) {
    const bucket = getChatBucket();
    const id = genId('sess');
    const sess = { id, name: name || `Session ${bucket.sessions.length + 1}`, created: Date.now(), messages: [], isTemporary };

    if (recordStats) {
        const prev = bucket.sessions.find(s => s.id === bucket.activeSessionId);
        if (prev && prev.isTemporary) {
            bucket.sessions = bucket.sessions.filter(s => s.id !== prev.id);
        }
    }

    bucket.sessions.push(sess);
    bucket.activeSessionId = id;
    if (recordStats) recordStat(STAT.sess);
    saveSessionsToMetadata();
    dbgAdd('SESSION_CREATED', { id: sess.id, name: sess.name, isTemporary });
    return sess;
}

export function getActiveSession() {
    const bucket = getChatBucket();
    if (!bucket.sessions.length || !bucket.activeSessionId) return createSession(undefined, false, false);
    return bucket.sessions.find(s => s.id === bucket.activeSessionId) || createSession(undefined, false, false);
}

export function setActiveSession(sessionId) {
    const bucket = getChatBucket();
    if (!bucket.sessions.find(s => s.id === sessionId)) return;
    const prev = bucket.sessions.find(s => s.id === bucket.activeSessionId);
    if (prev && prev.isTemporary && prev.id !== sessionId) {
        bucket.sessions = bucket.sessions.filter(s => s.id !== prev.id);
    }
    bucket.activeSessionId = sessionId;
    saveSessionsToMetadata();
    dbgAdd('SESSION_SWITCHED', { id: sessionId });
}

export function deleteCurrentSession() {
    const bucket = getChatBucket();
    if (!bucket.sessions.length) return createSession();
    const deletedId = bucket.activeSessionId;
    bucket.sessions = bucket.sessions.filter(s => s.id !== bucket.activeSessionId);
    bucket.activeSessionId = bucket.sessions.length ? bucket.sessions[bucket.sessions.length - 1].id : null;
    saveSessionsToMetadata();
    dbgAdd('SESSION_DELETED', { id: deletedId });
    return getActiveSession();
}

export function getCurrentSession() {
    return getActiveSession();
}

// ─── Message CRUD ──────────────────────────────────────────────────────────
export function addMessage(session, role, content, extra = {}) {
    const msg = { id: genId('msg'), role, content, timestamp: Date.now(), ...extra };
    session.messages.push(msg);
    if (session.messages.length > 400) session.messages = session.messages.slice(-400);
    saveSessionsToMetadata();
    return msg;
}

export function insertMessageAfter(session, afterMsgId, role, content, extra = {}) {
    const msg = { id: genId('msg'), role, content, timestamp: Date.now(), ...extra };
    const idx = afterMsgId ? session.messages.findIndex(m => m.id === afterMsgId) : -1;
    if (idx !== -1) session.messages.splice(idx + 1, 0, msg);
    else session.messages.push(msg);
    if (session.messages.length > 400) session.messages = session.messages.slice(-400);
    saveSessionsToMetadata();
    return msg;
}

export function updateMessage(session, msgId, newContent) {
    const msg = session.messages.find(m => m.id === msgId);
    if (msg) { msg.content = newContent; saveSessionsToMetadata(); }
}

export function truncateAfter(session, msgId) {
    const idx = session.messages.findIndex(m => m.id === msgId);
    if (idx !== -1) { session.messages.splice(idx + 1); saveSessionsToMetadata(); }
}

export function deleteMsg(session, msgId) {
    const idx = session.messages.findIndex(m => m.id === msgId);
    if (idx !== -1) { session.messages.splice(idx, 1); saveSessionsToMetadata(); }
}

const INLINE_SUMMARY_PICK_PREFIX = 'ils:';

export function makeChatPickKey(chatIndex, inlineSummarySourcePath = null) {
    if (!inlineSummarySourcePath) return chatIndex;
    return `${INLINE_SUMMARY_PICK_PREFIX}${chatIndex}:${inlineSummarySourcePath.join('.')}`;
}

export function parseChatPickKey(key) {
    if (Number.isInteger(key)) return { chatIndex: key, inlineSummarySourcePath: null };
    if (typeof key !== 'string' || !key.startsWith(INLINE_SUMMARY_PICK_PREFIX)) return null;
    const match = key.match(/^ils:(\d+):(\d+(?:\.\d+)*)$/);
    if (!match) return null;
    return {
        chatIndex: Number(match[1]),
        inlineSummarySourcePath: match[2].split('.').map(Number),
    };
}

export function truncateFrom(session, msgId) {
    const idx = session.messages.findIndex(m => m.id === msgId);
    if (idx !== -1) { session.messages.splice(idx); saveSessionsToMetadata(); }
}

// ─── Session Override System ────────────────────────────────────────────────
// Per-chat-session overrides that sit on top of global settings — e.g. a
// user can pin a different connection profile or context depth for just
// one session without changing their global defaults.
//
// Moved from original index.js "Session Override System" section
// (lines 6004-6085, 82 lines) — kept here rather than its own file since
// it's read/written together with session data throughout the codebase.

export const SESSION_OVERRIDE_KEYS = [
    'contextDepth', 'localHistoryLimit', 'maxTokens',
    'connectionSource', 'connectionProfileId', 'systemPrompt',
    'includeSystemPrompt', 'includeUserPersonality', 'reasoningTrimStrings',
    'applyRegexToContext', 'includeInlineSummaryOriginals', 'forceStreaming',
    'charEditAIEnabled', 'charEditPrompt', 'lorebookAIManageEnabled',
    'lorebookManagePrompt', 'chatEditAIEnabled', 'chatEditPrompt', 'altGreetingIndices',
    'lorebookAutoKeyword',
];

export function getSessionOverrides() {
    try { return getCurrentSession()?.overrides || {}; } catch (_) { return {}; }
}

export function getEffectiveSettings() {
    return { ...getSettings(), ...getSessionOverrides() };
}

export function setSessionOverride(key, value) {
    try {
        const sess = getCurrentSession();
        if (!sess) return;
        if (!sess.overrides) sess.overrides = {};
        if (value === undefined || value === null) delete sess.overrides[key];
        else sess.overrides[key] = value;
        saveSessionsToMetadata();
        updateSessionOverrideIndicator();
    } catch (_) {}
}

export function clearAllSessionOverrides() {
    try {
        const sess = getCurrentSession();
        if (!sess) return;
        sess.overrides = {};
        saveSessionsToMetadata();
        updateSessionOverrideIndicator();
    } catch (_) {}
}

export function hasSessionOverrides() {
    try { const o = getCurrentSession()?.overrides; return !!(o && Object.keys(o).length > 0); }
    catch (_) { return false; }
}

export function updateSessionOverrideIndicator() {
    const has = hasSessionOverrides();
    const dot = document.getElementById('scp-sp-override-dot');
    if (dot) dot.style.display = has ? '' : 'none';
    const gearDot = document.getElementById('scp-gear-ov-dot');
    if (gearDot) gearDot.style.display = has ? '' : 'none';
    const btn = document.getElementById('scp-ext-settings-btn');
    if (btn) btn.classList.toggle('scp-has-overrides', has);
    updateSPOverrideIndicators();
    const info = document.getElementById('scp-sp-footer-info');
    if (info) {
        const ov = getSessionOverrides();
        const count = Object.keys(ov).length;
        info.textContent = count ? `${count} session override${count !== 1 ? 's' : ''} active` : '';
    }
    const ov = getSessionOverrides();
    const depthSlider = document.getElementById('scp-depth-slider');
    const depthVal = document.getElementById('scp-depth-val');
    const hasDepthOv = 'contextDepth' in ov;
    if (depthSlider) depthSlider.classList.toggle('scp-slider-overridden', hasDepthOv);
    if (depthVal) depthVal.classList.toggle('scp-depth-val-overridden', hasDepthOv);
}

export function updateSPOverrideIndicators() {
    const ov = getSessionOverrides();
    document.querySelectorAll('.scp-sp-ov-label[data-ovkey]').forEach(label => {
        label.classList.toggle('has-override', label.dataset.ovkey in ov);
    });
    document.querySelectorAll('.scp-sp-ov-clear[data-ovkey]').forEach(btn => {
        const active = btn.dataset.ovkey in ov;
        btn.classList.toggle('active', active);
        btn.disabled = !active;
    });
}

// Was left behind, unexported, in the old "ST Context Helpers" section
// (old line 6693) — it reads/writes session + settings state (this file's
// job) to keep every depth slider (ST drawer, Settings Panel global tab,
// Settings Panel override tab) in sync with the current chat length.
// Needed by ui-settings.js (Settings Panel Handlers) and ui-widgets.js
// (Depth Slider Click-to-Type), so it lives here rather than in either one
// to avoid a circular import between those two UI modules.
let _lastChatLen = -1;

// Exported so index.js's onChatChanged (old index.js line 14158) can reset
// this on chat switch, same reasoning as above — module-private state,
// needs a real accessor once split out of the closure.
export function resetLastChatLen() { _lastChatLen = -1; }

export function updateDepthSlidersMax() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || window.chat || [];
    const maxVal = Math.max(1, chat.length);

    if (_lastChatLen === -1) {
        _lastChatLen = maxVal;
    }

    const s = getSettings();
    const sess = getCurrentSession();
    let settingsChanged = false;

    const globalDepth = parseInt(s.contextDepth) || 0;
    if (globalDepth >= _lastChatLen && maxVal > _lastChatLen) {
        s.contextDepth = maxVal;
        settingsChanged = true;
    }

    if (sess && sess.overrides && sess.overrides.contextDepth !== undefined) {
        const ovDepth = parseInt(sess.overrides.contextDepth) || 0;
        if (ovDepth >= _lastChatLen && maxVal > _lastChatLen) {
            sess.overrides.contextDepth = maxVal;
            settingsChanged = true;
        }
    }

    if (settingsChanged) {
        saveSettings();
    }

    _lastChatLen = maxVal;

    const eff = getEffectiveSettings();

    const sliders = [
        { id: 'scp-depth-slider', valId: 'scp-depth-val', setting: s.contextDepth },
        { id: 'scp-sp-depth-slider', valId: 'scp-sp-depth-val', setting: s.contextDepth },
        { id: 'scp-sp-ov-depth-slider', valId: 'scp-sp-ov-depth-val', setting: eff.contextDepth }
    ];

    sliders.forEach(item => {
        const el = document.getElementById(item.id);
        if (el) {
            if (parseInt(el.max) !== maxVal) {
                el.max = maxVal;
            }

            const renderVal = Math.min(maxVal, parseInt(item.setting ?? 15));
            el.value = renderVal;

            const valEl = document.getElementById(item.valId);
            if (valEl) {
                valEl.textContent = renderVal;
            }
        }
    });
}
