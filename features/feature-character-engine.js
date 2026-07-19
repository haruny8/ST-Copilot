/**
 * feature-character-engine.js
 * The biggest single feature: lets the LLM propose and apply structured
 * edits to a character card (description, personality, tags, greetings,
 * etc.) and full character *creation*, driven by XML-ish change blocks
 * parsed out of the AI's reply. Covers: building the AI's editing
 * instructions/context, parsing char-changes / char-create blocks from
 * text, search-replace patching of card fields, applying changes to the
 * actual ST character object, and rendering the proposal/creation review
 * cards in chat.
 *
 * Moved from original index.js "Character Card Editing Engine" section
 * (lines 1227-2616, 1390 lines — the largest section in the file).
 *
 * NOTE: this section originally sat directly above an unlabeled block (old
 * lines 2617-3110) containing lorebook-change-application logic
 * (`parseLBChangesFromText`, `applyLBChanges`, `addHistoryToSwipe`, etc.).
 * That's a different feature (Lorebook Engine) that happened to be
 * physically adjacent — it is NOT included here, and belongs in
 * `feature-lorebook-engine.js` in a future pass.
 *
 * `renderMsgBodyContent` turned out to live in what's now `ui/ui-chat.js`,
 * so it's imported directly (creates an import cycle with that module —
 * safe since it's only called from inside function bodies).
 */

import { EXT_DISPLAY, ICONS } from '../constants.js';
import { dbgAdd } from '../utils/util-debug.js';
import { repairJSON } from '../utils/util-text.js';
import { escHtml } from '../utils/util-dom.js';
import { getUserPersona, getAuthorsNote, getTagsForCharacter } from '../utils/util-st.js';
import { getSettings, saveSettings } from '../settings.js';
import { getCurrentSession, addMessage, saveSessionsToMetadata } from '../session.js';
import { DEFAULT_CHAR_EDIT_DIRECTIVE, DEFAULT_CHAT_EDIT_DIRECTIVE, CHAR_EDIT_FORMAT_BLOCK, CHAR_CREATE_FORMAT_BLOCK, CHAT_EDIT_FORMAT_BLOCK } from '../default-prompts.js';
import { addHistoryToSwipe as _addHistoryToSwipe } from './feature-lorebook-engine.js';
import { appendLBHistoryEl as _appendLBHistoryEl, openTextDiffModal as _openTextDiffModal } from './feature-chatedit-engine.js';
import { renderMsgBodyContent as _renderMsgBodyContent } from '../ui/ui-chat.js';

// Local shorthand alias for the ICONS constant (same pattern as
// ui-widgets.js) — used by the proposal/creation card renderers below.
// Bug found via static analysis: this file used `I.x` etc. in four places
// but never defined or imported it.
const I = ICONS;

export function getEffectiveCharField(settings, k) {
    const ovKey = 'charField_' + k;
    if (settings[ovKey] !== undefined) return settings[ovKey];
    return !!(settings.charEditFields || {})[k];
}

export function buildAltGreetingsPicker(container, isOverride = false) {
    if (!container) return;
    container.innerHTML = '';
    
    const s = getSettings();
    if (!s.charEditFields) s.charEditFields = {};
    
    if (Array.isArray(s.altGreetingIndices)) s.altGreetingIndices = {};
    if (!s.altGreetingIndices) s.altGreetingIndices = {};
    
    const ctx = SillyTavern.getContext();
    const charId = ctx.characterId || 'unknown';
    const char = ctx.characters?.[charId];
    const greetings = char?.data?.alternate_greetings || [];

    let isEnabled = false;
    if (isOverride) {
        const sess = getCurrentSession();
        if (sess && sess.overrides && sess.overrides.charField_alternate_greetings !== undefined) {
            isEnabled = sess.overrides.charField_alternate_greetings;
        } else {
            isEnabled = !!s.charEditFields.alternate_greetings;
        }
    } else {
        isEnabled = !!s.charEditFields.alternate_greetings;
    }

    if (!isEnabled) { container.style.display = 'none'; return; }

    if (!greetings.length) {
        container.innerHTML = '<div style="font-size:11px;color:var(--scp-text-muted);font-style:italic;padding:4px">No alternate greetings found for current character.</div>';
        container.style.display = '';
        return;
    }

    let targetArray = [];
    if (isOverride) {
        const sess = getCurrentSession();
        if (sess?.overrides?.altGreetingIndices && sess.overrides.altGreetingIndices[charId]) {
            targetArray = sess.overrides.altGreetingIndices[charId];
        } else {
            targetArray = s.altGreetingIndices[charId] || [];
        }
    } else {
        targetArray = s.altGreetingIndices[charId] || [];
    }

    const label = document.createElement('div');
    label.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--scp-text-muted,#72728a);margin-bottom:5px';
    label.textContent = 'Which greetings to include:';
    container.appendChild(label);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;max-height:120px;overflow-y:auto;padding:4px;background:rgba(0,0,0,.15);border-radius:6px;border:1px solid rgba(255,255,255,.06)';

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.style.cssText = 'font-size:10px;cursor:pointer;background:none;border:1px solid rgba(255,255,255,.1);border-radius:4px;color:var(--scp-text-muted,#888);padding:2px 8px;align-self:flex-start;margin-bottom:3px;font-family:inherit';
    allBtn.textContent = targetArray.length === greetings.length ? 'Deselect All' : 'Select All';
    
    allBtn.addEventListener('click', () => {
        const isAll = targetArray.length === greetings.length;
        const newArray = isAll ? [] : greetings.map((_, i) => i);
        if (isOverride) {
            const sess = getCurrentSession();
            if (!sess.overrides) sess.overrides = {};
            if (!sess.overrides.altGreetingIndices) sess.overrides.altGreetingIndices = {};
            sess.overrides.altGreetingIndices[charId] = newArray;
        } else {
            getSettings().altGreetingIndices[charId] = newArray;
        }
        saveSettings(); buildAltGreetingsPicker(container, isOverride);
    });
    wrap.appendChild(allBtn);

    greetings.forEach((greeting, idx) => {
        const isSelected = targetArray.includes(idx);
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;cursor:pointer;padding:3px 4px;border-radius:4px;transition:background .12s';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,.04)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });

        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = isSelected; cb.style.cssText = 'flex-shrink:0;margin-top:2px;accent-color:var(--scp-accent,#7c6dfa)';
        cb.addEventListener('change', () => {
            let currentArr = [...targetArray];
            if (cb.checked) { if (!currentArr.includes(idx)) currentArr.push(idx); }
            else currentArr = currentArr.filter(i => i !== idx);
            currentArr.sort((a, b) => a - b);
            
            if (isOverride) {
                const sess = getCurrentSession();
                if (!sess.overrides) sess.overrides = {};
                if (!sess.overrides.altGreetingIndices) sess.overrides.altGreetingIndices = {};
                sess.overrides.altGreetingIndices[charId] = currentArr;
            } else {
                getSettings().altGreetingIndices[charId] = currentArr;
            }
            
            saveSettings();
            allBtn.textContent = currentArr.length === greetings.length ? 'Deselect All' : 'Select All';
            targetArray = currentArr;
        });

        const text = document.createElement('span');
        text.style.cssText = 'font-size:11px;color:var(--scp-text,#e2e2e6);line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical';
        text.textContent = `#${idx + 1}: ${(greeting || '').slice(0, 80)}${greeting?.length > 80 ? '…' : ''}`;

        row.appendChild(cb); row.appendChild(text); wrap.appendChild(row);
    });
    container.appendChild(wrap); container.style.display = '';
}

export function refreshAltGreetingsPickers() {
    buildAltGreetingsPicker(document.getElementById('scp-ce-alt-greetings-picker'), false);
    buildAltGreetingsPicker(document.getElementById('scp-sp-ce-alt-greetings-picker'), false);
    buildAltGreetingsPicker(document.getElementById('scp-sp-ov-ce-alt-greetings-picker'), true);
}

export function buildCharacterContextBlock(settings) {
    const ctx = SillyTavern.getContext();
    const charId = ctx.characterId || 'unknown';
    const char = ctx.characters?.[charId];
    if (!char) return '';
    const d = char.data || {};
    const parts = [];

    const charTags = getTagsForCharacter(char);
    if (getEffectiveCharField(settings, 'tags') && charTags.length) {
        parts.push(`<tags>\n${charTags.join(', ')}\n</tags>`);
    }

    const simple = {
        description: d.description || char.description,
        personality: d.personality || char.personality,
        scenario: d.scenario || char.scenario,
        first_mes: d.first_mes || char.first_mes,
        mes_example: d.mes_example || char.mes_example,
    };
    for (const [key, val] of Object.entries(simple)) {
        if (getEffectiveCharField(settings, key) && val) parts.push(`<${key}>\n${val}\n</${key}>`);
    }
    if (getEffectiveCharField(settings, 'alternate_greetings') && Array.isArray(d.alternate_greetings) && d.alternate_greetings.length) {
        const agMap = settings.altGreetingIndices || {};
        const indices = Array.isArray(agMap[charId]) ? agMap[charId] : d.alternate_greetings.map((_, i) => i);
        const filtered = indices.filter(i => i >= 0 && i < d.alternate_greetings.length);
        
        if (filtered.length) {
            const gs = filtered.map(i => `  <greeting id="${i+1}">\n${d.alternate_greetings[i]}\n  </greeting>`).join('\n');
            parts.push(`<alternate_greetings>\n${gs}\n</alternate_greetings>`);
        }
    }
    if (getEffectiveCharField(settings, 'authors_note')) {
        const an = getAuthorsNote();
        if (an) parts.push(`<authors_note>\n${an}\n</authors_note>`);
    }
    return parts.join('\n\n');
}

export function buildCharEditAIInstructions(settings) {
    if (!settings.charEditAIEnabled) return '';
    const baseFields = ['tags', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'authors_note', 'alternate_greetings'];
    const fieldsList = baseFields.filter(k => getEffectiveCharField(settings, k));
    
    if (settings.includeUserPersonality && !fieldsList.includes('user_persona')) {
        fieldsList.push('user_persona');
    }
    const enabledFields = fieldsList.join(', ') || 'all fields';
    const base = (settings.charEditPrompt || DEFAULT_CHAR_EDIT_DIRECTIVE.trim())
        .replace('{{char_edit_fields}}', enabledFields)
        .replace('{{char_edit_format}}', CHAR_EDIT_FORMAT_BLOCK)
        .replace('{{char_create_format}}', CHAR_CREATE_FORMAT_BLOCK);
    return `<character_management>\n${base}\n</character_management>`;
}

export function buildChatEditAIInstructions(settings) {
    if (!settings.chatEditAIEnabled) return '';
    const ctx = SillyTavern.getContext();
    const stMsgs = ctx.chat || [];
    const depth = Math.max(0, parseInt(settings.contextDepth) || 0);
    let slice;
    try {
        const sess = getCurrentSession();
        const picked = sess.pickedChatIndices;
        if (picked && picked.length > 0) {
            slice = picked.filter(i => i >= 0 && i < stMsgs.length);
        } else {
            slice = depth > 0 ? stMsgs.slice(-depth).map((_, i) => stMsgs.length - depth + i) : [];
        }
    } catch(_) {
        slice = depth > 0 ? stMsgs.slice(-depth).map((_, i) => stMsgs.length - depth + i) : [];
    }
    const activeChatIds = slice.map(i => `#${i}`).join(', ') || 'none';
    const base = (settings.chatEditPrompt || DEFAULT_CHAT_EDIT_DIRECTIVE.trim())
        .replace('{{chat_edit_format}}', CHAT_EDIT_FORMAT_BLOCK)
        .replace('{{active_chat_ids}}', activeChatIds);
    return `<chat_messages_editing>\n${base}\n</chat_messages_editing>`;
}

export function _sanitizeProposedTags(value) {
    if (typeof value !== 'string') return '';
    let cleaned = value.trim();
    
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            return parsed.map(t => String(t).trim()).filter(Boolean).join(', ');
        }
        if (typeof parsed === 'string') {
            cleaned = parsed.trim();
        }
    } catch (_) {}

    cleaned = cleaned.replace(/^\[\s*|\]\s*$/g, '').trim();

    const quotedMatches = [...cleaned.matchAll(/["']([^"']+)["']/g)].map(m => m[1].trim());
    if (quotedMatches.length > 0) {
        return quotedMatches.filter(Boolean).join(', ');
    }

    return cleaned.split(',')
        .map(item => item.replace(/[\[\]"']/g, '').trim())
        .filter(Boolean)
        .join(', ');
}

export function parseCharChangesFromText(text) {
    let raw = null;
    const strict = text.match(/```character-changes\s*([\s\S]*?)```/);
    if (strict) {
        raw = strict[1];
    } else {
        const open = text.match(/```character-changes\s*([\s\S]*?)(?=```|$)/);
        if (open) raw = open[1];
    }
    if (!raw) return null;
    const xml = _repairCharChangesXML(raw);
    const changes = [];
    let m;

    const replaceByField = {};
    const replaceRe = /<replace\s+field="([^"]+)"(?:\s+index="(\d+)")?>([\s\S]*?)<\/replace>/g;
    while ((m = replaceRe.exec(xml)) !== null) {
        const field = m[1];
        const index = m[2] ? parseInt(m[2]) : undefined;
        const content = m[3];
        const key = field + (index !== undefined ? `_${index}` : '');
        
        const diffRe = /<<<<<<< (?:SEARCH|ANCHOR)\r?\n([\s\S]*?)\r?\n=+\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
        let diffMatch;
        const patches = [];
        while ((diffMatch = diffRe.exec(content)) !== null) {
            let searchVal = diffMatch[1];
            let replaceVal = diffMatch[2];
            if (field === 'tags') {
                searchVal = _sanitizeProposedTags(searchVal);
                replaceVal = _sanitizeProposedTags(replaceVal);
            }
            patches.push({ search: searchVal, replace: replaceVal });
        }
        if (!patches.length) {
            const searchOnly = content.match(/<<<<<<< (?:SEARCH|ANCHOR)\r?\n([\s\S]*?)\r?\n=+/);
            if (searchOnly) {
                let searchVal = searchOnly[1];
                if (field === 'tags') searchVal = _sanitizeProposedTags(searchVal);
                patches.push({ search: searchVal, replace: '' });
            }
        }
        if (!patches.length) continue;
        if (!replaceByField[key]) {
            const item = { field, action: 'replace', patches };
            if (index !== undefined) item.index = index;
            replaceByField[key] = item;
        } else {
            replaceByField[key].patches.push(...patches);
        }
    }
    for (const item of Object.values(replaceByField)) changes.push(item);

    const overwriteRe = /<overwrite\s+field="([^"]+)"(?:\s+index="(\d+)")?>([\s\S]*?)<\/overwrite>/g;
    while ((m = overwriteRe.exec(xml)) !== null) {
        let val = m[3].trim();
        if (m[1] === 'tags') val = _sanitizeProposedTags(val);
        const item = { field: m[1], action: 'overwrite', value: val };
        if (m[2]) item.index = parseInt(m[2], 10);
        changes.push(item);
    }

    const appendRe = /<append\s+field="([^"]+)">([\s\S]*?)<\/append>/g;
    while ((m = appendRe.exec(xml)) !== null) {
        let val = m[2].trim();
        if (m[1] === 'tags') val = _sanitizeProposedTags(val);
        changes.push({ field: m[1], action: 'append', value: val });
    }

    const prependRe = /<prepend\s+field="([^"]+)"(?:\s+index="(\d+)")?>([\s\S]*?)<\/prepend>/g;
    while ((m = prependRe.exec(xml)) !== null) {
        let val = m[3].trim();
        if (m[1] === 'tags') val = _sanitizeProposedTags(val);
        const item = { field: m[1], action: 'prepend', value: val };
        if (m[2]) item.index = parseInt(m[2], 10);
        changes.push(item);
    }

    const appendTextRe = /<append_text\s+field="([^"]+)"(?:\s+index="(\d+)")?>([\s\S]*?)<\/append_text>/g;
    while ((m = appendTextRe.exec(xml)) !== null) {
        let val = m[3].trim();
        if (m[1] === 'tags') val = _sanitizeProposedTags(val);
        const item = { field: m[1], action: 'append_text', value: val };
        if (m[2]) item.index = parseInt(m[2], 10);
        changes.push(item);
    }

    return changes.length ? changes : null;
}

export function _repairCharChangesXML(raw) {
    let s = raw;
    const TAGS = ['replace', 'overwrite', 'append_text', 'append', 'prepend'];

    for (const tag of TAGS) {
        const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g');
        const closeRe = new RegExp(`</${tag}>`, 'g');
        const parts = [];
        let lastIdx = 0;
        let openMatch;
        openRe.lastIndex = 0;
        const opens = [];
        while ((openMatch = openRe.exec(s)) !== null) opens.push(openMatch.index);

        if (opens.length === 0) continue;
        const closes = [];
        let cm;
        closeRe.lastIndex = 0;
        while ((cm = closeRe.exec(s)) !== null) closes.push(cm.index);

        if (opens.length <= closes.length) continue;

        const result = [];
        let cursor = 0;
        for (let i = 0; i < opens.length; i++) {
            const openStart = opens[i];
            const nextOpen = opens[i + 1] ?? Infinity;
            const closeAfterOpen = closes.find(ci => ci > openStart && ci < nextOpen);
            if (closeAfterOpen === undefined) {
                const insertAt = nextOpen === Infinity ? s.length : nextOpen;
                s = s.slice(0, insertAt) + `</${tag}>` + s.slice(insertAt);
                const shift = tag.length + 3;
                for (let j = i + 1; j < opens.length; j++) opens[j] += shift;
                for (let j = 0; j < closes.length; j++) { if (closes[j] >= insertAt) closes[j] += shift; }
                closes.push(insertAt);
                closes.sort((a, b) => a - b);
            }
        }
    }

    s = s.replace(/(<<<<<<< (?:SEARCH|ANCHOR)\r?\n[\s\S]*?)(?=<<<<<<< (?:SEARCH|ANCHOR)|$)/g, (m) => {
        if (!/=+\r?\n/.test(m) && !m.includes('=======')) return m + '\n=======\n>>>>>>> REPLACE\n';
        if (!m.includes('>>>>>>> REPLACE')) return m + '\n>>>>>>> REPLACE\n';
        return m;
    });

    return s;
}

export function stripCharChangesBlock(text) {
    return text
        .replace(/```character-changes[\s\S]*?```/g, '')
        .replace(/```character-changes[\s\S]*/g, '')
        .trim();
}

export function parseCharCreationFromText(text) {
    let raw = null;
    const strict = text.match(/```character-create\s*([\s\S]*?)```/);
    if (strict) {
        raw = strict[1].trim();
    } else {
        const open = text.match(/```character-create\s*([\s\S]*?)(?=```|$)/);
        if (open) raw = open[1].trim();
    }
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (typeof data !== 'object' || Array.isArray(data)) return null;
        if (data.tags) {
            data.tags = _sanitizeProposedTags(Array.isArray(data.tags) ? JSON.stringify(data.tags) : String(data.tags));
        }
        return data;
    } catch (_) {}
    try {
        const data = JSON.parse(repairJSON(raw));
        if (typeof data !== 'object' || Array.isArray(data)) return null;
        if (data.tags) {
            data.tags = _sanitizeProposedTags(Array.isArray(data.tags) ? JSON.stringify(data.tags) : String(data.tags));
        }
        return data;
    } catch (_) { return null; }
}

export function stripCharCreationBlock(text) {
    return text
        .replace(/```character-create[\s\S]*?```/g, '')
        .replace(/```character-create[\s\S]*/g, '')
        .trim();
}

export function normalizeCharNamesInBlock(text) {
    return text;
}

export function applySearchReplaceToField(fieldContent, searchText, replaceText) {
    if (!fieldContent) return { result: replaceText || '', matched: true };
    const src = fieldContent;
    const srch = searchText || '';
    const repl = replaceText || '';

    const createFuzzyRegex = (str) => {
        const tokens = str.trim().split(/[\s\-—_~*]+/);
        const regexParts = tokens.map(token => {
            if (!token) return '';
            let t = token.replace(/['"“”‘’`]/g, '"');
            t = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            t = t.replace(/"/g, '[\'\\"“”‘’`]?');
            return t;
        }).filter(Boolean);
        return new RegExp(regexParts.join('(?:\\s|<[^>]+>|[\\*\\_\\~\\-.,;!?"\'\`])*'), 'i'); 
    };

    let sepIdx = srch.indexOf(' || ');
    let sepLen = 4;
    if (sepIdx === -1) { sepIdx = srch.indexOf('||'); sepLen = 2; }
    if (sepIdx === -1) { sepIdx = srch.indexOf('...'); sepLen = 3; }

    if (sepIdx !== -1 && sepIdx > 0 && srch.length - sepIdx - sepLen > 0) {
        const startPart = srch.slice(0, sepIdx).trim();
        const endPart = srch.slice(sepIdx + sepLen).trim();
        
        if (startPart && endPart) {
            try {
                const sRegex = createFuzzyRegex(startPart);
                const eRegex = createFuzzyRegex(endPart);
                
                const sMatch = src.match(sRegex);
                if (sMatch) {
                    const remainingSrc = src.slice(sMatch.index + sMatch[0].length);
                    const eMatch = remainingSrc.match(eRegex);
                    if (eMatch) {
                        const absoluteEnd = sMatch.index + sMatch[0].length + eMatch.index + eMatch[0].length;
                        return {
                            result: src.slice(0, sMatch.index) + repl + src.slice(absoluteEnd),
                            matched: true
                        };
                    }
                }
            } catch(e) { console.warn("[ST-Copilot] Fuzzy regex error:", e); }
        }
    }

    if (srch.trim()) {
        try {
            const fullRegex = createFuzzyRegex(srch);
            const fullMatch = src.match(fullRegex);
            if (fullMatch) {
                return {
                    result: src.slice(0, fullMatch.index) + repl + src.slice(fullMatch.index + fullMatch[0].length),
                    matched: true
                };
            }
        } catch(e) { console.warn("[ST-Copilot] Fuzzy regex error:", e); }
    }

    const idx = src.indexOf(srch);
    if (idx !== -1) return { result: src.slice(0, idx) + repl + src.slice(idx + srch.length), matched: true };

    return { result: src, matched: false };
}

export function getCharFieldValue(char, fieldId) {
    if (fieldId === 'user_persona') return getUserPersona();
    if (fieldId === 'tags') return getTagsForCharacter(char).join(', ');
    
    const d = char.data || {};
    if (fieldId === 'authors_note') return getAuthorsNote();
    if (fieldId === 'alternate_greetings') return d.alternate_greetings || [];
    return d[fieldId] || char[fieldId] || '';
}

export async function saveCharacterField(char, fieldId, newValue) {
    const ctx = SillyTavern.getContext();
    
    if (fieldId === 'user_persona') {
        const pu = window.power_user || ctx.powerUserSettings || {};
        const avatar = pu.persona;
        if (avatar) {
            try {
                const res = await fetch('/api/characters/merge-attributes', {
                    method: 'POST',
                    headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ avatar: avatar, data: { description: newValue }, is_persona: true })
                });
                if (res.ok) {
                    if (pu.personas && pu.personas[avatar]) pu.personas[avatar].description = newValue;
                    return;
                }
            } catch(e) { console.warn("Failed to merge persona API:", e); }
        }
        if (pu.personas && pu.persona && pu.personas[pu.persona]) pu.personas[pu.persona].description = newValue;
        else pu.persona_description = newValue;
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        return;
    }

    if (fieldId === 'authors_note') {
        ctx.chatMetadata = ctx.chatMetadata || {};
        ctx.chatMetadata.note_prompt = newValue;
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
        else saveSettings();
        return;
    }

    if (fieldId === 'tags') {
        const newTagsNames = typeof newValue === 'string' 
            ? newValue.split(',').map(t => t.trim()).filter(Boolean) 
            : (Array.isArray(newValue) ? newValue : []);
        
        const avatar = char.avatar;
        
        if (ctx.tagMap && ctx.tags) {
            const currentTagIds = ctx.tagMap[avatar] || [];
            const toUnlink = currentTagIds.filter(id => {
                const tagObj = ctx.tags.find(t => t.id === id);
                if (!tagObj) return false;
                return !newTagsNames.some(n => n.toLowerCase() === tagObj.name.toLowerCase());
            });

            if (toUnlink.length > 0) {
                ctx.tagMap[avatar] = currentTagIds.filter(id => !toUnlink.includes(id));
                if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
                else if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
            }
        }
        
        if (!char.data) char.data = {};
        char.data.tags = newTagsNames;
        char.tags = newTagsNames;
        
        const payload = {
            avatar_url: avatar,
            ch_name: char.name || 'Unknown',
            field: 'tags',
            value: newTagsNames
        };
        
        try {
            const res = await fetch('/api/characters/edit-attribute', {
                method: 'POST',
                headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) console.warn("[ST-Copilot] Tags edit-attribute failed:", res.status);
        } catch (e) { console.warn("[ST-Copilot] Failed to edit tags API:", e); }

        if (typeof ctx.importTags === 'function') {
            try {
                await ctx.importTags(char, { importSetting: 3 }); 
            } catch(e) { console.warn("[ST-Copilot] Failed to import tags via core context:", e); }
        }

        const es = ctx.eventSource || window.eventSource;
        const et = ctx.event_types || window.event_types;
        if (es && et?.CHARACTER_EDITED) {
            es.emit(et.CHARACTER_EDITED, { detail: { id: ctx.characterId, character: char } });
            es.emit(et.CHARACTER_EDITED, { id: ctx.characterId, character: char });
        }
        return;
    }
    
    if (!char.data) char.data = {};
    
    const payload = { 
        avatar_url: char.avatar, 
        ch_name: char.name || 'Unknown',
        field: fieldId,
        value: newValue 
    };

    if (fieldId === 'alternate_greetings') {
        char.data.alternate_greetings = newValue;
    } else {
        char.data[fieldId] = newValue;
        char[fieldId] = newValue;
    }
    
    const res = await fetch('/api/characters/edit-attribute', {
        method: 'POST',
        headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const domMap = {
        description: 'description_textarea',
        personality: 'personality_textarea',
        scenario: 'scenario_pole',
        first_mes: 'firstmessage_textarea',
        mes_example: 'mes_example_textarea'
    };

    if (domMap[fieldId]) {
        const el = document.getElementById(domMap[fieldId]);
        if (el) {
            el.value = newValue;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } else if (fieldId === 'alternate_greetings') {
        if (typeof window.printAlternateGreetings === 'function') {
            window.printAlternateGreetings();
        }
    }

    const es = ctx.eventSource || window.eventSource;
    const et = ctx.event_types || window.event_types;
    if (es && et?.CHARACTER_EDITED) {
        es.emit(et.CHARACTER_EDITED, { detail: { id: ctx.characterId, character: char } });
        es.emit(et.CHARACTER_EDITED, { id: ctx.characterId, character: char });
    }
}

export async function applyCharChanges(changes, afterMsgId = null) {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    if (!char) { toastr.error('[CharEdit] No active character.', EXT_DISPLAY); return; }
    const successLog = [];

    for (const change of changes) {
        const { field, action } = change;
        if (!field) continue;
        try {
            if (field === 'alternate_greetings') {
                const greetings = [...(char.data?.alternate_greetings || [])];
                if (action === 'append') {
                    greetings.push(change.value || '');
                    await saveCharacterField(char, 'alternate_greetings', greetings);
                    successLog.push(change);
                } else {
                    const idx = (change.index || 1) - 1;
                    if (idx < 0 || idx >= greetings.length) { toastr.warning(`[CharEdit] Greeting index ${change.index} out of range.`, EXT_DISPLAY); continue; }
                    
                    if (action === 'overwrite') {
                        greetings[idx] = change.value || '';
                    } else if (action === 'prepend') {
                        greetings[idx] = (change.value || '') + (greetings[idx] ? '\n\n' + greetings[idx] : '');
                    } else if (action === 'append_text') {
                        greetings[idx] = (greetings[idx] ? greetings[idx] + '\n\n' : '') + (change.value || '');
                    } else if (action === 'replace') {
                        let current = greetings[idx];
                        let allMatched = true;
                        for (const patch of (change.patches || [])) {
                            const { result, matched } = applySearchReplaceToField(current, patch.search || '', patch.replace || '');
                            if (!matched) { toastr.warning(`[CharEdit] SEARCH not found in greeting #${change.index}.`, EXT_DISPLAY); allMatched = false; break; }
                            current = result;
                        }
                        if (!allMatched) continue;
                        greetings[idx] = current;
                    }
                    
                    await saveCharacterField(char, 'alternate_greetings', greetings);
                    successLog.push(change);
                }
            } else if (action === 'overwrite') {
                await saveCharacterField(char, field, change.value || '');
                successLog.push(change);
            } else if (action === 'prepend') {
                const current = String(getCharFieldValue(char, field));
                await saveCharacterField(char, field, change.value + (current ? '\n\n' + current : ''));
                successLog.push(change);
            } else if (action === 'append_text') {
                const current = String(getCharFieldValue(char, field));
                await saveCharacterField(char, field, (current ? current + '\n\n' : '') + change.value);
                successLog.push(change);
            } else if (action === 'replace') {
                let current = String(getCharFieldValue(char, field));
                let allMatched = true;
                for (const patch of (change.patches || [])) {
                    const { result, matched } = applySearchReplaceToField(current, patch.search || '', patch.replace || '');
                    if (!matched) { toastr.warning(`[CharEdit] SEARCH not found in field "${field}": "${(patch.search || '').slice(0, 60)}…"`, EXT_DISPLAY, { timeOut: 8000 }); allMatched = false; break; }
                    current = result;
                }
                if (!allMatched) continue;
                await saveCharacterField(char, field, current);
                successLog.push(change);
            }
        } catch (e) {
            console.error(`[ST-Copilot-Debug] Failed on char field "${field}":`, e);
            toastr.error(`[CharEdit] Failed on "${field}": ${e.message}`, EXT_DISPLAY, { timeOut: 10000 });
        }
    }

    if (successLog.length > 0) {
        logCharEditHistory(successLog, 'Applied', afterMsgId);
        toastr.success(`[CharEdit] ${successLog.length} change(s) applied.`, EXT_DISPLAY);
    }
}

export function logCharEditHistory(changes, statusStr, afterMsgId = null) {
    if (!changes?.length) return;
    try {
        const FIELD_LABELS = { tags:'Tags', description:'Description', personality:'Personality', scenario:'Scenario', first_mes:'First Message', mes_example:'Example Dialogue', authors_note:"Author's Note", user_persona:"User Persona", alternate_greetings:'Alternate Greetings' };
        const session = getCurrentSession();
        const icon = statusStr === 'Applied' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Applied' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED (ignored)');
        
        const newLines = changes.map(c => {
            const patches = c.patches ? ` (${c.patches.length} patch${c.patches.length !== 1 ? 'es' : ''})` : '';
            return `${icon} **${actionText}**: \`${escHtml(FIELD_LABELS[c.field] || c.field || '?')}\` — ${escHtml(c.action || '?')}${c.index ? ` #${c.index}` : ''}${patches}`;
        });

        if (afterMsgId && _addHistoryToSwipe(afterMsgId, newLines)) return;

        const histText = `**System Notification** — Character card edits:\n${newLines.join('\n')}`;
        const msg = addMessage(session, 'system', histText, { isCharEditHistory: true, isLBHistory: true, appliedLines: [...newLines] });
        _appendLBHistoryEl(msg);
    } catch (_) {}
}

export function logCharCreationHistory(creationData, statusStr, afterMsgId = null) {
    try {
        const session = getCurrentSession();
        const icon = statusStr === 'Applied' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Applied' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED (ignored)');
        const newLines = [`${icon} **${actionText}**: Character Creation Proposal for "${escHtml(creationData.name_suggestion || 'New Character')}"`];
        
        if (afterMsgId && _addHistoryToSwipe(afterMsgId, newLines)) return;

        const histText = `**System Notification** — Character card edits:\n${newLines.join('\n')}`;
        const msg = addMessage(session, 'system', histText, { isCharEditHistory: true, isLBHistory: true, appliedLines: [...newLines] });
        _appendLBHistoryEl(msg);
    } catch (_) {}
}

export function reconstructCharChangesBlock(pendingChanges) {
    if (!pendingChanges.length) return '';
    let xml = '```character-changes\n';
    for (const c of pendingChanges) {
        if (c.action === 'replace') {
            xml += `<replace field="${c.field}"${c.index ? ` index="${c.index}"` : ''}>\n`;
            for (const p of c.patches) {
                xml += `<<<<<<< SEARCH\n${p.search}\n=======\n${p.replace}\n>>>>>>> REPLACE\n`;
            }
            xml += `</replace>\n`;
        } else if (c.action === 'overwrite') {
            xml += `<overwrite field="${c.field}"${c.index ? ` index="${c.index}"` : ''}>${c.value}</overwrite>\n`;
        } else if (c.action === 'append') {
            xml += `<append field="${c.field}">${c.value}</append>\n`;
        } else if (c.action === 'prepend') {
            xml += `<prepend field="${c.field}"${c.index ? ` index="${c.index}"` : ''}>${c.value}</prepend>\n`;
        } else if (c.action === 'append_text') {
            xml += `<append_text field="${c.field}"${c.index ? ` index="${c.index}"` : ''}>${c.value}</append_text>\n`;
        }
    }
    xml += '```';
    return xml;
}

export async function createCharacterAPI(data) {
    const ctx = SillyTavern.getContext();
    
    dbgAdd('CHAR_CREATE_START', { data });

    const tagsString = Array.isArray(data.tags) 
        ? data.tags.join(', ') 
        : (typeof data.tags === 'string' ? data.tags : '');

    const formData = new FormData();
    formData.append('ch_name', data.name || 'New Character');
    formData.append('description', data.description || '');
    formData.append('personality', data.personality || '');
    formData.append('scenario', data.scenario || '');
    formData.append('first_mes', data.first_mes || '');
    formData.append('mes_example', data.mes_example || '');
    formData.append('tags', tagsString);

    const headers = ctx.getRequestHeaders();
    delete headers['Content-Type'];
    
    let res;
    try {
        res = await fetch('/api/characters/create', {
            method: 'POST',
            headers,
            body: formData,
            cache: 'no-cache',
        });
    } catch (err) {
        console.error('[ST-Copilot-Debug] Network error during character post:', err);
        dbgAdd('CHAR_CREATE_NET_ERR', { error: err.message, stack: err.stack });
        throw err;
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        console.error(`[ST-Copilot-Debug] API returned HTTP Error ${res.status}: ${errText}`);
        dbgAdd('CHAR_CREATE_HTTP_ERR', { status: res.status, text: errText });
        throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const newAvatar = await res.text();
    dbgAdd('CHAR_CREATE_SERVER_OK', { avatar: newAvatar });

    await new Promise(r => setTimeout(r, 400));

    try {
        if (typeof ctx.getCharacters === 'function') {
            await ctx.getCharacters();
        } else if (typeof window.getCharacters === 'function') {
            await window.getCharacters();
        }
    } catch(e) {
        console.warn('[ST-Copilot-Debug] Failed to reload list of characters:', e);
        dbgAdd('CHAR_CREATE_RELOAD_ERR', { error: e.message });
    }

    const chars = ctx.characters || window.characters || [];
    
    const foundChar = chars.find(c => c.avatar === newAvatar);
    if (foundChar) {
        dbgAdd('CHAR_CREATE_CACHE_FOUND', { name: foundChar.name, tags: foundChar.tags });

        if (typeof ctx.importTags === 'function') {
            try {
                const importResult = await ctx.importTags(foundChar, { importSetting: 3 });
                dbgAdd('CHAR_CREATE_IMPORT_TAGS_DONE', { result: importResult });
            } catch (importErr) {
                console.error('[ST-Copilot-Debug] Exception inside importTags():', importErr);
                dbgAdd('CHAR_CREATE_IMPORT_TAGS_FAIL', { error: importErr.message, stack: importErr.stack });
            }
        } else {
            dbgAdd('CHAR_CREATE_IMPORT_TAGS_MISSING', { reason: 'ctx.importTags is not a function' });
        }
    } else {
        console.error(`[ST-Copilot-Debug] Character "${newAvatar}" is missing from ST cache!`);
        dbgAdd('CHAR_CREATE_CACHE_MISSING', { avatar: newAvatar });
    }

    try {
        if (typeof window.PrintCharacterList === 'function') {
            window.PrintCharacterList();
        }
        const es = ctx.eventSource || window.eventSource;
        const et = ctx.event_types || window.event_types;
        if (es && et?.CHARACTERS_UPDATED) {
            es.emit(et.CHARACTERS_UPDATED);
        }
    } catch(e) {
        console.warn('[ST-Copilot-Debug] UI redraw error:', e);
    }

    return true;
}

export function renderCharCreationCard(creationData, msgEl) {
    document.querySelector(`.scp-char-creation-card[data-for="${msgEl.dataset.id}"]`)?.remove();

    const editableData = {
        name: creationData.name_suggestion || '',
        description: creationData.description || '',
        personality: creationData.personality || '',
        scenario: creationData.scenario || '',
        first_mes: creationData.first_mes || '',
        mes_example: creationData.mes_example || '',
        tags: Array.isArray(creationData.tags) ? creationData.tags.join(', ') : (creationData.tags || ''),
    };

    const FIELDS = [
        { key: 'name',        label: 'Name',            multiline: false },
        { key: 'tags',        label: 'Tags',             multiline: false, hint: 'comma-separated' },
        { key: 'description', label: 'Description',      multiline: true, rows: 4 },
        { key: 'personality', label: 'Personality',      multiline: true, rows: 3 },
        { key: 'scenario',    label: 'Scenario',         multiline: true, rows: 3 },
        { key: 'first_mes',   label: 'First Message',    multiline: true, rows: 3 },
        { key: 'mes_example', label: 'Example Dialogue', multiline: true, rows: 3 },
    ];

    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card scp-char-creation-card';
    card.dataset.for = msgEl.dataset.id;

    const stripAndRemove = () => {
        const session = getCurrentSession();
        const msg = session.messages.find(m => m.id === card.dataset.for);
        if (msg) { 
            msg.content = stripCharCreationBlock(msg.content); 
            if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
            saveSessionsToMetadata(); 
        }
        card.remove();
    };

    const header = document.createElement('div');
    header.className = 'scp-lb-proposal-header';
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
    headerLeft.innerHTML = `<span class="scp-lb-proposal-icon" style="color:var(--scp-success);display:flex"><i class="fa-solid fa-user-plus"></i></span><span class="scp-lb-proposal-title">New Character Proposal</span>`;
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'scp-lb-proposal-dismiss'; dismissBtn.innerHTML = I.x; dismissBtn.title = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
        logCharCreationHistory(editableData, 'Dismissed', card.dataset.for);
        stripAndRemove();
    });
    header.appendChild(headerLeft); header.appendChild(dismissBtn);
    card.appendChild(header);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:var(--scp-text-muted);padding:6px 2px 4px;font-style:italic';
    hint.textContent = 'Review and edit the proposed character. Name is required.';
    card.appendChild(hint);

    const fieldsWrap = document.createElement('div');
    fieldsWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:4px';
    const inputs = {};
    for (const f of FIELDS) {
        const row = document.createElement('div');
        row.className = 'scp-lb-pe-row';
        const lbl = document.createElement('label');
        lbl.className = 'scp-lb-pe-label';
        lbl.textContent = f.label + (f.key === 'name' ? ' *' : '');
        let inp;
        if (f.multiline) {
            inp = document.createElement('textarea');
            inp.rows = f.rows || 3;
            inp.className = 'scp-lb-pe-textarea';
            inp.style.minHeight = `${(f.rows || 3) * 20}px`;
        } else {
            inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'scp-lb-pe-input';
        }
        inp.value = editableData[f.key];
        inp.addEventListener('input', () => { editableData[f.key] = inp.value; });
        inputs[f.key] = inp;
        row.appendChild(lbl); row.appendChild(inp);
        fieldsWrap.appendChild(row);
    }
    card.appendChild(fieldsWrap);

    const footer = document.createElement('div');
    footer.className = 'scp-lb-proposal-footer';
    footer.style.marginTop = '10px';

    const createBtn = document.createElement('button');
    createBtn.className = 'scp-lb-proposal-apply';
    createBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Character';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'scp-lb-proposal-reject';
    cancelBtn.textContent = 'Cancel';

    createBtn.addEventListener('click', async () => {
        if (!editableData.name?.trim()) {
            toastr.warning('Character name is required.', EXT_DISPLAY);
            inputs.name.focus();
            return;
        }
        createBtn.disabled = true;
        createBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…';
        const session = getCurrentSession();
        const msgForStrip = session.messages.find(m => m.id === card.dataset.for);
        if (msgForStrip) { 
            msgForStrip.content = stripCharCreationBlock(msgForStrip.content); 
            if (msgForStrip.swipes) msgForStrip.swipes[msgForStrip.swipeIndex || 0].content = msgForStrip.content;
            saveSessionsToMetadata(); 
        }
        try {
            await createCharacterAPI(editableData);
            logCharCreationHistory(editableData, 'Applied', card.dataset.for);
            toastr.success(`Character "${escHtml(editableData.name)}" created!`, EXT_DISPLAY);
            card.remove();
        } catch (e) {
            console.error('[ST-Copilot-Debug] Character creation UI error:', e);
            toastr.error(`Failed: ${e.message}`, EXT_DISPLAY, { timeOut: 10000 });
            createBtn.disabled = false;
            createBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Character';
        }
    });
    cancelBtn.addEventListener('click', () => {
        logCharCreationHistory(editableData, 'Rejected', card.dataset.for);
        stripAndRemove();
    });

    footer.appendChild(createBtn); footer.appendChild(cancelBtn);
    card.appendChild(footer);
    card.style.margin = '8px 0 0 0';
    const bodyEl = msgEl.querySelector('.scp-msg-body');
    if (bodyEl) bodyEl.insertBefore(card, bodyEl.querySelector('.scp-swipe-bar'));
    else msgEl.after(card);
}

export function renderCharProposalCard(changes, msgEl) {
    if (!changes?.length) return;
    document.querySelector(`.scp-char-proposal-card[data-for="${msgEl.dataset.id}"]`)?.remove();

    const ctx = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    const editableChanges = changes.map(c => JSON.parse(JSON.stringify(c)));
    const itemStates = editableChanges.map(() => 'pending');

    const FIELD_LABELS = { description:'Description', personality:'Personality', scenario:'Scenario', first_mes:'First Message', mes_example:'Example Dialogue', authors_note:"Author's Note", user_persona:"User Persona", alternate_greetings:'Alternate Greetings' };

    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card scp-char-proposal-card';
    card.dataset.for = msgEl.dataset.id;
    card.style.margin = '8px 0 0 0';

    const syncBlockToMessage = () => {
        const session = getCurrentSession();
        const msg = session.messages.find(m => m.id === card.dataset.for);
        if (!msg) return;
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        const stripped = stripCharChangesBlock(msg.content);
        if (pending.length === 0) msg.content = stripped;
        else msg.content = stripped + '\n\n' + reconstructCharChangesBlock(pending);
        if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
        saveSessionsToMetadata();
    };

    const persistState = () => {};
    const getPending = () => itemStates.filter(s => s === 'pending').length;
    const checkAllResolved = () => {
        if (getPending() > 0) return;
        syncBlockToMessage();
        card.remove(); 
        const msg = getCurrentSession().messages.find(m => m.id === msgEl.dataset.id);
        if (msg) _renderMsgBodyContent(msgEl, msg);
    };

    const validateReplaceChange = (change) => {
        if (!char) return { valid: false, reason: 'No active character' };
        let current;
        if (change.field === 'alternate_greetings') {
            const idx = (change.index || 1) - 1;
            current = (char.data?.alternate_greetings || [])[idx] || '';
        } else {
            current = String(getCharFieldValue(char, change.field));
        }
        for (const patch of (change.patches || [])) {
            const { matched, result } = applySearchReplaceToField(current, patch.search || '', patch.replace || '');
            if (!matched) return { valid: false, reason: `SEARCH not found: "${(patch.search || '').slice(0, 50)}"` };
            current = result;
        }
        return { valid: true };
    };

    const getAppliedResult = (change) => {
        if (!char) return '';
        if (change.action === 'overwrite') return change.value || '';
        let current;
        if (change.field === 'alternate_greetings') {
            const idx = (change.index || 1) - 1;
            current = (char.data?.alternate_greetings || [])[idx] || '';
        } else {
            current = String(getCharFieldValue(char, change.field));
        }
        for (const patch of (change.patches || [])) {
            const { result } = applySearchReplaceToField(current, patch.search || patch.anchor || '', patch.replace || '');
            current = result;
        }
        return current;
    };

    // Header
    const header = document.createElement('div');
    header.className = 'scp-lb-proposal-header';
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
    const countBadge = document.createElement('span');
    countBadge.className = 'scp-lb-proposal-count';
    countBadge.textContent = `${editableChanges.length} pending`;
    headerLeft.innerHTML = `<span class="scp-lb-proposal-icon" style="color:var(--scp-accent);display:flex"><i class="fa-solid fa-user-pen"></i></span><span class="scp-lb-proposal-title">Proposed Character Edits</span>`;
    headerLeft.appendChild(countBadge);
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'scp-lb-proposal-dismiss'; dismissBtn.innerHTML = I.x; dismissBtn.title = 'Dismiss';
    dismissBtn.addEventListener('click', () => { 
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        if (pending.length > 0) logCharEditHistory(pending, 'Dismissed', card.dataset.for);
        itemStates.forEach((s, i) => { if (s === 'pending') itemStates[i] = 'dismissed'; });
        syncBlockToMessage(); 
        card.remove(); 
    });
    header.appendChild(headerLeft); header.appendChild(dismissBtn);

    const list = document.createElement('div');
    list.className = 'scp-lb-proposal-list';

    const itemEls = editableChanges.map((c, ci) => {
        const item = document.createElement('div');
        item.className = `scp-lb-proposal-item ${c.action === 'append' ? 'scp-lb-proposal-add' : 'scp-lb-proposal-edit'}`;

        const hdr = document.createElement('div');
        hdr.className = 'scp-lb-proposal-item-header';

        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;min-width:0';
        const patchCount = c.patches?.length > 1 ? ` (${c.patches.length})` : '';
        const actionLabel = c.action === 'append' ? '+ Append'
            : c.action === 'overwrite' ? '↺ Overwrite'
            : c.action === 'prepend' ? '⬆ Prepend'
            : c.action === 'append_text' ? '⬇ Append'
            : `✎ Replace${patchCount}`;
        meta.innerHTML = `<span class="scp-lb-proposal-action">${escHtml(actionLabel)}</span><span class="scp-lb-proposal-name">${escHtml(FIELD_LABELS[c.field]||c.field||'?')}${c.index?` #${c.index}`:''}</span>`;

        const btns = document.createElement('div');
        btns.className = 'scp-lb-proposal-item-btns';

        if ((c.action === 'replace' || c.action === 'overwrite') && char) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'scp-lb-proposal-diff-btn'; diffBtn.title = 'View diff'; diffBtn.innerHTML = I.diff;
            diffBtn.addEventListener('click', e => {
                e.stopPropagation();
                const change = editableChanges[ci];
                let original;
                if (change.field === 'alternate_greetings') {
                    const idx = (change.index || 1) - 1;
                    original = (char.data?.alternate_greetings || [])[idx] || '';
                } else {
                    original = String(getCharFieldValue(char, change.field));
                }
                const result = getAppliedResult(change);
                const title = `Diff: ${FIELD_LABELS[c.field]||c.field}${c.index?` #${c.index}`:''}`;
                _openTextDiffModal(title, original, result);
            });
            btns.appendChild(diffBtn);
        }

        const editToggleBtn = document.createElement('button');
        editToggleBtn.className = 'scp-lb-proposal-edit-toggle'; editToggleBtn.title = 'Edit before applying'; editToggleBtn.textContent = '✎';
        btns.appendChild(editToggleBtn);

        const applyBtn = document.createElement('button');
        applyBtn.className = 'scp-lb-proposal-item-apply'; applyBtn.title = 'Apply'; applyBtn.textContent = '✓';

        if (c.action === 'replace' && char) {
            const { valid, reason } = validateReplaceChange(editableChanges[ci]);
            if (!valid) {
                applyBtn.disabled = true;
                applyBtn.title = reason || 'Cannot apply';
                item.style.borderLeftColor = 'var(--scp-danger)';
                const warn = document.createElement('div');
                warn.style.cssText = 'font-size:10px;color:var(--scp-danger);margin-top:4px';
                warn.textContent = `\u26A0 ${reason || 'SEARCH text not found — this edit may be outdated.'}`;
                meta.appendChild(warn);
            }
        }

        applyBtn.addEventListener('click', async e => {
            e.stopPropagation();
            if (itemStates[ci] !== 'pending' || applyBtn.disabled) return;
            applyBtn.disabled = true; applyBtn.textContent = '\u2026';
            try {
                await applyCharChanges([editableChanges[ci]], card.dataset.for);
                itemStates[ci] = 'applied';
                item.classList.add('scp-lb-item-applied');
                btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
                persistState(); countBadge.textContent = `${getPending()} pending`; updateFooter(); 
                syncBlockToMessage();
                checkAllResolved();
            } catch (err) {
                toastr.error(`Failed: ${err.message}`, EXT_DISPLAY);
                applyBtn.disabled = false; applyBtn.textContent = '\u2713';
            }
        });

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'scp-lb-proposal-item-reject'; rejectBtn.title = 'Reject'; rejectBtn.textContent = '\u2715';
        rejectBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (itemStates[ci] !== 'pending') return;
            itemStates[ci] = 'rejected';
            item.classList.add('scp-lb-item-rejected');
            btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
            logCharEditHistory([editableChanges[ci]], 'Rejected', card.dataset.for);
            persistState(); countBadge.textContent = `${getPending()} pending`; updateFooter(); 
            syncBlockToMessage();
            checkAllResolved();
        });

        btns.appendChild(applyBtn); btns.appendChild(rejectBtn);
        hdr.appendChild(meta); hdr.appendChild(btns);
        item.appendChild(hdr);

        // Preview (expandable)
        const buildPreviewText = () => {
            const change = editableChanges[ci];
            if (change.action === 'replace' && change.patches?.length) {
                return change.patches.map((p, pi) => {
                    const s = (p.search || '').replace(/\n/g, '\u21B5').slice(0, 80);
                    const r = (p.replace || '').replace(/\n/g, '\u21B5').slice(0, 80);
                    return `Patch ${pi+1}: "${s}" \u2192 "${r}"`;
                }).join('\n');
            }
            return change.value || '';
        };

        const previewEl = document.createElement('div');
        previewEl.className = 'scp-lb-proposal-preview';
        previewEl.style.whiteSpace = 'pre-wrap';
        let _expanded = false;
        const refreshPreview = () => {
            const raw = buildPreviewText();
            previewEl.textContent = (!_expanded && raw.length > 140) ? raw.slice(0, 140) + '\u2026' : raw;
        };
        refreshPreview();
        previewEl.style.cursor = 'pointer';
        previewEl.title = 'Click to expand/collapse';
        previewEl.addEventListener('click', e => {
            e.stopPropagation();
            _expanded = !_expanded;
            refreshPreview();
        });
        item.appendChild(previewEl);

        // Edit panel
        const editPanel = document.createElement('div');
        editPanel.className = 'scp-lb-proposal-edit-panel';
        editPanel.style.display = 'none';

        const mkRow = (labelHtml, el) => {
            const row = document.createElement('div');
            row.className = 'scp-lb-pe-row';
            const lbl = document.createElement('label');
            lbl.className = 'scp-lb-pe-label'; lbl.innerHTML = labelHtml;
            row.appendChild(lbl); row.appendChild(el); return row;
        };

        const rebuildEditPanel = () => {
            editPanel.innerHTML = '';
            const change = editableChanges[ci];

            if (change.action === 'replace') {
                (change.patches || []).forEach((patch, pi) => {
                    const pHdr = document.createElement('div');
                    pHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px';
                    pHdr.innerHTML = `<span style="font-size:10px;font-weight:700;color:var(--scp-accent);text-transform:uppercase;letter-spacing:.04em">Patch ${pi+1}</span>`;
                    if (change.patches.length > 1) {
                        const delP = document.createElement('button');
                        delP.style.cssText = 'background:none;border:none;color:var(--scp-danger);cursor:pointer;font-size:11px;padding:0;font-family:var(--scp-font)';
                        delP.textContent = '\u2715 Remove';
                        delP.addEventListener('click', () => {
                            change.patches.splice(pi, 1);
                            rebuildEditPanel();
                            if (char) { const { valid } = validateReplaceChange(change); applyBtn.disabled = !valid; }
                            refreshPreview();
                        });
                        pHdr.appendChild(delP);
                    }
                    editPanel.appendChild(pHdr);

                    const searchTa = document.createElement('textarea');
                    searchTa.className = 'scp-lb-pe-textarea'; searchTa.rows = 3; searchTa.value = patch.search || '';
                    searchTa.addEventListener('input', () => {
                        change.patches[pi].search = searchTa.value;
                        if (char) { const { valid } = validateReplaceChange(change); applyBtn.disabled = !valid; }
                        refreshPreview();
                    });
                    editPanel.appendChild(mkRow('Anchor', searchTa));

                    const replaceTa = document.createElement('textarea');
                    replaceTa.className = 'scp-lb-pe-textarea'; replaceTa.rows = 3; replaceTa.value = patch.replace || '';
                    replaceTa.addEventListener('input', () => {
                        change.patches[pi].replace = replaceTa.value;
                        refreshPreview();
                    });
                    editPanel.appendChild(mkRow('Replace', replaceTa));

                    if (pi < change.patches.length - 1) {
                        const sep = document.createElement('div');
                        sep.style.cssText = 'height:1px;background:rgba(255,255,255,.07);margin:8px 0';
                        editPanel.appendChild(sep);
                    }
                });

                const addPatchBtn = document.createElement('button');
                addPatchBtn.className = 'scp-action-btn'; addPatchBtn.style.marginTop = '8px';
                addPatchBtn.innerHTML = `${I.plus}<span>Add Patch</span>`;
                addPatchBtn.addEventListener('click', () => {
                    change.patches.push({ search: '', replace: '' });
                    rebuildEditPanel();
                });
                editPanel.appendChild(addPatchBtn);
            } else {
                const valueTa = document.createElement('textarea');
                valueTa.className = 'scp-lb-pe-textarea'; valueTa.rows = 5; valueTa.value = change.value || '';
                valueTa.addEventListener('input', () => { change.value = valueTa.value; refreshPreview(); });
                editPanel.appendChild(mkRow('Value', valueTa));
            }
        };

        rebuildEditPanel();
        item.appendChild(editPanel);

        editToggleBtn.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = editPanel.style.display !== 'none';
            editPanel.style.display = isOpen ? 'none' : 'flex';
            previewEl.style.display = isOpen ? '' : 'none';
            editToggleBtn.classList.toggle('active', !isOpen);
            if (!isOpen) rebuildEditPanel();
        });

        list.appendChild(item);
        return item;
    });

    itemEls.forEach((el, i) => {
        if (itemStates[i] === 'applied') {
            el.classList.add('scp-lb-item-applied');
            el.querySelectorAll('button').forEach(b => { b.disabled = true; });
        } else if (itemStates[i] === 'rejected') {
            el.classList.add('scp-lb-item-rejected');
            el.querySelectorAll('button').forEach(b => { b.disabled = true; });
        }
    });

    const footer = document.createElement('div');
    footer.className = 'scp-lb-proposal-footer';
    const applyAllBtn = document.createElement('button');
    applyAllBtn.className = 'scp-lb-proposal-apply'; applyAllBtn.textContent = 'Apply All';
    const rejectAllBtn = document.createElement('button');
    rejectAllBtn.className = 'scp-lb-proposal-reject'; rejectAllBtn.textContent = 'Reject All';

    const updateFooter = () => {
        const p = getPending();
        applyAllBtn.style.display = p > 0 ? '' : 'none';
        rejectAllBtn.style.display = p > 0 ? '' : 'none';
    };
    updateFooter();

    applyAllBtn.addEventListener('click', async () => {
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        if (!pending.length) return;
        applyAllBtn.disabled = true; applyAllBtn.textContent = 'Applying\u2026';
        try {
            await applyCharChanges(pending, card.dataset.for);
            itemStates.forEach((s, i) => { if (s === 'pending') { itemStates[i] = 'applied'; itemEls[i]?.classList.add('scp-lb-item-applied'); itemEls[i]?.querySelectorAll('button').forEach(b => { b.disabled = true; }); } });
            persistState(); countBadge.textContent = `${getPending()} pending`; updateFooter(); 
            syncBlockToMessage();
            checkAllResolved();
        } catch (e) {
            toastr.error(`Failed: ${e.message}`, EXT_DISPLAY);
            applyAllBtn.disabled = false; applyAllBtn.textContent = 'Apply All';
        }
    });
    rejectAllBtn.addEventListener('click', () => {
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        itemStates.forEach((s, i) => { if (s === 'pending') { itemStates[i] = 'rejected'; itemEls[i]?.classList.add('scp-lb-item-rejected'); itemEls[i]?.querySelectorAll('button').forEach(b => { b.disabled = true; }); } });
        logCharEditHistory(pending, 'Rejected', card.dataset.for);
        persistState(); countBadge.textContent = `${getPending()} pending`; updateFooter(); 
        syncBlockToMessage();
        checkAllResolved();
    });

    footer.appendChild(applyAllBtn); footer.appendChild(rejectAllBtn);
    card.appendChild(header); card.appendChild(list); card.appendChild(footer);
    const body = msgEl.querySelector('.scp-msg-body');
    if (body) body.insertBefore(card, body.querySelector('.scp-swipe-bar'));
    else msgEl.after(card);
}

