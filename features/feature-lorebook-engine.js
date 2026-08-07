/**
 * feature-lorebook-engine.js
 * Lorebook (World Info) integration: fetches/caches WI books, resolves
 * which books are "active" for the current chat/character, builds the
 * lorebook context block injected into the prompt (manual + constant +
 * keyword-triggered entries, plus {{outlet::name}} macro expansion), and
 * parses/applies AI-proposed lorebook-changes blocks (add/edit/patch/delete)
 * back onto the actual World Info files.
 *
 * Moved from original index.js "Lorebook (World Info) Module" section
 * (lines 759-1226) plus the unlabeled block immediately after the
 * Character Card Editing Engine (lines 2617-3110) — that unlabeled block
 * turned out to be lorebook-change-application logic, not character stuff,
 * so it's combined here rather than left orphaned.
 *
 * Two small duplicates were found and removed in favor of the shared copy:
 * `getTagsForCharacter` (already in utils/util-st.js) and `_repairJSON`
 * (already in utils/util-text.js as `repairJSON`).
 *
 * `renderLBHistoryContent`/`appendLBHistoryEl` turned out to live in what's
 * now `feature-chatedit-engine.js`, and `expandMacros` turned out to live
 * in what's now `api.js` — both imported directly. Note this creates
 * import cycles with both of those modules (lorebook-engine <-> chatedit-
 * engine, and lorebook-engine <-> api.js) — safe here since every
 * cross-reference only fires from inside a function body, never at
 * module-load time (verified with a real Node runtime test, not just a
 * syntax check).
 */

import { EXT_DISPLAY } from '../constants.js';
import { repairJSON } from '../utils/util-text.js';
import { escHtml } from '../utils/util-dom.js';
import { getSTWorldInfo, getSTUtils } from '../state.js';
import { getSettings, saveSettings } from '../settings.js';
import { getCurrentSession, addMessage, saveSessionsToMetadata, getEffectiveSettings } from '../session.js';
import { DEFAULT_LB_MANAGE_PROMPT, LB_FORMAT_BLOCK } from '../default-prompts.js';
import { applySearchReplaceToField } from './feature-character-engine.js';
import { recordStat, STAT } from './feature-stats.js';
import { renderLBHistoryContent as _renderLBHistoryContent, appendLBHistoryEl as _appendLBHistoryEl } from './feature-chatedit-engine.js';
import { expandMacros as _expandMacros } from '../api.js';
import { parseChatPickKey } from '../session.js';

let _wiCache = {};
let _wiPromises = {};
export const EMBEDDED_BOOK_KEY = '__char_embedded__';
let _lastActiveEntries = [];
let _regexModule = false;

// Accessors for feature-lorebook-ui.js — `_wiCache` and `_lastActiveEntries`
// stay module-private `let` bindings (only this module can reassign them),
// but the manager UI needs to read individual cache entries, iterate the
// last-active-entries list, and force a full cache clear after edits.
export function getWiCache() { return _wiCache; }
export function clearWiCache() { _wiCache = {}; }
export function getLastActiveEntries() { return _lastActiveEntries; }
let _copilotActive = false;

export async function loadRegexModule() {
    if (_regexModule !== false) return _regexModule;
    try {
        _regexModule = await import('/scripts/extensions/regex/engine.js');
    } catch (e) {
        _regexModule = null;
    }
    return _regexModule;
}

export async function applyRegexIfEnabled(text, isUser, depth) {
    if (!getEffectiveSettings().applyRegexToContext) return text;
    try {
        const mod = await loadRegexModule();
        if (!mod?.getRegexedString) return text;
        const placement = isUser
            ? (mod.regex_placement?.USER_INPUT ?? 1)
            : (mod.regex_placement?.AI_OUTPUT ?? 2);
        const params = { isPrompt: true };
        if (typeof depth === 'number') params.depth = depth;
        const result = mod.getRegexedString(text, placement, params);
        const resolved = (result instanceof Promise) ? await result : result;
        return (typeof resolved === 'string') ? resolved : text;
    } catch (e) {
        return text;
    }
}

export async function fetchWorldInfoBook(name) {
    if (name === EMBEDDED_BOOK_KEY) return getEmbeddedCharBook();
    
    if (_wiCache[name] && Date.now() - (_wiCache[name]._ts || 0) < 30000) return _wiCache[name];
    if (_wiPromises[name]) return _wiPromises[name];

    const ctx = SillyTavern.getContext();
    
    _wiPromises[name] = (async () => {
        try {
            let data = null;
            if (typeof ctx.loadWorldInfo === 'function') {
                data = await ctx.loadWorldInfo(name);
            } else {
                const res = await fetch('/api/worldinfo/get', {
                    method: 'POST',
                    headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            }
            if (!data) return null;
            data._ts = Date.now();
            _wiCache[name] = data;
            return data;
        } catch (e) {
            console.error(`[${EXT_DISPLAY}] WI load failed for "${name}":`, e);
            return null;
        } finally {
            delete _wiPromises[name];
        }
    })();

    return _wiPromises[name];
}

export function getEmbeddedCharBook() {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    const book = char?.data?.character_book;
    if (!book?.entries?.length) return null;
    const data = { entries: {}, _embedded: true, _ts: Date.now() };
    (book.entries || []).forEach((e, idx) => {
        const uid = e.id ?? idx;
        data.entries[uid] = {
            uid,
            key: Array.isArray(e.keys) ? e.keys : (e.key || []),
            keysecondary: e.secondary_keys || e.keysecondary || [],
            content: e.content || '',
            comment: e.name || e.comment || '',
            disable: e.enabled === false,
            constant: !!e.constant,
            selective: !!e.selective,
            position: e.position ?? 0,
            displayIndex: uid,
            outletName: e.extensions?.outlet_name || e.outletName || e.outlet_name || (typeof e.outlet === 'string' ? e.outlet : '') || '',
            outlet: e.outlet_name || e.outletName || (typeof e.outlet === 'string' ? e.outlet : '') || '',
            group: e.group || '',
        };
    });
    return data;
}

export async function saveWorldInfoBook(name, data) {
    if (data._embedded) { toastr.warning('Cannot save embedded character books directly.', EXT_DISPLAY); return; }
    const ctx = SillyTavern.getContext();
    const payload = { ...data };
    delete payload._ts;
    try {
        if (typeof ctx.saveWorldInfo === 'function') {
            await ctx.saveWorldInfo(name, payload);
        } else {
            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, data: payload }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => res.statusText);
                throw new Error(`HTTP ${res.status}: ${errText}`);
            }
        }
    } catch (e) {
        console.error(`[${EXT_DISPLAY}] saveWorldInfoBook failed for "${name}":`, e);
        throw e;
    }
    delete _wiCache[name];
    
    try {
        if (typeof ctx.reloadWorldInfoEditor === 'function') {
            ctx.reloadWorldInfoEditor(name, true);
        }
    } catch (_) {}
}


export function getDisplayName(name) {
    if (name === EMBEDDED_BOOK_KEY) {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters?.[ctx.characterId];
        return `[${char?.name || 'Character'} Book]`;
    }
    return name;
}


export function getActiveLorebookNames() {
    const ctx = SillyTavern.getContext();
    const names = new Set();

    // 1. GLOBAL
    const globalBooks = getSTWorldInfo()?.selected_world_info || window.selected_world_info ||[];
    if (Array.isArray(globalBooks)) {
        globalBooks.forEach(n => n && names.add(n));
    }

    // 2. CHARACTER
    const charId = ctx.characterId;
    const character = ctx.characters?.[charId];
    if (character) {
        const baseWorldName = character.data?.extensions?.world || character.world;
        if (baseWorldName && typeof baseWorldName === 'string') names.add(baseWorldName);

        let fileName = character.avatar;
        if (getSTUtils() && typeof getSTUtils().getCharaFilename === 'function') {
            fileName = getSTUtils().getCharaFilename(charId);
        }
        const charLoreList = getSTWorldInfo()?.world_info?.charLore || window.world_info?.charLore;
        if (fileName && Array.isArray(charLoreList)) {
            const extraCharLore = charLoreList.find(e => e.name === fileName);
            if (extraCharLore && Array.isArray(extraCharLore.extraBooks)) {
                extraCharLore.extraBooks.forEach(book => book && names.add(book));
            }
        }
    }

    // 3. CHAT
    const wiKey = getSTWorldInfo()?.METADATA_KEY || window.WI_METADATA_KEY || 'world_info';
    const chatWorldName = ctx.chatMetadata?.[wiKey];
    if (chatWorldName && typeof chatWorldName === 'string') names.add(chatWorldName);

    // 4. PERSONA
    const personaWorldName = ctx.powerUserSettings?.persona_description_lorebook;
    if (personaWorldName && typeof personaWorldName === 'string') names.add(personaWorldName);

    return [...names].filter(Boolean);
}


export function getBookSourceType(name) {
    if (name === EMBEDDED_BOOK_KEY) return 'embedded';
    const ctx = SillyTavern.getContext();
    
    const globalBooks = getSTWorldInfo()?.selected_world_info || window.selected_world_info || [];
    if (Array.isArray(globalBooks) && globalBooks.includes(name)) {
        return 'global';
    }

    const charId = ctx.characterId;
    const character = ctx.characters?.[charId];
    if (character) {
        const baseWorldName = character.data?.extensions?.world || character.world;
        if (baseWorldName === name) return 'character';

        let fileName = character.avatar;
        if (getSTUtils() && typeof getSTUtils().getCharaFilename === 'function') {
            fileName = getSTUtils().getCharaFilename(charId);
        }
        const charLoreList = getSTWorldInfo()?.world_info?.charLore || window.world_info?.charLore;
        if (fileName && Array.isArray(charLoreList)) {
            const extraCharLore = charLoreList.find(e => e.name === fileName);
            if (extraCharLore?.extraBooks?.includes(name)) return 'character';
        }
    }

    const wiKey = getSTWorldInfo()?.METADATA_KEY || window.WI_METADATA_KEY || 'world_info';
    if (ctx.chatMetadata?.[wiKey] === name) return 'chat';
    
    if (ctx.powerUserSettings?.persona_description_lorebook === name) return 'chat';

    return 'manual';
}

export function wiEntriesToArray(data) {
    if (!data?.entries) return [];
    return Object.values(data.entries).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
}

export function keywordMatchEntry(keys, text) {
    if (!keys?.length || !text) return false;
    const lower = text.toLowerCase();
    return keys.some(k => {
        if (!k) return false;
        try {
            const m = k.match(/^\/(.+)\/([gimsuy]*)$/);
            if (m) return new RegExp(m[1], m[2]).test(text);
        } catch (_) {}
        return lower.includes(k.toLowerCase());
    });
}

export function getKeywordTriggeredEntries(allBooksData, text1, text2) {
    const scanText = [text1, text2].filter(Boolean).join('\n');
    const results = {};
    for (const [bookName, data] of Object.entries(allBooksData)) {
        const entries = wiEntriesToArray(data);
        const matched = entries.filter(e => !e.disable && (keywordMatchEntry(e.key, scanText) || keywordMatchEntry(e.keysecondary, scanText)));
        if (matched.length) results[bookName] = matched;
    }
    return results;
}

export function getEntryOverrideKey(bookName, entry) {
    let entryName = (entry.comment || entry.name || '').trim();
    if (!entryName && entry.key && entry.key.length) {
        entryName = entry.key.join('_').slice(0, 40);
    }
    entryName = entryName.replace(/[\r\n]+/g, ' ').trim();
    return entryName ? `${bookName}_${entryName}` : `${bookName}_${entry.uid}`;
}

export async function buildLorebookContextBlock(settings) {
    _lastActiveEntries = [];
    const selectedBooks = settings.lorebookSelectedBooks || [];
    const excludedBooks = new Set(settings.lorebookExcludedBooks || []);
    const overrides = settings.lorebookEntryOverrides || {};
    if (!selectedBooks.length && !settings.lorebookAutoKeyword && !excludedBooks.size) return '';
    const loadedBooks = {};
    const _activeNamesSet = new Set(getActiveLorebookNames());

    await Promise.all(selectedBooks.map(async name => {
        if (!_activeNamesSet.has(name) || excludedBooks.has(name)) return;
        const data = await fetchWorldInfoBook(name);
        if (data) loadedBooks[name] = data;
    }));


    let keywordEntries = {};
    if (settings.lorebookAutoKeyword) {
        const ctx = SillyTavern.getContext();
        const msgs = ctx.chat || [];
        let lastUser = '', lastChar = '';

        try {
            const session = getCurrentSession();
            const picked = session.pickedChatIndices;
            if (picked && picked.length > 0) {
                const pickedMsgs = [...new Set(picked.map(parseChatPickKey)
                    .filter(key => key && key.chatIndex >= 0 && key.chatIndex < msgs.length)
                    .map(key => key.chatIndex))].map(index => msgs[index]);
                lastUser = pickedMsgs.filter(m => m.is_user).map(m => m.mes).join('\n');
                lastChar = pickedMsgs.filter(m => !m.is_user).map(m => m.mes).join('\n');
            } else {
                const stDepth = Math.max(1, settings.lorebookSTScanDepth ?? 5);
                const recentMsgs = msgs.slice(-stDepth);
                lastUser = recentMsgs.filter(m => m.is_user).map(m => m.mes).join('\n');
                lastChar = recentMsgs.filter(m => !m.is_user).map(m => m.mes).join('\n');
            }
        } catch (_) {
            const stDepth = Math.max(1, settings.lorebookSTScanDepth ?? 5);
            const recentMsgs = msgs.slice(-stDepth);
            lastUser = recentMsgs.filter(m => m.is_user).map(m => m.mes).join('\n');
            lastChar = recentMsgs.filter(m => !m.is_user).map(m => m.mes).join('\n');
        }

        let copilotScanText = '';
        try {
            const session = getCurrentSession();
            const copilotDepth = settings.lorebookCopilotScanDepth ?? 6;
            copilotScanText = session.messages
                .filter(m => !m.isLBHistory)
                .slice(-copilotDepth)
                .map(m => m.content)
                .join('\n');
        } catch (_) {}

        const activeNames = getActiveLorebookNames();
        await Promise.all(activeNames.map(async name => {
            if (!loadedBooks[name] && !excludedBooks.has(name)) {
                const data = await fetchWorldInfoBook(name);
                if (data) loadedBooks[name] = data;
            }
        }));
        keywordEntries = getKeywordTriggeredEntries(loadedBooks, lastUser + '\n' + lastChar, copilotScanText);
    }

    const toInject = {};
    let overridesChanged = false;

    for (const[bookName, data] of Object.entries(loadedBooks)) {
        for (const entry of wiEntriesToArray(data)) {
            if (!entry.content) continue;
            
            const oldKey = `${bookName}_${entry.uid}`;
            const newKey = getEntryOverrideKey(bookName, entry);
            
            if (oldKey !== newKey && overrides[oldKey] !== undefined) {
                overrides[newKey] = overrides[oldKey];
                delete overrides[oldKey];
                overridesChanged = true;
            }
            
            const override = overrides[newKey];
            
            if (override === false) continue;
            
            const isConstant = !!entry.constant && !entry.disable;
            const manualInclude = selectedBooks.includes(bookName);
            const keywordInclude = keywordEntries[bookName]?.some(e => e.uid === entry.uid);
            
            if (override === true || isConstant || manualInclude || keywordInclude) {
                if (!toInject[bookName]) toInject[bookName] = [];
                toInject[bookName].push(entry);
            }
        }
    }

    if (overridesChanged) saveSettings();

    if (!Object.keys(toInject).length) return '';

    let block = '\n\n<lorebook_context>\n';
let outletLines = [];
for (const [bookName, entries] of Object.entries(toInject)) {
let hasNormalEntries = false;
let bookBlock = `## ${getDisplayName(bookName)}\n`;
for (const e of entries) {
const outletId = (e.outlet_name || e.outletName || e.automation_id || e.automationId || (typeof e.outlet === 'string' ? e.outlet : '') || '').trim();
const isPositionOutlet = '7' === String(e.position) || 'outlet' === String(e.position).toLowerCase();
const outletLabel = outletId || (isPositionOutlet? (e.group || '').trim(): '');

if (isPositionOutlet || outletLabel !== '') {
if (!e.disable) {
    // Include the actual content in the lorebook context
    hasNormalEntries = true;
    bookBlock += `### ${e.comment || `Entry #${e.uid}`} (uid: ${e.uid}) [OUTLET: ${outletLabel}]`;
    if (e.key?.length) bookBlock += ` [keys: ${e.key.slice(0, 5).join(', ')}]`;
    bookBlock += `\n${e.content}\n\n`;
    _lastActiveEntries.push({ bookName, displayName: getDisplayName(bookName), entryName: e.comment || `#${e.uid}`, uid: e.uid });
}
continue;
}hasNormalEntries = true;
bookBlock += `### ${e.comment || `Entry #${e.uid}`} (uid: ${e.uid})`;
if (e.key?.length) bookBlock += ` [keys: ${e.key.slice(0, 5).join(', ')}]`;
bookBlock += `\n${e.content}\n\n`;
_lastActiveEntries.push({ bookName, displayName: getDisplayName(bookName), entryName: e.comment || `#${e.uid}`, uid: e.uid });
}
if (hasNormalEntries) block += bookBlock;
}
if (outletLines.length) {
block += `## Outlet Entries (injected via {{outlet::name}} macro, not directly)\n${outletLines.join('\n')}\n\n`;
}
    block += '</lorebook_context>';
    return block;
}

export function buildLBAIInstructions(settings) {
    if (!settings.lorebookAIManageEnabled) return '';
    const excludedBooks = new Set(settings.lorebookExcludedBooks || []);
    const activeBooks =[...new Set(_lastActiveEntries.map(e => e.displayName || e.bookName))].filter(b => !excludedBooks.has(b));
    const activeBooksStr = activeBooks.length > 0 ? activeBooks.map(b => `"${b}"`).join(', ') : 'None';
    
    let rawPrompt = settings.lorebookManagePrompt || DEFAULT_LB_MANAGE_PROMPT;
    
    if (!rawPrompt.includes('{{active_lorebooks}}')) {
        if (rawPrompt.includes('Format requirment:')) {
            rawPrompt = rawPrompt.replace('Format requirment:', `Active lorebooks: {{active_lorebooks}}\n\nFormat requirment:`);
        } else {
            rawPrompt = `Active lorebooks: {{active_lorebooks}}\n\n` + rawPrompt;
        }
    }

    const prompt = rawPrompt
        .replace('{{active_lorebooks}}', activeBooksStr)
        .replace('{{lorebook_output}}', LB_FORMAT_BLOCK);
        
    return `<lorebook_management>\n${prompt}\n</lorebook_management>`;
}

export async function expandOutletsAsync(text, depth = 0) {
if (!text || typeof text!== 'string' ||!text.includes('{{outlet::') || depth > 3) return text;
const outletNames = [...new Set([...text.matchAll(/\{\{outlet::(.*?)\}\}/gi)].map(m => m[1]))];
if (!outletNames.length) return text;
const activeBooks = getActiveLorebookNames();
if (!activeBooks.includes(EMBEDDED_BOOK_KEY)) activeBooks.push(EMBEDDED_BOOK_KEY);
const allBookData = [];
for (const bookName of activeBooks) {
const data = await fetchWorldInfoBook(bookName);
if (data) allBookData.push(data);
}
let result = text;
for (const name of outletNames) {
const trimmedName = name.trim();
const matchedEntries = [];
for (const bookData of allBookData) {
const entries = Object.values(bookData.entries || {});
for (const entry of entries) {
const entryOutlet = (entry.outlet_name || entry.outletName || entry.automation_id || entry.automationId || (typeof entry.outlet === 'string' ? entry.outlet : '') || '').trim();
const isPositionOutlet = '7' === String(entry.position) || 'outlet' === String(entry.position).toLowerCase();
const label = entryOutlet || (isPositionOutlet? (entry.group || '').trim(): '');
if (!entry.disable && label === trimmedName) {
matchedEntries.push(entry);
}
}
}
const replacement = matchedEntries.map(e => _expandMacros(e.content || '')).join('\n');
const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const regex = new RegExp(`\\{\\{outlet::${escapedName}\\}\\}`, 'g');
result = result.replace(regex, replacement);
}
if (result.includes('{{outlet::')) {
result = await expandOutletsAsync(result, depth + 1);
}
return result;
}

export function parseLBChangesFromText(text) {
    let raw = null;
    const strict = text.match(/```lorebook-changes\s*([\s\S]*?)```/);
    if (strict) {
        raw = strict[1].trim();
    } else {
        const open = text.match(/```lorebook-changes\s*([\s\S]*?)(?=```|$)/);
        if (open) raw = open[1].trim();
    }
    if (!raw) return null;
    // direct parse
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.changes)) return _sanitizeLBChanges(data.changes);
    } catch (_) {}
    // repair common issues
    try {
        const repaired = repairJSON(raw);
        const data = JSON.parse(repaired);
        if (Array.isArray(data.changes)) return _sanitizeLBChanges(data.changes);
    } catch (_) {}
    //aggressive unescaped-quotes fix
    try {
        const lines = raw.split('\n');
        const fixed = lines.map(line => {
            return line.replace(/("(?:content|name|comment|search|replace|triggers)":\s*)"((?:[^"\\]|\\.)*)"/, (match, prefix, val) => {
                const escaped = val.replace(/(?<!\\)"/g, '\\"');
                return `${prefix}"${escaped}"`;
            });
        }).join('\n');
        const data = JSON.parse(fixed);
        if (Array.isArray(data.changes)) return _sanitizeLBChanges(data.changes);
    } catch (_) {}
    return null;
}

export function _parseLBDiffPatch(str) {
    const m = str.match(/<<<<<<< (?:SEARCH|ANCHOR)\r?\n([\s\S]*?)\r?\n=+\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/);
    return m ? { search: m[1], replace: m[2] } : null;
}

export function _sanitizeLBChanges(changes) {
    if (!Array.isArray(changes)) return null;
    const valid = [];
    for (const c of changes) {
        if (!c || typeof c !== 'object') continue;
        if (!['add', 'edit', 'patch', 'delete'].includes(c.action)) continue;
        if (!c.worldName && !c.name && c.uid == null) continue;
        if (c.triggers === 'original' || c.triggers === 'keep' || c.triggers === undefined || c.triggers === null) {
            c.triggers = null;
        } else if (!Array.isArray(c.triggers)) {
            c.triggers = String(c.triggers).split(',').map(s => s.trim()).filter(Boolean);
        }
        if (c.constant !== undefined) c.constant = !!c.constant;
        if (c.action === 'patch' && Array.isArray(c.patches)) {
            c.patches = c.patches.map(p => {
                if (typeof p === 'string') return _parseLBDiffPatch(p);
                if (p && typeof p === 'object') {
                    p.search = p.search || p.anchor;
                    if (p.search !== undefined) return p;
                }
                return null;
            }).filter(Boolean);
        }
        valid.push(c);
    }
    return valid.length ? valid : null;
}


export function stripLBChangesBlock(text) {
    return text
        .replace(/```lorebook-changes[\s\S]*?```/g, '')
        .replace(/```lorebook-changes[\s\S]*/g, '')
        .trim();
}

export async function bindNewLorebookToCharacter(bookName) {
    try {
        const ctx = SillyTavern.getContext();

        const allBooks = window.world_names || getSTWorldInfo()?.world_names || [];
        const isNew = !allBooks.includes(bookName);

        if (isNew) {
            console.log('[ST-Copilot-Debug] Lorebook is new. Requesting ST to create...');
            if (typeof getSTWorldInfo()?.createNewWorldInfo === 'function') {
                await getSTWorldInfo().createNewWorldInfo(bookName);
            } else if (typeof window.createNewWorldInfo === 'function') {
                await window.createNewWorldInfo(bookName);
            } else {
                const payload = { entries: {}, extensions: {} };
                await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: bookName, data: payload }),
                });
                if (typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList();
                else if (typeof window.loadWorldInfoList === 'function') await window.loadWorldInfoList();
            }
            toastr.success(`Lorebook "${escHtml(bookName)}" created successfully.`, EXT_DISPLAY);
        }

        delete _wiCache[bookName];

        const charId = ctx.characterId;
        if (charId === undefined || charId === null) return;

        let fileName = ctx.characters?.[charId]?.avatar;
        if (getSTUtils() && typeof getSTUtils().getCharaFilename === 'function') {
            fileName = getSTUtils().getCharaFilename(charId);
        } else if (typeof window.getCharaFilename === 'function') {
            fileName = window.getCharaFilename(charId);
        }
        if (!fileName) return;

        let wiSettings = window.world_info || getSTWorldInfo()?.world_info;
        if (!wiSettings) return;

        if (!Array.isArray(wiSettings.charLore)) wiSettings.charLore = [];

        const charLoreList = wiSettings.charLore;
        let extraCharLore = charLoreList.find(e => e.name === fileName);
        if (!extraCharLore) {
            extraCharLore = { name: fileName, extraBooks: [] };
            charLoreList.push(extraCharLore);
        }
        if (!Array.isArray(extraCharLore.extraBooks)) extraCharLore.extraBooks = [];

        if (!extraCharLore.extraBooks.includes(bookName)) {
            extraCharLore.extraBooks.push(bookName);
            console.log(`[ST-Copilot-Debug] Added "${bookName}" to extraBooks.`);

            if (typeof getSTWorldInfo()?.saveWorldInfoSettings === 'function') getSTWorldInfo().saveWorldInfoSettings();
            else if (typeof window.saveWorldInfoSettings === 'function') window.saveWorldInfoSettings();

            if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
            else if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();

            if (typeof getSTWorldInfo()?.printWorldInfoCharacters === 'function') getSTWorldInfo().printWorldInfoCharacters();
            else if (typeof window.printWorldInfoCharacters === 'function') window.printWorldInfoCharacters();
        }
    } catch (e) {
        console.error(`[ST-Copilot-Debug] Exception in bindNewLorebookToCharacter:`, e);
    }
}

export async function resolveLBChangeTarget(change, strictBook = false) {
    let bookName = change.worldName || '';
    let targetUid = change.uid;

    const fuzzyWorld = bookName.toLowerCase();
    const fuzzyName = (change.originalName || change.name || '').toLowerCase();
    
    if (fuzzyName && !strictBook) {
        const activeMatch = _lastActiveEntries.find(le => {
            const wMatch = !fuzzyWorld || le.displayName.toLowerCase() === fuzzyWorld || le.bookName.toLowerCase() === fuzzyWorld;
            const nMatch = le.entryName.toLowerCase() === fuzzyName || le.entryName.toLowerCase().includes(fuzzyName) || fuzzyName.includes(le.entryName.toLowerCase());
            return wMatch && nMatch;
        });
        if (activeMatch) {
            if (targetUid == null) targetUid = activeMatch.uid;
            bookName = activeMatch.bookName;
        }
    }

    if (bookName === getDisplayName(EMBEDDED_BOOK_KEY)) bookName = EMBEDDED_BOOK_KEY;

    let data = await fetchWorldInfoBook(bookName);
    if (!data && bookName && !strictBook) {
        const allActive = getActiveLorebookNames();
        const match = allActive.find(n => n.toLowerCase() === fuzzyWorld || n.toLowerCase().includes(fuzzyWorld) || fuzzyWorld.includes(n.toLowerCase()));
        if (match) {
            bookName = match;
            data = await fetchWorldInfoBook(bookName);
        }
    }

    let origEntry = null;
    if (data && data.entries) {
        origEntry = Object.values(data.entries).find(en => {
            if (targetUid != null && String(en.uid) === String(targetUid)) return true;
            if (!fuzzyName) return false;
            const cStr = (en.comment || `Entry #${en.uid}`).trim().toLowerCase();
            if (cStr === fuzzyName) return true;
            return cStr.includes(fuzzyName) || fuzzyName.includes(cStr);
        });
    }

    if (!origEntry && fuzzyName && !strictBook) {
        for (const name of getActiveLorebookNames()) {
            if (name === bookName) continue;
            const bd = await fetchWorldInfoBook(name);
            if (!bd) continue;
            origEntry = Object.values(bd.entries).find(en => {
                const c = (en.comment || `Entry #${en.uid}`).trim().toLowerCase();
                return c === fuzzyName || c.includes(fuzzyName) || fuzzyName.includes(c);
            });
            if (origEntry) { bookName = name; data = bd; break; }
        }
    }

    if (!data) {
        console.warn(`[${EXT_DISPLAY}] resolveLBChangeTarget: no book data found`, {
            change, resolvedBookName: bookName, activeBooks: getActiveLorebookNames(), cacheKeys: Object.keys(_wiCache)
        });
    } else if (!origEntry && change.action !== 'add') {
        console.warn(`[${EXT_DISPLAY}] resolveLBChangeTarget: entry not found`, {
            fuzzyName, fuzzyWorld, targetUid,
            entries: Object.values(data.entries || {}).map(e => ({ uid: e.uid, comment: e.comment, key: e.key?.slice(0, 3) }))
        });
    }
    return { bookName, data, origEntry };
}

export function addHistoryToSwipe(msgId, newLines) {
    if (!msgId) return false;
    const session = getCurrentSession();
    const msg = session.messages.find(m => m.id === msgId);
    if (!msg) return false;
    if (!msg.swipes) msg.swipes = [{ content: msg.content, reasoning: msg.reasoning }];
    const currentSwipe = msg.swipes[msg.swipeIndex || 0];
    if (!currentSwipe.historyLines) currentSwipe.historyLines = [];
    currentSwipe.historyLines.push(...newLines);
    saveSessionsToMetadata();
    
    const msgEl = document.querySelector(`.scp-msg[data-id="${msgId}"]`);
    if (msgEl) {
        let body = msgEl.querySelector('.scp-msg-body');
        if (body) {
            let histWrap = body.querySelector('.scp-msg-hist-wrap');
            if (!histWrap) {
                histWrap = document.createElement('div');
                histWrap.className = 'scp-msg-hist-wrap';
                body.appendChild(histWrap);
            }
            const dummyMsg = { appliedLines: currentSwipe.historyLines };
            const contentEl = document.createElement('div');
            contentEl.className = 'scp-msg-content scp-lb-history-content';
            contentEl.style.marginTop = '10px';
            contentEl.style.padding = '8px 12px';
            contentEl.style.background = 'var(--scp-accent-bg)';
            contentEl.style.border = '1px solid var(--scp-accent-dim)';
            contentEl.style.borderRadius = '6px';
            
            _renderLBHistoryContent(dummyMsg, contentEl);
            histWrap.innerHTML = '';
            histWrap.appendChild(contentEl);

            const swipeBar = body.querySelector('.scp-swipe-bar');
            if (swipeBar) body.insertBefore(histWrap, swipeBar);
            else body.appendChild(histWrap);
        }
    }
    return true;
}

export function logLBHistoryChanges(changes, statusStr, afterMsgId = null) {
    if (!changes || !changes.length) return;
    try {
        const session = getCurrentSession();
        const icons = { add: '✚', edit: '✎', patch: '✂', delete: '✕' };
        const statusIcon = statusStr === 'Accepted' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Accepted' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED (ignored)');

        const newLines = changes.map(c => {
            const act = (c.action || 'edit').toUpperCase();
            return `${statusIcon} **${actionText}**: ${icons[c.action] || '·'} ${act} "${escHtml(c.name || c.originalName || `Entry #${c.uid || '?'}`)}" in \`${escHtml(c.worldName || '?')}\``;
        });

        if (afterMsgId && addHistoryToSwipe(afterMsgId, newLines)) return;

        const histText = `**System Notification** — User interaction with proposed lorebook changes:\n${newLines.join('\n')}`;
        const histMsg = addMessage(session, 'system', histText, { isLBHistory: true, appliedLines: [...newLines] });
        _appendLBHistoryEl(histMsg);
    } catch (_) {}
}

export async function applyLBChanges(changes, afterMsgId = null) {
    console.log(`[${EXT_DISPLAY}] applyLBChanges: processing ${changes.length} change(s)`, JSON.parse(JSON.stringify(changes)));
    const bookCache = {};
    const successfulChanges =[];

    for (const change of changes) {
        let { bookName, data, origEntry } = await resolveLBChangeTarget(change);

        if (change.worldName && change.action !== 'delete') {
            const activeBooks = getActiveLorebookNames();
            
            if (!activeBooks.includes(change.worldName)) {
                await bindNewLorebookToCharacter(change.worldName);
                
                const resolved = await resolveLBChangeTarget(change);
                bookName = resolved.bookName;
                data = resolved.data;
                origEntry = resolved.origEntry;
            }
        }

        if (!data) {
            const msg = `Lorebook not found: "${change.worldName || '(empty)'}" — is it active in this chat?`;
            toastr.error(`[LB] ${msg}`, EXT_DISPLAY, { timeOut: 10000 });
            console.error(`[${EXT_DISPLAY}] applyLBChanges: ${msg}`, change);
            continue;
        }
        if (!bookName) {
            toastr.error(`[LB] Could not resolve book name for change: "${change.name || change.uid || '?'}"`, EXT_DISPLAY, { timeOut: 10000 });
            continue;
        }

if (change.action === 'add') {
const uids = Object.keys(data.entries).map(Number);
const newUid = uids.length ? Math.max(...uids) + 1 : 1;
const isOutlet = !!(change.outlet || change.outlet_name);
const outletName = (change.outlet_name || '').trim();

// FIXED: Only clear triggers if it's an outlet AND no triggers were explicitly provided
const addTriggers = isOutlet 
    ? (Array.isArray(change.triggers) && change.triggers.length > 0 ? change.triggers : [])
    : (Array.isArray(change.triggers) ? change.triggers : []);

const autoConstant = !isOutlet && addTriggers.length === 0 && change.constant !== false;

data.entries[newUid] = {
    uid: newUid,
    key: addTriggers,  // FIXED: Now preserves triggers even for outlets
    keysecondary: [],
    content: change.content || '',
    comment: change.name || '',
    disable: false,
    group: change.group || '',  // FIXED: Don't auto-set group to outlet name
    selective: false,
    constant: !isOutlet && (change.constant === true || autoConstant),
    position: isOutlet ? 7 : (change.position ?? 0),
    depth: 4,
    displayIndex: newUid,
    automation_id: outletName,  // This is the correct field for outlet name
    outletName: outletName,     // Backup field
    outlet: isOutlet,  // Boolean flag only — the NAME lives in automation_id/outletName, never here
    
    order: change.order ?? 100,
    probability: change.probability ?? 100,
    groupWeight: change.groupWeight ?? 100,
    useProbability: true,
    addMemo: true,
    groupOverride: false,
    prevent_recursion: false,
    delayUntilRecursion: false,
    scan_depth: null,
    match_whole_words: null,
    use_group_scoring: false,
    case_sensitive: null,
    role: null,
    vectorized: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    excludeRecursion: false,
    ignoreBudget: false,
};

console.log(`[${EXT_DISPLAY}] applyLBChanges: ADD uid=${newUid} in "${bookName}" constant=${data.entries[newUid].constant} outlet=${isOutlet} triggers=${addTriggers.length}`);
bookCache[bookName] = data;
_wiCache[bookName] = data;
successfulChanges.push(change);
} else if (change.action === 'edit') {
            if (!origEntry) {
                const msg = `Entry not found for edit: "${change.name || change.uid || '?'}" in "${bookName}"`;
                toastr.error(`[LB] ${msg}`, EXT_DISPLAY, { timeOut: 10000 });
                console.error(`[${EXT_DISPLAY}] applyLBChanges: ${msg}. Available:`, Object.values(data.entries || {}).map(e => ({ uid: e.uid, comment: e.comment })));
                continue;
            }
            if (change.name !== undefined) origEntry.comment = change.name;
            if (change.triggers !== null && change.triggers !== undefined) {
                origEntry.key = change.triggers;
                if (change.triggers.length === 0 && origEntry.key.length === 0 && change.constant !== false) {
                    origEntry.constant = true;
                }
            }
            if (change.content !== undefined) origEntry.content = change.content;
            if (change.constant !== undefined) origEntry.constant = !!change.constant;
if (change.outlet!== undefined || change.outlet_name!== undefined) {
const eOutletName = (change.outlet_name || '').trim();
if (change.outlet || eOutletName) {
origEntry.position = 7;
origEntry.automation_id = eOutletName;
origEntry.outletName = eOutletName;
origEntry.outlet = true;  // Boolean flag only — name lives in automation_id/outletName above
origEntry.group = eOutletName;
origEntry.constant = false;
if (origEntry.extensions) origEntry.extensions.outlet_name = eOutletName;
else origEntry.extensions = { outlet_name: eOutletName };
} else {
origEntry.position = change.position?? 0;
origEntry.automation_id = '';
origEntry.outletName = '';
origEntry.outlet = false;
origEntry.group = '';
if (origEntry.extensions) origEntry.extensions.outlet_name = '';
}
}
            console.log(`[${EXT_DISPLAY}] applyLBChanges: EDIT uid=${origEntry.uid} in "${bookName}"`);
            bookCache[bookName] = data;
            _wiCache[bookName] = data;
            successfulChanges.push(change);
        } else if (change.action === 'patch') {
            if (!origEntry) {
                const msg = `Entry not found for patch: "${change.name || change.uid || '?'}" in "${bookName}"`;
                toastr.error(`[LB] ${msg}`, EXT_DISPLAY, { timeOut: 10000 });
                continue;
            }
            let current = origEntry.content || '';
            let allMatched = true;
            for (const patch of (change.patches || [])) {
                const { result, matched } = applySearchReplaceToField(current, patch.search || '', patch.replace || '');
                if (!matched) {
                    toastr.warning(`[LB] SEARCH not found in "${origEntry.comment}": "${(patch.search || '').slice(0, 60)}"`, EXT_DISPLAY, { timeOut: 8000 });
                    allMatched = false;
                    break;
                }
                current = result;
            }
            if (!allMatched) continue;
            origEntry.content = current;
            if (change.name !== undefined) origEntry.comment = change.name;
            if (change.triggers !== null && change.triggers !== undefined) {
                origEntry.key = change.triggers;
                if (change.triggers.length === 0 && change.constant !== false) origEntry.constant = true;
            }
            if (change.constant !== undefined) origEntry.constant = !!change.constant;
            console.log(`[${EXT_DISPLAY}] applyLBChanges: PATCH uid=${origEntry.uid} in "${bookName}"`);
            bookCache[bookName] = data;
            _wiCache[bookName] = data;
            successfulChanges.push(change);
        } else if (change.action === 'delete') {
            if (!origEntry) {
                toastr.warning(`[LB] Entry not found for delete: "${change.name || change.uid || '?'}" in "${bookName}"`, EXT_DISPLAY, { timeOut: 8000 });
                continue;
            }
            delete data.entries[origEntry.uid];
            console.log(`[${EXT_DISPLAY}] applyLBChanges: DELETE uid=${origEntry.uid} in "${bookName}"`);
            bookCache[bookName] = data;
            _wiCache[bookName] = data;
            successfulChanges.push(change);
        } else {
            toastr.warning(`[LB] Unknown action: "${change.action}"`, EXT_DISPLAY, { timeOut: 6000 });
        }
    }

    if (changes.length > 0 && !Object.keys(bookCache).length) {
        toastr.warning('[LB] No changes were applied — see browser console (F12) for details', EXT_DISPLAY, { timeOut: 10000 });
        return;
    }

    for (const [name, data] of Object.entries(bookCache)) {
        try {
            await saveWorldInfoBook(name, data);
            console.log(`[${EXT_DISPLAY}] applyLBChanges: saved "${name}" OK`);
        } catch (e) {
            toastr.error(`[LB] Save failed for "${name}": ${e.message}`, EXT_DISPLAY, { timeOut: 12000 });
            console.error(`[${EXT_DISPLAY}] applyLBChanges: save error for "${name}":`, e);
        }
    }

    if (successfulChanges.length > 0) {
        recordStat(STAT.lb, successfulChanges.length);
        logLBHistoryChanges(successfulChanges, 'Accepted', afterMsgId);
    }
}
