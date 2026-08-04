/**
 * api.js
 * Everything involved in talking to the LLM: macro expansion ({{user}},
 * {{char}}, {{time}}, etc.), assembling the full message payload (system
 * prompt + lorebook context + character/edit instructions + persona +
 * chat history + pending attachments), the Raw Context Payload inspector
 * (syntax-highlighted preview with a jump-to-section nav), and the actual
 * streaming/non-streaming generation call through ST's Connection Manager.
 *
 * Moved from original index.js "Macro Expansion" (lines 6777-6863),
 * "Payload Assembly" (6864-7010), "Context Inspector / Raw Context Payload
 * panel" (7011-7240), and "API Generation" (7241-7467) — kept together
 * since payload assembly, the inspector that previews that exact payload,
 * and the call that sends it are one continuous concern.
 *
 * Also includes `getCharInfo` (old line 6653), the one function from "ST
 * Context Helpers" that calls `expandMacros` — pulling it into
 * `utils/util-st.js` alongside its siblings would have created a
 * util -> api.js cycle for a low-level utility module, so it stays here
 * instead, next to the macro expansion it depends on.
 *
 * `_abortController` and the sandboxed-HTML-block registry are exposed via
 * accessor functions (`getAbortController`/`abortGeneration`,
 * `registerHtmlBlock`/`getHtmlBlock`) for the future `ui/ui-chat.js` —
 * Message Rendering and Generation Flow both reach into this module's
 * private state in the original file.
 *
 * No injected forward-deps in this file — every dependency it needs
 * already exists.
 */

import { EXT_DISPLAY } from './constants.js';
import { DEFAULT_SYSTEM_PROMPT } from './default-prompts.js';
import { escHtml } from './utils/util-dom.js';
import { getUserPersona } from './utils/util-st.js';
import { getCurrentSession } from './session.js';
import { applyRegexIfEnabled, buildLorebookContextBlock, buildLBAIInstructions } from './features/feature-lorebook-engine.js';
import { buildCharacterContextBlock, buildCharEditAIInstructions, buildChatEditAIInstructions } from './features/feature-character-engine.js';
import { mergeContent } from './features/feature-attachments.js';

export function getCharInfo() {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    if (!char) return null;
    
    const d = char.data || {};
    const ov = ctx.chatMetadata?.character_overrides || {};
    
    const get = (field, macro) => {
        if (ov[field]) return ov[field];
        if (macro) {
            try { const r = expandMacros(macro); if (r && r !== macro) return r; } catch(_) {}
        }
        return d[field] || char[field] || '';
    };

    const getCharNote = () => {
        if (ov.depth_prompt && ov.depth_prompt.prompt) return ov.depth_prompt.prompt;
        return d.extensions?.depth_prompt?.prompt || char.extensions?.depth_prompt?.prompt || '';
    };

    return {
        name: char.name || 'Unknown',
        description: get('description', '{{description}}'),
        personality: get('personality', '{{personality}}'),
        scenario: get('scenario', '{{scenario}}'),
        mes_example: get('mes_example', '{{mesExamples}}'),
        character_note: getCharNote(),
        creator_notes: get('creator_notes'),
    };
}
export function expandMacros(text) {
    if (!text) return text;
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.substituteParams === 'function') {
            return ctx.substituteParams(text);
        }
        if (typeof window.substituteParams === 'function') {
            return window.substituteParams(text, ctx.name1, ctx.name2);
        }
    } catch (e) {
        console.warn(`[${EXT_DISPLAY}] Macro expansion error:`, e);
    }
    try {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters?.[ctx.characterId];
        const d = char?.data || {};
        const now = new Date();
        return text
            .replace(/\{\{user\}\}/gi, ctx.name1 || 'User')
            .replace(/\{\{char\}\}/gi, char?.name || ctx.name2 || 'Character')
            .replace(/\{\{time\}\}/gi, now.toLocaleTimeString())
            .replace(/\{\{date\}\}/gi, now.toLocaleDateString())
            .replace(/\{\{isodate\}\}/gi, now.toISOString().split('T')[0])
            .replace(/\{\{isotime\}\}/gi, now.toTimeString().slice(0, 5))
            .replace(/\{\{lastMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                return msgs?.[msgs.length - 1]?.mes || '';
            })
            .replace(/\{\{lastUserMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                if (!msgs) return '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].is_user) return msgs[i].mes || '';
                }
                return '';
            })
            .replace(/\{\{lastCharMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                if (!msgs) return '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (!msgs[i].is_user) return msgs[i].mes || '';
                }
                return '';
            })
            .replace(/\{\{description\}\}/gi, d.description || char?.description || '')
            .replace(/\{\{personality\}\}/gi, d.personality || char?.personality || '')
            .replace(/\{\{scenario\}\}/gi, d.scenario || char?.scenario || '');
    } catch (_) {
        return text;
    }
}

export function getSystemPromptText() {
    const ctx = SillyTavern.getContext();
    return ctx.systemPrompt || ctx.system_prompt || '';
}

export function getMainChatSlice(depth, includeInlineSummaryOriginals = false) {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat) return [];
    
    const extractData = (m, i, inlineSummarySourcePath = null) => ({
        role: m.is_user ? 'user' : 'assistant',
        name: m.is_user ? (ctx.name1 || 'User') : (m.name || getCharInfo()?.name || 'Character'),
        content: typeof m.mes === 'string' ? m.mes : '',
        chatIndex: i,
        inlineSummarySourcePath,
        is_hidden: !!m.is_system || !!m.is_hidden || !!(m.extra && m.extra.is_hidden)
    });

    const extractVisibleMessage = (message, chatIndex) => {
        const inlineSummaryApi = Reflect.get(globalThis, 'InlineSummary');
        if (!includeInlineSummaryOriginals || inlineSummaryApi?.version !== 1 || typeof inlineSummaryApi.getOriginalMessages !== 'function') {
            return [extractData(message, chatIndex)];
        }

        const originals = inlineSummaryApi.getOriginalMessages(message, { recursive: true });
        if (!Array.isArray(originals) || originals.length === 0) {
            return [extractData(message, chatIndex)];
        }

        return originals.map(original => extractData(original, chatIndex, original.ilsSourcePath));
    };

    try {
        const sess = getCurrentSession();
        const picked = sess.pickedChatIndices;
        if (picked && picked.length > 0) {
            return picked
                .filter(i => i >= 0 && i < ctx.chat.length)
                .flatMap(i => extractVisibleMessage(ctx.chat[i], i));
        }
    } catch(_) {}
    
    if (depth === 0) return [];
    const total = ctx.chat.length;
    return ctx.chat.slice(-depth).flatMap((m, i) => extractVisibleMessage(m, total - depth + i));
}
export async function buildSystemContent(settings) {
    const parts = [settings.systemPrompt || DEFAULT_SYSTEM_PROMPT];
    const charInfo = getCharInfo();
    const ctx = SillyTavern.getContext();

    if (settings.includeSystemPrompt) {
        const sp = getSystemPromptText();
        if (sp) parts.push(`\n\n<st_system_prompt>\n${sp}\n</st_system_prompt>`);
    }

    {
        const editXml = buildCharacterContextBlock(settings);
        let inner = `Name: ${charInfo ? charInfo.name : (ctx.name2 || 'Character')}\n`;
        if (editXml) inner += '\n' + editXml;
        parts.push(`\n\n<character_information>\n${inner}\n</character_information>`);
    }

    {
        const userName = ctx.name1 || 'User';
        const personaContent = settings.includeUserPersonality ? getUserPersona() : '';
        const inner = personaContent ? `Name: ${userName}\n${personaContent}` : `Name: ${userName}`;
        parts.push(`\n\n<${userName}_persona>\n${inner}\n</${userName}_persona>`);
    }

    const lbBlock = await buildLorebookContextBlock(settings);
    if (lbBlock) parts.push(lbBlock);

    const aiInstructions = buildLBAIInstructions(settings).trim();
    const charEditDirective = buildCharEditAIInstructions(settings).trim();
    const chatEditDirective = buildChatEditAIInstructions(settings).trim();

    const modules = [aiInstructions, charEditDirective, chatEditDirective].filter(Boolean);
    if (modules.length > 0) {
        parts.push(`\n\n<modules>\n${modules.join('\n\n')}\n</modules>`);
    }

    return parts.join('\n');
}

function buildPlotTrackerContextBlock(settings) {
    if (!settings.includePlotTrackerContext) return '';
    try {
        const snapshot = globalThis.PlotTracker?.getContextSnapshot?.();
        if (!snapshot || snapshot.schema !== 3) return '';
        const plots = [...(snapshot.active || []), ...(snapshot.horizon || [])]
            .filter((plot) => plot.title || plot.summary);
        if (!plots.length) return '';
        const lines = plots.map((plot) => {
            const title = String(plot.title || '').replace(/[\r\n]+/g, ' ').trim();
            const summary = String(plot.summary || '').replace(/[\r\n]+/g, ' ').trim();
            return `- ${title}: ${summary}`;
        });
        return `<plot_tracker>\nThese are active and future plot threads manually maintained by the human user. Use these as reference regarding the current story, but still infer to the <roleplay_context> for full accuracy checks.\n\n${lines.join('\n')}\n</plot_tracker>`;
    } catch (_) {
        return '';
    }
}

export function _buildAiContextForHistoryMsg(msg) {
    try {
        const lines = msg.swipes?.[msg.swipeIndex || 0]?.historyLines || msg.appliedLines || [];
        const entries = lines.map(line => {
            const plain = line.replace(/\*\*/g, '').replace(/`/g, '');
            const statusMatch = plain.match(/^[✓✕·]\s+(ACCEPTED|REJECTED|DISMISSED[^:]*)/);
            const status = statusMatch ? statusMatch[1] : 'UNKNOWN';
            const restMatch = plain.match(/(?:ACCEPTED|REJECTED|DISMISSED[^:]*): (.+)/);
            const detail = restMatch ? restMatch[1].trim() : plain;
            return { status, detail };
        });

        const ctg = msg.isCharEditHistory ? 'character_card_changes' : (msg.isChatEditHistory ? 'chat_messages_edits' : 'lorebook_changes');

        const obj = {
            type: 'system_notification',
            category: ctg,
            entries,
        };
        const jsonStr = JSON.stringify(obj, null, 2);
        return `${jsonStr}\n\n[System Note: Your generated \`${ctg}\` code block has been deleted to save tokens. This notification indicates the user's decision regarding your proposed changes. DO NOT regenerate it. Proceed with user's next request.]`;
    } catch (_) {
        return msg.content || '';
    }
}

export async function assembleMessages(session, settings, pendingUserText, pendingAtts = null) {
    const messages = [{ role: 'system', content: await buildSystemContent(settings) }];
    const plotTrackerBlock = buildPlotTrackerContextBlock(settings);
    if (plotTrackerBlock) {
        messages.push({ role: 'user', content: plotTrackerBlock });
    }
    const depth = Math.max(0, parseInt(settings.contextDepth) || 0);
    const hasPicked = !!(session.pickedChatIndices && session.pickedChatIndices.length > 0);
    if (depth > 0 || hasPicked) {
        const slice = getMainChatSlice(depth, settings.includeInlineSummaryOriginals);
        if (slice.length) {
            const chatTotal = SillyTavern.getContext().chat?.length ?? 0;
            const visibleContextCount = hasPicked
                ? session.pickedChatIndices.filter(i => i >= 0 && i < chatTotal).length
                : Math.min(depth, chatTotal);
            const processedSlice = await Promise.all(slice.map(async m => ({
                ...m, content: await applyRegexIfEnabled(m.content, m.role === 'user', chatTotal - m.chatIndex - 1),
            })));
            const ctx = SillyTavern.getContext();
            const stMsgs = ctx.chat || [];
            const block = processedSlice.map(m => {
                const hiddenAttr = m.is_hidden ? ' hidden_from_ai="true"' : '';
                const summarySourceAttrs = m.inlineSummarySourcePath
                    ? ` inline_summary_path="${m.inlineSummarySourcePath.join('.')}"`
                    : '';
                return `<msg index="${m.chatIndex}" role="${m.role === 'user' ? 'user' : 'assistant'}"${hiddenAttr}${summarySourceAttrs}>\n[${m.name}]: ${m.content}\n</msg>`;
            }).join('\n\n');
            const ctxAttr = hasPicked ? `picked_messages="${visibleContextCount}"` : `last_messages="${visibleContextCount}"`;
            messages.push({
                role: 'user',
                content: `<roleplay_context ${ctxAttr}>\n\n${block}\n\n</roleplay_context>`,
            });
            messages.push({ role: 'assistant', content: 'Understood. I have reviewed the current roleplay context. How can I help?' });
        }
    }
    const limit = Math.max(1, parseInt(settings.localHistoryLimit) || 50);
    for (const m of session.messages.slice(-limit)) {
        let content = m.content;

        const currentSwipe = m.swipes?.[m.swipeIndex || 0];
        const hasAttachedHistory = currentSwipe?.historyLines?.length > 0;

        if (m.isLBHistory || m.isCharEditHistory || m.isChatEditHistory) {
            content = _buildAiContextForHistoryMsg(m);
            messages.push({ role: 'user', content: mergeContent(content, m.attachments) });
        } else {
            const finalContent = mergeContent(content, m.attachments);
            let apiRole = m.role;
            if (apiRole === 'system') apiRole = 'user';

            messages.push({ role: apiRole, content: finalContent });

            if (hasAttachedHistory) {
                let cat = 'system_action_results';
                const firstLine = currentSwipe.historyLines[0] || '';
                if (firstLine.includes('Character') || firstLine.includes('Tags') || firstLine.includes('Description') || firstLine.includes('Personality')) cat = 'character_card_changes';
                else if (firstLine.includes('message')) cat = 'chat_messages_edits';
                else cat = 'lorebook_changes';

                const dummy = { appliedLines: currentSwipe.historyLines, isCharEditHistory: cat === 'character_card_changes', isChatEditHistory: cat === 'chat_messages_edits' };
                const historyContext = _buildAiContextForHistoryMsg(dummy);

                messages.push({ role: 'user', content: historyContext });
            }
        }
    }
    if (pendingUserText !== null && pendingUserText !== undefined) {
        const finalContent = mergeContent(pendingUserText, pendingAtts);
        if (finalContent || (Array.isArray(finalContent) && finalContent.length)) {
            messages.push({ role: 'user', content: finalContent });
        }
    }
    return messages;
}

export function formatPayloadAsText(messages) {
    return messages.map(m => {
        const label = m.role === 'system' ? '■ SYSTEM' : m.role === 'user' ? '▶ USER' : '◀ ASSISTANT';
        let c = m.content;
        if (Array.isArray(c)) {
            c = c.map(part => {
                if (part.type === 'text') return part.text;
                if (part.type === 'image_url') return `[Image Base64 Attached]`;
                return `[Unknown Block]`;
            }).join('\n');
        }
        return `${label}\n${'─'.repeat(50)}\n${c}`;
    }).join('\n\n');
}
let _lastInspectorMessages = [];

// The Context Inspector toggle (ui/ui-window.js) sets this after each
// assembleMessages() call so the Wand Button's "copy raw payload" action
// (future ui/ui-widgets.js) can reuse the last-built payload without
// reassembling it.
export function getLastInspectorMessages() { return _lastInspectorMessages; }
export function setLastInspectorMessages(messages) { _lastInspectorMessages = messages; }

// Sections this fork knows how to recognize & link to in the nav.
// Deliberately scoped to what this fork actually supports — no
// persistent_memory / tool_calls_system, since this fork doesn't have
// the Persistent Memory or Tool Calls features.
const _CTX_KNOWN_TAGS = new Set([
    'character_information', 'lorebook_context', 'st_system_prompt',
    'lorebook_management', 'character_management', 'chat_messages_editing',
    'roleplay_context', 'entity_definitions', 'persona_configuration', 'operational_guidelines',
]);

// This fork's user-persona tag isn't a fixed string — it's built
// dynamically as "<YourSTPersonaName_persona>". Instead of matching one
// exact tag, treat any tag ending in "_persona" as the persona section.
export function _ctxIsKnownTag(tagName) {
    return _CTX_KNOWN_TAGS.has(tagName) || /_persona$/.test(tagName);
}

// Stable id to anchor/link to regardless of the literal tag text, so
// "<John_persona>" and "<Jane_persona>" both resolve to the same anchor.
export function _ctxSectionKey(tagName) {
    if (/_persona$/.test(tagName)) return 'user_persona';
    return tagName;
}

const _CTX_SECTION_LABELS = {
    'lorebook_context': 'Lorebook',
    'character_information': 'Character',
    'user_persona': 'User Persona',
    'lorebook_management': 'Lorebook Management',
    'character_management': 'Character Management',
    'chat_messages_editing': 'Chat Management',
};
// Sections shown under the collapsible "Modules" group rather than as a
// top-level nav entry.
const _CTX_MODULE_KEYS = new Set(['lorebook_management', 'character_management', 'chat_messages_editing']);

export function _highlightContextText(raw) {
    const events = [];
    // NOTE: the code-block group intentionally does NOT fall back to end-of-
    // string (no |$ alternative). If a ``` is never closed (e.g. the prompt
    // mentions ``` inline like "use (```) for excerpts"), the |$ version
    // would swallow everything after that point into one giant fake
    // code-block, hiding all structural tags (<lorebook_context> etc.) from
    // the tokenizer so their nav anchors are never inserted. Requiring a
    // real closing ``` means unclosed fences simply don't match, and the
    // tags that follow them are tokenized correctly.
    const masterRe = /(```[\s\S]*?```)|(`[^`\n]*`)|(<\/?[^\s<>][^>]*>|<!--[\s\S]*?-->)|(\{\{[^}\n]+\}\})/gi;

    let m;
    masterRe.lastIndex = 0;
while ((m = masterRe.exec(raw))!== null) {
if (m[1]!== undefined) {
// Only treat ``` as a real code fence if it starts on its own
// line (preceded by \n or at position 0). An inline mention
// like "(```)" in "Code blocks (```) for excerpts" would
// otherwise pair up with the next ``` in the text, swallowing
// every structural tag between them into a fake code block.
if (m.index > 0 && raw[m.index - 1]!== '\n' && raw[m.index - 1]!== '\r') {
// Back up the regex to just past this inline ``` so the
// content after it is re-processed by subsequent iterations.
masterRe.lastIndex = m.index + 3;
continue;
}
events.push([m.index, masterRe.lastIndex, 'code_block', m[1]]);
} else if (m[2]!== undefined) {
events.push([m.index, masterRe.lastIndex, 'inline_code', m[2]]);
} else if (m[3]!== undefined) {
events.push([m.index, masterRe.lastIndex, 'tag', m[3]]);
} else if (m[4]!== undefined) {
events.push([m.index, masterRe.lastIndex, 'macro', m[4]]);
}
}

    let html = '', last = 0;

    // Find the LAST occurrence of each known opening tag. The actual
    // structural sections (lorebook_context, character_information, the
    // persona block, etc.) are always appended by this extension *after*
    // the user's own system prompt text. If the user's prompt happens to
    // mention a tag name in plain instructional text (e.g. "Lorebook
    // entries inside <lorebook_context> tags"), that mention will always
    // come *before* the real section. Anchoring to the last match instead
    // of the first means the nav always lands on the real section,
    // never on a passing mention of the tag name in the prompt's own
    // instructions.
const lastOpenIndex = new Map();
for (const [start, end, type, match] of events) {
if (type!== 'tag') continue;
if (match.startsWith('</') || match.endsWith('/>') || match.startsWith('<!--')) continue;
const openTag = match.match(/^<([^\s>]+)>$/);
if (!openTag ||!_ctxIsKnownTag(openTag[1])) continue;
// Structural filter: real sections (built by buildSystemContent) always
// have a newline immediately after the closing >. Inline mentions in
// prompt instructions have a space or text after. If no structural
// match is found at all (edge case), fall back to last-occurrence so
// the nav never silently produces zero anchors.
const nextChar = raw[end]?? '';
const key = _ctxSectionKey(openTag[1]);
if (nextChar === '\n' || nextChar === '\r') {
lastOpenIndex.set(key, start);
} else if (!lastOpenIndex.has(key)) {
// Fallback: if no structural match exists yet, record this
// occurrence. A later structural match will overwrite it.
lastOpenIndex.set(key, start);
}
}

    let currentDepth = 0;

    for (const [start, end, type, match] of events) {
        if (start < last) continue;
        html += escHtml(raw.slice(last, start));

        if (type === 'tag') {
            const isClose = match.startsWith('</');
            const isSelfClose = match.endsWith('/>');
            const isComment = match.startsWith('<!--');

            let applyDepth;
            if (isComment || isSelfClose) {
                applyDepth = currentDepth;
            } else if (isClose) {
                currentDepth = Math.max(0, currentDepth - 1);
                applyDepth = currentDepth;
            } else {
                applyDepth = currentDepth;
                currentDepth++;
            }

            const openTag = match.match(/^<([^\s>]+)>$/);
            if (openTag && _ctxIsKnownTag(openTag[1])) {
                const key = _ctxSectionKey(openTag[1]);
                if (start === lastOpenIndex.get(key)) {
                    html += `<span id="scp-ctx-sec-${escHtml(key)}" class="scp-ctx-anchor"></span>`;
                }
            }

            const depthClass = Math.min(applyDepth, 5);
            html += `<span class="scp-ctx-hl-tag scp-ctx-hl-tag-d${depthClass}">${escHtml(match)}</span>`;
        } else if (type === 'macro') {
            html += `<span class="scp-ctx-hl-macro">${escHtml(match)}</span>`;
        } else if (type === 'code_block' || type === 'inline_code') {
            html += escHtml(match);
        }
        last = end;
    }
    html += escHtml(raw.slice(last));
    return html;
}

export function buildContextInspectorHTML(messages) {
    let navHtml = '', bodyHtml = '';
    let seenSections = new Set();

    messages.forEach((msg, idx) => {
        let raw = Array.isArray(msg.content)
            ? msg.content.map(p => p.type === 'text' ? p.text : '[Image]').join('\n')
            : (msg.content || '');

        let displayRole = msg.role;
        if (msg.role !== 'system' && raw.includes('"type": "system_notification"')) {
            displayRole = 'system';
        }

const LABELS = { system: '■ SYSTEM', user: '▶ USER', assistant: '◀ ASSISTANT' };
let label = (LABELS[displayRole] || displayRole) + (idx > 0? ` #${idx}`: '');
// Context messages can mention other tag names in their instructions, so
// classify only structural opening tags that begin a line.
if (displayRole === 'user' && /^<plot_tracker>\r?$/m.test(raw)) {
label = '▶ Plot Tracker' + (idx > 0? ` #${idx}`: '');
} else if (displayRole === 'user' && /^<roleplay_context(?:\s[^>]*)?>\r?$/m.test(raw)) {
const pickedMatch = raw.match(/picked_messages="(\d+)"/);
const lastMatch = raw.match(/last_messages="(\d+)"/);
const msgCount = pickedMatch? pickedMatch[1]: (lastMatch? lastMatch[1]: '');
label = '▶ Roleplay Context' + (msgCount? ` (${msgCount} msgs)`: '') + (idx > 0? ` #${idx}`: '');
}
        const blockId = `scp-ctx-b${idx}`;

        navHtml += `<button class="scp-ctx-nav-btn scp-ctx-nav-${displayRole}" data-t="${blockId}">${escHtml(label)}</button>`;

        if (msg.role === 'system') {
            // This fork doesn't wrap the system prompt itself in its own
            // tag, so "System Prompt" just points at the top of the block.
            navHtml += `<button class="scp-ctx-nav-btn scp-ctx-nav-sub" data-t="${blockId}">&nbsp;&nbsp;◦ System Prompt</button>`;

            const tagRe = /<([^\s<>]+)>/g;
            let tm;
            tagRe.lastIndex = 0;
                const sectionKeys = new Set();
            while ((tm = tagRe.exec(raw)) !== null) {
                const rawTag = tm[1];
                if (!_ctxIsKnownTag(rawTag)) continue;
                const key = _ctxSectionKey(rawTag);
                    if (_CTX_SECTION_LABELS[key]) sectionKeys.add(key);
                }

                const sectionOrder = [
                    'character_information',
                    'user_persona',
                    'lorebook_context',
                ];
                const orderedSections = [
                    ...sectionOrder,
                    ...Array.from(sectionKeys).filter(key => !sectionOrder.includes(key)),
                ];
                let moduleNavs = '';
                for (const key of orderedSections) {
                    const secLabel = _CTX_SECTION_LABELS[key];
                    if (!sectionKeys.has(key) || seenSections.has(key)) continue;
                    seenSections.add(key);
                    const secId = `scp-ctx-sec-${key}`;

                if (_CTX_MODULE_KEYS.has(key)) {
                    moduleNavs += `<button class="scp-ctx-nav-btn scp-ctx-nav-sub" data-t="${secId}">&nbsp;&nbsp;◦ ${escHtml(secLabel)}</button>`;
                } else {
                    navHtml += `<button class="scp-ctx-nav-btn scp-ctx-nav-sub" data-t="${secId}">&nbsp;&nbsp;◦ ${escHtml(secLabel)}</button>`;
                }
                }
            if (moduleNavs) {
                navHtml += `<details class="scp-ctx-nav-details" open><summary class="scp-ctx-nav-btn" style="color:var(--scp-text)">▼ Modules</summary>${moduleNavs}</details>`;
            }
        }

        const highlighted = _highlightContextText(raw);
        bodyHtml += `<div class="scp-ctx-block" id="${blockId}">`;
        bodyHtml += `<div class="scp-ctx-block-header scp-ctx-role-${displayRole}">${escHtml(label)}</div>`;
        bodyHtml += `<div class="scp-ctx-block-sep"></div>`;
        bodyHtml += `<div class="scp-ctx-block-body"><pre class="scp-ctx-pre">${highlighted}</pre></div>`;
        bodyHtml += `</div>`;
    });

    const styleHtml = `<style>
        .scp-ctx-hl-tag-d0 { color: #eff6ff !important; }
        .scp-ctx-hl-tag-d1 { color: #bfdbfe !important; }
        .scp-ctx-hl-tag-d2 { color: #93c5fd !important; }
        .scp-ctx-hl-tag-d3 { color: rgb(106, 165, 236) !important; }
        .scp-ctx-hl-tag-d4 { color: rgb(100, 158, 253) !important; }
        .scp-ctx-hl-tag-d5 { color: rgb(74, 120, 221) !important; }
    </style>`;

    return `<div class="scp-ctx-inspector">${styleHtml}<nav class="scp-ctx-nav">${navHtml}</nav><div class="scp-ctx-body" id="scp-ctx-body">${bodyHtml}</div></div>`;
}
let _abortController = null;

// Read/abort access for future callers (e.g. a stop-generation button or
// hotkey in ui/ui-chat.js) — `_abortController` itself stays module-private
// since only callGenerate() should ever create/clear it.
export function getAbortController() { return _abortController; }
export function abortGeneration() { _abortController?.abort(); }

const _htmlBlockRegistry = new Map();
let _htmlBlockCounter = 0;

// Sandboxed HTML code blocks the AI writes get registered here with a
// stable id, and Message Rendering (future ui/ui-chat.js) looks them back
// up by that id when rendering an iframe for the block.
export function registerHtmlBlock(code) {
    const id = `scp-hb-${_htmlBlockCounter++}`;
    _htmlBlockRegistry.set(id, code.trim());
    return id;
}
export function getHtmlBlock(id) { return _htmlBlockRegistry.get(id); }

export async function callGenerate(session, settings, pendingText, onChunk) {
    const ctx = SillyTavern.getContext();
    const messages = await assembleMessages(session, settings, pendingText);
    const maxTokens = parseInt(settings.maxTokens) || 8200;

    const abort = new AbortController();
    _abortController = abort;

    const service = ctx.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('ConnectionManagerRequestService not available. Please ensure the Connection Manager extension is enabled in SillyTavern.');
    }

    let profiles = [];
    if (typeof service.getSupportedProfiles === 'function') {
        profiles = service.getSupportedProfiles();
    } else {
        profiles = ctx.extensionSettings?.connectionManager?.profiles || [];
    }

    let profileId = null;

    if (settings.connectionSource === 'profile') {
        if (settings.connectionProfileId) {
            const found = profiles.find(p =>
                p.id === settings.connectionProfileId || p.name === settings.connectionProfileId
            );
            if (found) {
                profileId = found.id;
            } else {
                throw new Error(`Connection profile "${settings.connectionProfileId}" not found. Available: ${profiles.map(p => p.name).join(', ') || 'None'}`);
            }
        } else {
            throw new Error('No profile selected in ST-Copilot settings.');
        }
    } else {
        profileId = ctx.extensionSettings?.connectionManager?.selectedProfile;
        if (!profileId) {
            const domSelect = document.getElementById('connection_profiles');
            if (domSelect && domSelect.value) {
                profileId = domSelect.value;
            }
        }
    }

    if (!profileId) {
        throw new Error('No active profile found. Please select a profile in the SillyTavern Connection Manager UI, or assign a specific profile in ST-Copilot settings.');
    }

    const activeProfile = profiles.find(p => p.id === profileId);
    if (activeProfile) {
        if (!activeProfile.api) {
            if (typeof window.getGeneratingApi === 'function') {
                activeProfile.api = window.getGeneratingApi();
            } else {
                const mainApi = ctx.main_api || ctx.mainApi || document.getElementById('main_api')?.value;
                if (mainApi === 'openai') {
                    activeProfile.api = ctx.chatCompletionSettings?.chat_completion_source || 'openai';
                } else if (mainApi === 'textgenerationwebui') {
                    activeProfile.api = ctx.textCompletionSettings?.type || 'textgenerationwebui';
                } else {
                    activeProfile.api = mainApi;
                }
            }
        }
        if (!activeProfile.model) {
            if (typeof window.getGeneratingModel === 'function') {
                activeProfile.model = window.getGeneratingModel();
            } else if (typeof ctx.getChatCompletionModel === 'function') {
                activeProfile.model = ctx.getChatCompletionModel();
            } else {
                const sel = document.getElementById(`model_${activeProfile.api}_select`) || document.querySelector('select[id^="model_"]:visible');
                if (sel && sel.value) {
                    activeProfile.model = sel.value;
                }
            }
        }
        console.debug(`[ST-Copilot] Hydrated connection profile "${profileId}": api=${activeProfile.api}, model=${activeProfile.model}`);
    }

    const streamSetting = settings.forceStreaming;
    let useStream;

    if (streamSetting === 'on' || streamSetting === true) {
        useStream = true;
    } else if (streamSetting === 'off') {
        useStream = false;
    } else {
        let autoStream = false;
        try {
            const profileObj = profiles.find(p => p.id === profileId);
            const api = profileObj?.api || ctx.main_api || document.getElementById('main_api')?.value;
            
            if (['openai', 'claude', 'google', 'scale'].includes(api)) {
                autoStream = ctx.chatCompletionSettings?.stream_openai ?? !!document.getElementById('stream_toggle')?.checked;
            } else if (api === 'textgenerationwebui' || api === 'kobold') {
                autoStream = ctx.textCompletionSettings?.streaming ?? !!document.getElementById('stream_toggle')?.checked;
            } else {
                autoStream = !!document.getElementById('stream_toggle')?.checked;
            }
        } catch (err) {
            autoStream = !!document.getElementById('stream_toggle')?.checked;
        }
        useStream = autoStream;
    }

    let asyncGeneratorFn;
    try {
        asyncGeneratorFn = await service.sendRequest(profileId, messages, maxTokens, {
            stream: useStream,
            signal: abort.signal,
            extractData: useStream, 
            includePreset: true
        });
    } catch (e) {
        _abortController = null;
        if (abort.signal.aborted || e?.name === 'AbortError' || e?.message === 'userStopped') return null;
        throw e;
    }

    let text = '';
    let reasoning = null;
    let reasoningStartMs = null;
    let reasoningDone = false;

    const isGen = typeof asyncGeneratorFn === 'function' ||
        (asyncGeneratorFn != null && typeof asyncGeneratorFn[Symbol.asyncIterator] === 'function') ||
        (asyncGeneratorFn != null && typeof asyncGeneratorFn.next === 'function');

    // Couldnt get the reasoning block via "extractData: true" (maybe skill issue), so Im building my own extractor
    function deepExtract(obj) {
        if (!obj || typeof obj !== 'object') return { t: '', r: null };
        
        let r = null;
        if (typeof obj.state?.reasoning === 'string' && obj.state.reasoning !== '') r = obj.state.reasoning;
        else if (typeof obj.reasoning === 'string' && obj.reasoning !== '') r = obj.reasoning;
        else if (typeof obj.reasoning_content === 'string' && obj.reasoning_content !== '') r = obj.reasoning_content;
        else if (typeof obj.thinking === 'string' && obj.thinking !== '') r = obj.thinking;
        else if (typeof obj.original_response?.choices?.[0]?.message?.reasoning === 'string' && obj.original_response.choices[0].message.reasoning !== '') r = obj.original_response.choices[0].message.reasoning;
        else if (typeof obj.original_response?.choices?.[0]?.message?.reasoning_content === 'string' && obj.original_response.choices[0].message.reasoning_content !== '') r = obj.original_response.choices[0].message.reasoning_content;
        else if (typeof obj.choices?.[0]?.message?.reasoning === 'string' && obj.choices[0].message.reasoning !== '') r = obj.choices[0].message.reasoning;
        else if (typeof obj.choices?.[0]?.message?.reasoning_content === 'string' && obj.choices[0].message.reasoning_content !== '') r = obj.choices[0].message.reasoning_content;
        else if (typeof obj.choices?.[0]?.delta?.reasoning === 'string' && obj.choices[0].delta.reasoning !== '') r = obj.choices[0].delta.reasoning;
        else if (typeof obj.choices?.[0]?.delta?.reasoning_content === 'string' && obj.choices[0].delta.reasoning_content !== '') r = obj.choices[0].delta.reasoning_content;

        let t = '';
        if (typeof obj.text === 'string' && obj.text !== '') t = obj.text;
        else if (typeof obj.content === 'string' && obj.content !== '') t = obj.content;
        else if (typeof obj.message?.content === 'string' && obj.message.content !== '') t = obj.message.content;
        else if (typeof obj.original_response?.choices?.[0]?.message?.content === 'string' && obj.original_response.choices[0].message.content !== '') t = obj.original_response.choices[0].message.content;
        else if (typeof obj.choices?.[0]?.message?.content === 'string' && obj.choices[0].message.content !== '') t = obj.choices[0].message.content;
        else if (typeof obj.choices?.[0]?.delta?.content === 'string' && obj.choices[0].delta.content !== '') t = obj.choices[0].delta.content;
        else if (typeof obj.choices?.[0]?.text === 'string' && obj.choices[0].text !== '') t = obj.choices[0].text;
        else if (typeof obj.results?.[0]?.text === 'string' && obj.results[0].text !== '') t = obj.results[0].text;

        return { t, r };
    }

    let lastValue = null;

    if (!isGen) {
        const value = asyncGeneratorFn;
        if (typeof value === 'string') {
            text = value.trim();
        } else {
            const ext = deepExtract(value);
            text = ext.t.trim();
            reasoning = ext.r;
            lastValue = value;
        }
        
        const finishReason = lastValue?.finish_reason || lastValue?.state?.finish_reason || lastValue?.stop_reason;
        const isMaxTokens = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'stop_limit';

        _abortController = null;
        return { text, reasoning, isMaxTokens };
    }

    const gen = typeof asyncGeneratorFn === 'function' ? asyncGeneratorFn() : asyncGeneratorFn;

    try {
        while (true) {
            if (abort.signal.aborted) { _abortController = null; return null; }
            const { value, done } = await gen.next();
            if (done) {
                if (value) lastValue = value;
                break;
            }
            lastValue = value;

            const ext = deepExtract(value);
            text = ext.t;
            const newReasoning = ext.r;

            if (newReasoning) {
                if (reasoningStartMs === null) reasoningStartMs = performance.now();
                reasoning = newReasoning;
            }
            if (text && !reasoningDone && reasoning) {
                reasoningDone = true;
            }

            if (typeof onChunk === 'function') {
                const reasoningMs = reasoningStartMs !== null ? performance.now() - reasoningStartMs : null;
                onChunk(text, reasoning, reasoningMs, reasoningDone);
            }
        }
    } catch (e) {
        _abortController = null;
        if (abort.signal.aborted || e?.name === 'AbortError' || e?.message === 'userStopped') return null;
        throw e;
    }

    const finishReason = lastValue?.finish_reason || lastValue?.state?.finish_reason || lastValue?.stop_reason;
    const isMaxTokens = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'stop_limit';

    _abortController = null;
    return { text: text.trim(), reasoning, isMaxTokens };
}
