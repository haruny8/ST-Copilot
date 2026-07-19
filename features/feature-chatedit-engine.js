/**
 * feature-chatedit-engine.js
 * Diff computation/rendering (LCS-based line + inline word diff, unified
 * and split views, the diff modal) plus the Chat Message Editing Engine:
 * lets the LLM propose structured edits to chat messages themselves
 * (replace/overwrite/prepend/append/bulk_replace/regex/delete/add/hide/
 * unhide), parses those proposals out of AI replies, applies them to
 * SillyTavern's actual chat array, and renders the review card in chat.
 * Also renders lorebook/character/chat-edit "history" notification bubbles
 * (accepted/rejected/dismissed change logs).
 *
 * Moved from original index.js "Diff Engine" (lines 3111-3428, 318 lines)
 * and "Chat Message Editing Engine" (lines 3429-4351, 923 lines) — combined
 * into one file because the Diff Engine was never really general-purpose;
 * every caller of `openTextDiffModal`/`openDiffModal` is chat- or
 * lorebook-change review UI, and `renderLBHistoryContent`/`appendLBHistoryEl`
 * (nominally "diff engine") are what `feature-lorebook-engine.js` and
 * `feature-character-engine.js` both needed injected — see their header
 * notes.
 *
 * `scrollToBottom`/`renderMsgBodyContent`/`updateMsgCount` turned out to
 * live in what's now `ui/ui-chat.js`, so they're imported directly
 * (creates an import cycle with that module — safe since every
 * cross-reference is only called from inside a function body).
 */

import { EXT_DISPLAY, ICONS } from '../constants.js';
import { repairJSON } from '../utils/util-text.js';
import { escHtml } from '../utils/util-dom.js';
import { getCurrentSession, addMessage, saveSessionsToMetadata, deleteMsg } from '../session.js';
import { applySearchReplaceToField } from './feature-character-engine.js';
import { addHistoryToSwipe } from './feature-lorebook-engine.js';
import {
    scrollToBottom as _scrollToBottom,
    renderMsgBodyContent as _renderMsgBodyContent,
    updateMsgCount as _updateMsgCount,
} from '../ui/ui-chat.js';

export function computeLCS(a, b) {
    const m = a.length, n = b.length;
    if (m === 0 || n === 0) return[];
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    const result =[];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (a[i-1] === b[j-1]) { result.unshift([i-1, j-1]); i--; j--; }
        else if (dp[i-1][j] > dp[i][j-1]) i--;
        else j--;
    }
    return result;
}

export function computeLineDiff(original, modified) {
    const a = original ? original.replace(/\r\n/g, '\n').split('\n') : [];
    const b = modified ? modified.replace(/\r\n/g, '\n').split('\n') : [];
    const lcs = computeLCS(a, b);
    const result =[];
    let ai = 0, bi = 0, li = 0;
    while (ai < a.length || bi < b.length) {
        if (li < lcs.length) {
            while (ai < lcs[li][0]) result.push({ type: 'removed', text: a[ai++] });
            while (bi < lcs[li][1]) result.push({ type: 'added', text: b[bi++] });
            result.push({ type: 'unchanged', text: a[ai++] });
            bi++; li++;
        } else {
            while (ai < a.length) result.push({ type: 'removed', text: a[ai++] });
            while (bi < b.length) result.push({ type: 'added', text: b[bi++] });
        }
    }
    return result;
}

export function highlightInlineDiff(oldLine, newLine) {
    const tokenize = s => s.match(/[\w]+|[^\w\s]+|\s+/g) || [];
    const a = tokenize(oldLine);
    const b = tokenize(newLine);
    const lcs = computeLCS(a, b);
    let ai = 0, bi = 0, li = 0;
    let oldHtml = '', newHtml = '';
    
    const wrapSegment = (text, type) => {
        if (!text) return '';
        return `<span class="scp-diff-word-${type}">${escHtml(text)}</span>`;
    };

    while (ai < a.length || bi < b.length) {
        if (li < lcs.length) {
            let r = '', ad = '';
            while (ai < lcs[li][0]) r += a[ai++];
            while (bi < lcs[li][1]) ad += b[bi++];
            
            oldHtml += wrapSegment(r, 'rem');
            newHtml += wrapSegment(ad, 'add');
            
            const match = escHtml(a[ai]);
            oldHtml += match; newHtml += match;
            ai++; bi++; li++;
        } else {
            let r = '', ad = '';
            while (ai < a.length) r += a[ai++];
            while (bi < b.length) ad += b[bi++];
            
            oldHtml += wrapSegment(r, 'rem');
            newHtml += wrapSegment(ad, 'add');
        }
    }
    return { oldHtml, newHtml };
}

export function processDiffLinesForInline(diffLines) {
    const result =[];
    let i = 0;
    while (i < diffLines.length) {
        if (diffLines[i].type === 'removed') {
            let remStart = i;
            while (i < diffLines.length && diffLines[i].type === 'removed') i++;
            let remEnd = i;
            
            let addStart = i;
            while (i < diffLines.length && diffLines[i].type === 'added') i++;
            let addEnd = i;
            
            const remLines = diffLines.slice(remStart, remEnd);
            const addLines = diffLines.slice(addStart, addEnd);
            
            let maxLen = Math.max(remLines.length, addLines.length);
            for (let j = 0; j < maxLen; j++) {
                if (j < remLines.length && j < addLines.length) {
                    const { oldHtml, newHtml } = highlightInlineDiff(remLines[j].text, addLines[j].text);
                    result.push({ type: 'removed', html: oldHtml });
                    result.push({ type: 'added', html: newHtml });
                } else if (j < remLines.length) {
                    result.push({ type: 'removed', html: escHtml(remLines[j].text) });
                } else {
                    result.push({ type: 'added', html: escHtml(addLines[j].text) });
                }
            }
        } else if (diffLines[i].type === 'added') {
            result.push({ type: 'added', html: escHtml(diffLines[i].text) });
            i++;
        } else {
            result.push({ type: 'unchanged', html: escHtml(diffLines[i].text) });
            i++;
        }
    }
    return result;
}


export function renderDiffUnified(diffLines) {
    if (!diffLines.length) return '<div style="padding:20px;color:var(--scp-text-muted);text-align:center">No changes to display</div>';
    const processed = processDiffLinesForInline(diffLines);
    return `<div class="scp-diff-unified">${processed.map(l => {
        const cls = l.type === 'added' ? 'scp-diff-add' : l.type === 'removed' ? 'scp-diff-rem' : 'scp-diff-ctx';
        const pfx = l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ';
        return `<div class="${cls}"><span class="scp-diff-pfx">${pfx}</span>${l.html}</div>`;
    }).join('')}</div>`;
}

export function renderDiffSplit(original, modified) {
    const a = original ? original.replace(/\r\n/g, '\n').split('\n') : [];
    const b = modified ? modified.replace(/\r\n/g, '\n').split('\n') : [];
    const lcs = computeLCS(a, b);
    const rows =[];
    let ai = 0, bi = 0, li = 0;
    
    const processMismatch = (startA, endA, startB, endB) => {
        const remLines = [], addLines =[];
        let currAi = startA, currBi = startB;
        while (currAi < endA) remLines.push(a[currAi++]);
        while (currBi < endB) addLines.push(b[currBi++]);
        
        const maxLen = Math.max(remLines.length, addLines.length);
        for (let j = 0; j < maxLen; j++) {
            let htmlA = '', htmlB = '', clsA = '', clsB = '';
            if (j < remLines.length && j < addLines.length) {
                const { oldHtml, newHtml } = highlightInlineDiff(remLines[j], addLines[j]);
                htmlA = oldHtml; htmlB = newHtml;
                clsA = 'scp-diff-rem'; clsB = 'scp-diff-add';
            } else if (j < remLines.length) {
                htmlA = escHtml(remLines[j]); clsA = 'scp-diff-rem';
            } else if (j < addLines.length) {
                htmlB = escHtml(addLines[j]); clsB = 'scp-diff-add';
            }
            rows.push(`<tr><td class="${clsA}">${htmlA}</td><td class="${clsB}">${htmlB}</td></tr>`);
        }
    };

    while (ai < a.length || bi < b.length) {
        if (li < lcs.length) {
            processMismatch(ai, lcs[li][0], bi, lcs[li][1]);
            ai = lcs[li][0]; bi = lcs[li][1];
            rows.push(`<tr class="scp-diff-ctx"><td>${escHtml(a[ai++])}</td><td>${escHtml(b[bi++])}</td></tr>`);
            li++;
        } else {
            processMismatch(ai, a.length, bi, b.length);
            ai = a.length; bi = b.length;
        }
    }
    return `<table class="scp-diff-split-table"><thead><tr><th>Original</th><th>Modified</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function openTextDiffModal(title, originalText, newText) {
    const modal = document.getElementById('scp-diff-modal');
    if (!modal) return;
    
    const diffLines = computeLineDiff(originalText, newText);
    const titleEl = modal.querySelector('.scp-diff-modal-title');
    if (titleEl) titleEl.textContent = title;

    const body = document.getElementById('scp-diff-body');
    if (body) body.innerHTML = renderDiffSplit(originalText, newText);

    modal.querySelectorAll('[data-diff-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.diffTab === 'split');
        tab.onclick = () => {
            modal.querySelectorAll('[data-diff-tab]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            if (body) {
                body.innerHTML = tab.dataset.diffTab === 'split' 
                    ? renderDiffSplit(originalText, newText) 
                    : renderDiffUnified(diffLines);
            }
        };
    });
    modal.style.display = 'flex';
}

export function openDiffModal(change, originalEntry) {
    const originalContent = originalEntry?.content || '';
    let newContent = change.content || '';
    
    if (change.action === 'patch' && originalEntry) {
        let current = originalContent;
        for (const patch of (change.patches || [])) {
            const { result } = applySearchReplaceToField(current, patch.search || patch.anchor || '', patch.replace || '');
            current = result;
        }
        newContent = current;
    }
    
    const entryName = change.name || originalEntry?.comment || `Entry #${change.uid || '?'}`;
    const title = `Diff: "${entryName}" in ${change.worldName || '?'}`;
    openTextDiffModal(title, originalContent, newContent);
}

export function renderLBHistoryContent(msg, contentEl) {
    contentEl.innerHTML = '';
    const lines = msg.appliedLines || [];
    const accepted = lines.filter(l => l.includes('ACCEPTED')).length;
    const rejected = lines.filter(l => l.includes('REJECTED')).length;
    const dismissed = lines.filter(l => l.includes('DISMISSED')).length;

    const summaryParts = [];
    if (accepted) summaryParts.push(`${accepted} applied`);
    if (rejected) summaryParts.push(`${rejected} rejected`);
    if (dismissed) summaryParts.push(`${dismissed} dismissed`);
    const summaryStr = summaryParts.length ? summaryParts.join(', ') : `${lines.length} change${lines.length !== 1 ? 's' : ''}`;

    const summaryRow = document.createElement('div');
    summaryRow.style.cssText = 'font-size:12px;font-weight:600;color:var(--scp-text);margin-bottom:4px';
    summaryRow.textContent = `System Notification: ${summaryStr}`;
    contentEl.appendChild(summaryRow);

    if (lines.length) {
        const details = document.createElement('details');
        details.className = 'scp-hist-details';
        const summary = document.createElement('summary');
        summary.className = 'scp-hist-summary';
        summary.textContent = 'Show details';
        details.appendChild(summary);

        const detailsBody = document.createElement('div');
        detailsBody.className = 'scp-hist-body';
        for (const line of lines) {
            const stripped = line.replace(/\*\*/g, '').replace(/`/g, '');
            const isAccepted = stripped.includes('ACCEPTED');
            const isRejected = stripped.includes('REJECTED') && !stripped.includes('DISMISSED');
            const dot = document.createElement('div');
            dot.className = 'scp-hist-item';
            dot.style.cssText = `display:flex;align-items:baseline;gap:6px;padding:2px 0;font-size:11px;color:${isAccepted ? 'var(--scp-success)' : isRejected ? 'var(--scp-danger)' : 'var(--scp-text-muted)'}`;
            const marker = document.createElement('span');
            marker.style.cssText = `width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0;margin-top:5px;display:inline-block`;
            const text = document.createElement('span');
            const m2 = stripped.match(/(?:ACCEPTED|REJECTED|DISMISSED[^:]*): (.+)/);
            text.textContent = m2 ? m2[1] : stripped;
            dot.appendChild(marker);
            dot.appendChild(text);
            detailsBody.appendChild(dot);
        }
        details.appendChild(detailsBody);
        contentEl.appendChild(details);
    }
}

export function appendLBHistoryEl(msg, afterMsgId = null) {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    c.querySelector('.scp-empty-state')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'scp-msg scp-msg-lb-history';
    wrap.dataset.id = msg.id;

    const avatar = document.createElement('div');
    avatar.className = 'scp-msg-avatar scp-msg-avatar-lb';
    
    if (msg.isCharEditHistory) {
        avatar.innerHTML = '<i class="fa-solid fa-user-pen" style="font-size:14px; padding-left:1px;"></i>';
    } else if (msg.isChatEditHistory) {
        avatar.innerHTML = '<i class="fa-solid fa-comments" style="font-size:14px; padding-left:1px;"></i>';
    } else {
        avatar.innerHTML = ICONS.book;
    }

    const body = document.createElement('div');
    body.className = 'scp-msg-body';

    const contentEl = document.createElement('div');
    contentEl.className = 'scp-msg-content scp-lb-history-content';
    renderLBHistoryContent(msg, contentEl);

    const meta = document.createElement('div');
    meta.className = 'scp-msg-meta';
    meta.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'scp-msg-btn scp-lb-history-close';
    closeBtn.innerHTML = ICONS.x;
    closeBtn.title = 'Dismiss notification';
    closeBtn.addEventListener('click', () => {
        const session = getCurrentSession();
        deleteMsg(session, msg.id);
        wrap.remove();
        _updateMsgCount(session);
    });

    body.appendChild(contentEl);
    body.appendChild(closeBtn);
    body.appendChild(meta);
    wrap.appendChild(avatar); wrap.appendChild(body);
    
    const anchor = afterMsgId
        ? (c.querySelector(`.scp-lb-proposal-card[data-for="${afterMsgId}"]`) || c.querySelector(`.scp-msg[data-id="${afterMsgId}"]`))
        : null;
    if (anchor) anchor.after(wrap);
    else c.appendChild(wrap);
    _updateMsgCount(getCurrentSession());
    if (!anchor) _scrollToBottom();
}

export function parseChatChangesFromText(text) {
    let raw = null;
    const strict = text.match(/```chat-changes\s*([\s\S]*?)```/);
    if (strict) { raw = strict[1].trim(); }
    else {
        const open = text.match(/```chat-changes\s*([\s\S]*?)(?=```|$)/);
        if (open) raw = open[1].trim();
    }
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.changes)) return _sanitizeChatChanges(data.changes);
    } catch (_) {}
    try {
        const data = JSON.parse(repairJSON(raw));
        if (Array.isArray(data.changes)) return _sanitizeChatChanges(data.changes);
    } catch (_) {}
    return null;
}

export function _sanitizeChatChanges(changes) {
    if (!Array.isArray(changes)) return null;
    const valid = [];
    for (const c of changes) {
        if (!c || typeof c !== 'object') continue;
        if (!['replace', 'overwrite', 'prepend', 'append', 'bulk_replace', 'regex', 'delete', 'add', 'hide', 'unhide'].includes(c.action)) continue;

        // normalize msg_indices
        if (c.msg_indices !== undefined) {
            if (typeof c.msg_indices === 'string') {
                c.msg_indices = c.msg_indices.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            }
            if (!Array.isArray(c.msg_indices) || !c.msg_indices.length) delete c.msg_indices;
            else c.msg_indices = [...new Set(c.msg_indices)].sort((a, b) => a - b);
        }

        if (c.action === 'add') {
            if (!c.role) c.role = 'assistant';
            if (c.msg_index === undefined) c.msg_index = 99999;
        } else if (c.action === 'bulk_replace' || c.action === 'hide' || c.action === 'unhide') {
            if (c.action === 'bulk_replace' && (!Array.isArray(c.replacements) || (!Array.isArray(c.msg_range) && !Array.isArray(c.msg_indices)))) continue;
            if (c.action === 'bulk_replace') {
                c.replacements = c.replacements.map(r => {
                    if (typeof r === 'object') {
                        r.search = r.search || r.anchor;
                        if (r.search !== undefined) return r;
                    }
                    return null;
                }).filter(Boolean);
            }
        } else {
            if (c.msg_index === undefined && c.msg_id === undefined && c.msg_range === undefined && !c.msg_indices) continue;
        }
        if (c.action === 'replace' && Array.isArray(c.patches)) {
            c.patches = c.patches.map(p => {
                if (typeof p === 'object') {
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

export function stripChatChangesBlock(text) {
    return text.replace(/```chat-changes[\s\S]*?```/g, '').replace(/```chat-changes[\s\S]*/g, '').trim();
}

export function reconstructChatChangesBlock(pendingChanges) {
    if (!pendingChanges.length) return '';
    return '```chat-changes\n{"changes": ' + JSON.stringify(pendingChanges, null, 2) + '}\n```';
}

export function reconstructLBChangesBlock(pendingChanges) {
    if (!pendingChanges.length) return '';
    return '```lorebook-changes\n{"changes": ' + JSON.stringify(pendingChanges, null, 2) + '}\n```';
}

export function _resolveStMsgByIndexOrId(change) {
    const ctx = SillyTavern.getContext();
    const msgs = ctx.chat || [];
    if (typeof change.msg_index === 'number') {
        if (change.msg_index >= 0 && change.msg_index < msgs.length) {
            return { idx: change.msg_index, msg: msgs[change.msg_index] };
        }
    }
    return null;
}

export async function applyChatChanges(changes, afterMsgId = null) {
    const ctx = SillyTavern.getContext();
    const msgs = ctx.chat;
    if (!msgs) { toastr.error('[ChatEdit] No active chat.', EXT_DISPLAY); return; }
    const successLog = [];

    for (const change of changes) {
        try {
            if (change.action === 'hide' || change.action === 'unhide') {
                const cmd = change.action === 'hide' ? '/hide' : '/unhide';
                if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                    const valid = change.msg_indices.filter(i => i >= 0 && i < msgs.length);
                    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
                        for (const idx of valid) {
                            await ctx.executeSlashCommandsWithOptions(`${cmd} ${idx}-${idx}`);
                        }
                    }
                    successLog.push({ ...change, affectedCount: valid.length });
                } else {
                    let startIdx = 0, endIdx = msgs.length - 1;
                    if (Array.isArray(change.msg_range)) {
                        startIdx = change.msg_range[0]; endIdx = change.msg_range[1];
                    } else if (change.msg_index !== undefined) {
                        startIdx = change.msg_index; endIdx = change.msg_index;
                    }
                    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
                        await ctx.executeSlashCommandsWithOptions(`${cmd} ${startIdx}-${endIdx}`);
                    }
                    successLog.push({ ...change, affectedCount: endIdx - startIdx + 1 });
                }
                continue;
            }

            if (change.action === 'add') {
                const isSys = change.role === 'system';
                const isUser = change.role === 'user';
                const newMsg = {
                    name: isSys ? 'System' : (isUser ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')),
                    is_user: isUser,
                    is_system: isSys,
                    send_date: Date.now(),
                    mes: change.content || '',
                    extra: {}
                };
                let insertIdx = msgs.length;
                if (typeof change.msg_index === 'number' && change.msg_index >= 0) {
                    insertIdx = Math.min(change.msg_index, msgs.length);
                }
                msgs.splice(insertIdx, 0, newMsg);
                await _saveChatAfterDelete(ctx);
                successLog.push(change);
                continue;
            }

            if (change.action === 'bulk_replace' || change.action === 'regex') {
                let targetIndices = [];
                if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                    targetIndices = change.msg_indices.filter(i => i >= 0 && i < msgs.length);
                } else {
                    let startIdx = 0, endIdx = msgs.length - 1;
                    if (Array.isArray(change.msg_range)) {
                        startIdx = change.msg_range[0]; endIdx = change.msg_range[1];
                    } else if (change.msg_index !== undefined) {
                        startIdx = change.msg_index; endIdx = change.msg_index;
                    }
                    for (let i = Math.max(0, startIdx); i <= Math.min(msgs.length - 1, endIdx); i++) targetIndices.push(i);
                }

                let affected = 0;
                for (const i of targetIndices) {
                    const msg = msgs[i];
                    let content = msg.mes || '';
                    let changed = false;

                    if (change.action === 'bulk_replace') {
                        for (const rp of (change.replacements || [])) {
                            if (!rp.search && !rp.anchor) continue;
                            const { result, matched } = applySearchReplaceToField(content, rp.search || rp.anchor, rp.replace || '');
                            if (matched) { content = result; changed = true; }
                        }
                    } else if (change.action === 'regex') {
                        try {
                            const m = (change.regex || '').match(/^\/([\s\S]+)\/([a-z]*)$/i);
                            const re = m ? new RegExp(m[1], m[2]) : new RegExp(change.regex, 'g');
                            if (re.test(content)) {
                                content = content.replace(re, change.replace || '');
                                changed = true;
                            }
                        } catch(e) { toastr.error(`[ChatEdit] Invalid regex: ${change.regex}`, EXT_DISPLAY); }
                    }

                    if (changed) {
                        msg.mes = content;
                        await _saveChatMessage(ctx, i, msg);
                        affected++;
                    }
                }
                successLog.push({ ...change, affectedCount: affected });
                continue;
            }

            // msg_indices: apply same operation to each specified index
            if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                let allSuccess = true;
                const sortedIndices = [...change.msg_indices].sort((a, b) =>
                    change.action === 'delete' ? b - a : a - b // delete in reverse to preserve indices
                );
                for (const idx of sortedIndices) {
                    if (idx < 0 || idx >= msgs.length) {
                        toastr.warning(`[ChatEdit] Message #${idx} not found`, EXT_DISPLAY, { timeOut: 6000 });
                        allSuccess = false; continue;
                    }
                    const msg = msgs[idx];
                    if (change.action === 'delete') {
                        msgs.splice(idx, 1);
                        await _saveChatAfterDelete(ctx);
                        continue;
                    }
                    let content = msg.mes || '';
                    if (change.action === 'overwrite') {
                        content = change.content || '';
                    } else if (change.action === 'prepend') {
                        content = (change.content || '') + content;
                    } else if (change.action === 'append') {
                        content = content + (change.content || '');
                    } else if (change.action === 'replace') {
                        let matched = true;
                        for (const patch of (change.patches || [])) {
                            const { result, matched: m } = applySearchReplaceToField(content, patch.search || patch.anchor || '', patch.replace || '');
                            if (!m) { toastr.warning(`[ChatEdit] ANCHOR not found in #${idx}: "${(patch.search || patch.anchor || '').slice(0, 60)}"`, EXT_DISPLAY, { timeOut: 8000 }); matched = false; break; }
                            content = result;
                        }
                        if (!matched) { allSuccess = false; continue; }
                    }
                    msg.mes = content;
                    await _saveChatMessage(ctx, idx, msg);
                }
                if (allSuccess) successLog.push(change);
                continue;
            }

            const resolved = _resolveStMsgByIndexOrId(change);
            if (!resolved) {
                toastr.warning(`[ChatEdit] Message not found: Index ${change.msg_index ?? change.msg_id}`, EXT_DISPLAY, { timeOut: 6000 });
                continue;
            }
            const { idx, msg } = resolved;

            if (change.action === 'delete') {
                msgs.splice(idx, 1);
                if (typeof ctx.deleteMessage === 'function') ctx.deleteMessage(idx);
                else await _saveChatAfterDelete(ctx);
                successLog.push(change);
                continue;
            }

            let content = msg.mes || '';
            if (change.action === 'overwrite') {
                content = change.content || '';
            } else if (change.action === 'prepend') {
                content = (change.content || '') + content;
            } else if (change.action === 'append') {
                content = content + (change.content || '');
            } else if (change.action === 'replace') {
                let allMatched = true;
                for (const patch of (change.patches || [])) {
                    const { result, matched } = applySearchReplaceToField(content, patch.search || patch.anchor || '', patch.replace || '');
                    if (!matched) {
                        toastr.warning(`[ChatEdit] ANCHOR not found in message ${change.msg_index ?? change.msg_id}: "${(patch.search || patch.anchor || '').slice(0, 60)}"`, EXT_DISPLAY, { timeOut: 8000 });
                        allMatched = false; break;
                    }
                    content = result;
                }
                if (!allMatched) continue;
            }
            msg.mes = content;
            await _saveChatMessage(ctx, idx, msg);
            successLog.push(change);
        } catch (e) {
            console.error(`[ST-Copilot-Debug] ChatEdit Failed:`, e);
            toastr.error(`[ChatEdit] Failed on change: ${e.message}`, EXT_DISPLAY, { timeOut: 10000 });
        }
    }

    if (successLog.length > 0) {
        _refreshSTChatDOM(ctx);
        logChatEditHistory(successLog, 'Applied', afterMsgId);
        toastr.success(`[ChatEdit] ${successLog.length} change(s) applied.`, EXT_DISPLAY);
    }
}

export async function _saveChatMessage(ctx, idx, msg) {
    try {
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
        else if (typeof window.saveChat === 'function') await window.saveChat();
        const es = ctx.eventSource || window.eventSource;
        const et = ctx.event_types || window.event_types;
        if (es && et?.MESSAGE_UPDATED) es.emit(et.MESSAGE_UPDATED, { detail: { index: idx, message: msg } });
    } catch(e) { console.warn('[ChatEdit] Save error:', e); }
}

export async function _saveChatAfterDelete(ctx) {
    try {
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
        else if (typeof window.saveChat === 'function') await window.saveChat();
    } catch(e) {}
}

export function _refreshSTChatDOM(ctx) {
    try {
        const es = ctx.eventSource || window.eventSource;
        const et = ctx.event_types || window.event_types;
        if (es && et?.CHAT_CHANGED) es.emit(et.CHAT_CHANGED);
        if (typeof window.printMessages === 'function') window.printMessages();
        else if (typeof ctx.printMessages === 'function') ctx.printMessages();
    } catch(_) {}
}

export function logChatEditHistory(changes, statusStr, afterMsgId = null) {
    if (!changes?.length) return;
    try {
        const session = getCurrentSession();
        const icon = statusStr === 'Applied' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Applied' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED');
        
        const newLines = changes.map(c => {
            let target = `\`#${escHtml(c.msg_index ?? c.msg_id ?? '?')}\``;
            if (c.msg_range && Array.isArray(c.msg_range)) target = `[${c.msg_range[0]}–${c.msg_range[1]}]`;
            if (Array.isArray(c.msg_indices) && c.msg_indices.length) target = `[${c.msg_indices.join(', ')}]`;
            let extras = c.affectedCount !== undefined ? ` (${c.affectedCount} affected)` : '';
            return `${icon} **${actionText}**: \`${escHtml(c.action)}\` on message ${target}${extras}`;
        });
        
        if (afterMsgId && addHistoryToSwipe(afterMsgId, newLines)) return;

        const histText = `**System Notification** — Chat message edits:\n${newLines.join('\n')}`;
        const msg = addMessage(session, 'system', histText, { isChatEditHistory: true, isLBHistory: true, appliedLines: [...newLines] });
        appendLBHistoryEl(msg);
    } catch(_) {}
}

export function renderChatProposalCard(changes, msgEl) {
    if (!changes?.length) return;
    document.querySelector(`.scp-chat-proposal-card[data-for="${msgEl.dataset.id}"]`)?.remove();

    const ctx = SillyTavern.getContext();
    const stMsgs = ctx.chat || [];
    const editableChanges = changes.map(c => JSON.parse(JSON.stringify(c)));
    const itemStates = editableChanges.map(() => 'pending');

    const ACTION_LABELS = { 
        add: '<i class="fa-solid fa-square-plus" style="margin-right: 4px;"></i> Add', 
        replace: '<i class="fa-solid fa-pen-to-square" style="margin-right: 4px;"></i> Replace', 
        overwrite: '<i class="fa-solid fa-rotate" style="margin-right: 4px;"></i> Overwrite', 
        prepend: '<i class="fa-solid fa-arrow-up" style="margin-right: 4px;"></i> Prepend', 
        append: '<i class="fa-solid fa-arrow-down" style="margin-right: 4px;"></i> Append', 
        bulk_replace: '<i class="fa-solid fa-list-check" style="margin-right: 4px;"></i> Bulk', 
        regex: '<i class="fa-solid fa-terminal" style="margin-right: 4px;"></i> Regex', 
        delete: '<i class="fa-solid fa-trash" style="margin-right: 4px;"></i> Delete', 
        hide: '<i class="fa-solid fa-eye-slash" style="margin-right: 4px;"></i> Hide', 
        unhide: '<i class="fa-solid fa-eye" style="margin-right: 4px;"></i> Unhide' 
    };
    
    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card scp-chat-proposal-card';
    card.dataset.for = msgEl.dataset.id;
    card.style.margin = '8px 0 0 0';

    const stripAndSave = () => {
        const session = getCurrentSession();
        const msg = session.messages.find(m => m.id === card.dataset.for);
        if (msg) { 
            msg.content = stripChatChangesBlock(msg.content); 
            if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
            saveSessionsToMetadata(); 
        }
    };

    const persistState = () => {};
    const getPending = () => itemStates.filter(s => s === 'pending').length;
    const checkAllResolved = () => { 
        if (getPending() === 0) { 
            stripAndSave(); 
            card.remove(); 
            const msg = getCurrentSession().messages.find(m => m.id === msgEl.dataset.id);
            if (msg) _renderMsgBodyContent(msgEl, msg);
        } 
    };

    const validateChatChange = (change) => {
        if (change.action === 'add') {
            if (!['user', 'assistant', 'system'].includes(change.role)) return { valid: false, reason: 'Invalid role' };
            if (change.msg_index < 0 || change.msg_index > stMsgs.length + 1) return { valid: false, reason: 'Index out of bounds' };
            return { valid: true };
        }
        let startIdx, endIdx;
        if (['bulk_replace', 'regex', 'hide', 'unhide'].includes(change.action)) {
            if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                const invalid = change.msg_indices.filter(i => i < 0 || i >= stMsgs.length);
                if (invalid.length) return { valid: false, reason: `Indices out of bounds: ${invalid.join(', ')}` };
                if (change.action === 'hide' || change.action === 'unhide') return { valid: true };
                if (change.action === 'bulk_replace') {
                    let anyMatch = false;
                    for (const i of change.msg_indices) {
                        let content = stMsgs[i].mes || '', thisMsgMatch = true;
                        for (const rp of (change.replacements || [])) {
                            if (!rp.search && !rp.anchor) continue;
                            const { matched } = applySearchReplaceToField(content, rp.search || rp.anchor, rp.replace || '');
                            if (!matched) { thisMsgMatch = false; break; }
                        }
                        if (thisMsgMatch && change.replacements?.length > 0) anyMatch = true;
                    }
                    if (!anyMatch) return { valid: false, reason: 'Anchors not found in the specified messages' };
                } else if (change.action === 'regex') {
                    try {
                        const m = (change.regex || '').match(/^\/([\s\S]+)\/([a-z]*)$/i);
                        const re = m ? new RegExp(m[1], m[2]) : new RegExp(change.regex, 'g');
                        const anyMatch = change.msg_indices.some(i => re.test(stMsgs[i].mes || ''));
                        if (!anyMatch) return { valid: false, reason: 'Regex matched nothing in the specified messages' };
                    } catch(e) { return { valid: false, reason: 'Invalid regex syntax' }; }
                }
                return { valid: true };
            }
            if (Array.isArray(change.msg_range)) {
                startIdx = change.msg_range[0]; endIdx = change.msg_range[1];
            } else if (change.msg_index !== undefined) {
                startIdx = change.msg_index; endIdx = change.msg_index;
            } else return { valid: false, reason: 'Target index or range not specified' };
            
            if (startIdx < 0 || endIdx >= stMsgs.length || startIdx > endIdx) return { valid: false, reason: `Range [${startIdx}-${endIdx}] is out of bounds` };

            if (change.action === 'hide' || change.action === 'unhide') return { valid: true };
            
            let anyMatch = false;
            if (change.action === 'bulk_replace') {
                for (let i = startIdx; i <= endIdx; i++) {
                    let content = stMsgs[i].mes || '';
                    let thisMsgMatch = true;
                    for (const rp of (change.replacements || [])) {
                        if (!rp.search && !rp.anchor) continue;
                        const { matched } = applySearchReplaceToField(content, rp.search || rp.anchor, rp.replace || '');
                        if (!matched) { thisMsgMatch = false; break; }
                    }
                    if (thisMsgMatch && change.replacements?.length > 0) anyMatch = true;
                }
                if (!anyMatch) return { valid: false, reason: 'Anchors not found in the specified range' };
            } else if (change.action === 'regex') {
                try {
                    const m = (change.regex || '').match(/^\/([\s\S]+)\/([a-z]*)$/i);
                    const re = m ? new RegExp(m[1], m[2]) : new RegExp(change.regex, 'g');
                    for (let i = startIdx; i <= endIdx; i++) {
                        if (re.test(stMsgs[i].mes || '')) { anyMatch = true; break; }
                    }
                    if (!anyMatch) return { valid: false, reason: 'Regex matched nothing in the specified range' };
                } catch(e) { return { valid: false, reason: 'Invalid regex syntax' }; }
            }
            return { valid: true };
        } else {
            if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                const invalid = change.msg_indices.filter(i => i < 0 || i >= stMsgs.length);
                if (invalid.length) return { valid: false, reason: `Indices out of bounds: ${invalid.join(', ')}` };
                if (change.action === 'replace') {
                    for (const idx of change.msg_indices) {
                        let content = stMsgs[idx].mes || '';
                        for (const patch of (change.patches || [])) {
                            const { matched } = applySearchReplaceToField(content, patch.search || patch.anchor || '', patch.replace || '');
                            if (!matched) return { valid: false, reason: `ANCHOR not found in #${idx}: "${(patch.search || patch.anchor || '').slice(0, 40)}..."` };
                        }
                    }
                }
                return { valid: true };
            }
            const resolved = _resolveStMsgByIndexOrId(change);
            if (!resolved) return { valid: false, reason: `Message not found (Index: ${change.msg_index ?? change.msg_id})` };

            if (change.action === 'replace') {
                let content = resolved.msg.mes || '';
                for (const patch of (change.patches || [])) {
                    const { matched } = applySearchReplaceToField(content, patch.search || patch.anchor || '', patch.replace || '');
                    if (!matched) return { valid: false, reason: `ANCHOR not found: "${(patch.search || patch.anchor || '').slice(0, 40)}..."` };
                }
            }
            return { valid: true };
        }
    };

    const getChatChangeResult = (change, content) => {
        if (change.action === 'overwrite') return change.content || '';
        if (change.action === 'replace') {
            let c = content;
            for (const p of (change.patches || [])) {
                const { result } = applySearchReplaceToField(c, p.search || p.anchor || '', p.replace || '');
                c = result;
            }
            return c;
        }
        if (change.action === 'bulk_replace') {
            let c = content;
            for (const p of (change.replacements || [])) {
                const { result } = applySearchReplaceToField(c, p.search || p.anchor || '', p.replace || '');
                c = result;
            }
            return c;
        }
        if (change.action === 'regex') {
            let c = content;
            try {
                const m = (change.regex || '').match(/^\/([\s\S]+)\/([a-z]*)$/i);
                const re = m ? new RegExp(m[1], m[2]) : new RegExp(change.regex, 'g');
                c = c.replace(re, change.replace || '');
            } catch(e) {}
            return c;
        }
        return content;
    };

    const header = document.createElement('div');
    header.className = 'scp-lb-proposal-header';
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
    const countBadge = document.createElement('span');
    countBadge.className = 'scp-lb-proposal-count';
    countBadge.textContent = `${editableChanges.length} pending`;
    headerLeft.innerHTML = `<span class="scp-lb-proposal-icon" style="color:var(--scp-accent);display:flex">${ICONS.chatEdit}</span><span class="scp-lb-proposal-title">Proposed Chat Edits</span>`;
    headerLeft.appendChild(countBadge);
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'scp-lb-proposal-dismiss'; dismissBtn.innerHTML = ICONS.x; dismissBtn.title = 'Dismiss all';
    dismissBtn.addEventListener('click', () => {
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        if (pending.length > 0) logChatEditHistory(pending, 'Dismissed', card.dataset.for);
        itemStates.forEach((s, i) => { if (s === 'pending') itemStates[i] = 'dismissed'; });
        stripAndSave(); card.remove();
    });
    header.appendChild(headerLeft); header.appendChild(dismissBtn);

    const list = document.createElement('div');
    list.className = 'scp-lb-proposal-list';

    const itemEls = editableChanges.map((c, ci) => {
        const item = document.createElement('div');
        const actionCls = c.action === 'delete' ? 'scp-lb-proposal-delete' : (c.action === 'overwrite' || c.action === 'bulk_replace' || c.action === 'regex' ? 'scp-lb-proposal-edit' : 'scp-lb-proposal-add');
        item.className = `scp-lb-proposal-item ${actionCls}`;

        const hdr = document.createElement('div');
        hdr.className = 'scp-lb-proposal-item-header';

        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;min-width:0';
        
        const targetDescEl = document.createElement('span');
        targetDescEl.className = 'scp-lb-proposal-name scp-lb-pn-target';
        
        const updateTargetDesc = () => {
            const change = editableChanges[ci];
            let targetDesc = '';
            if (change.action === 'add') {
                targetDesc = `Insert at #${change.msg_index} (${change.role})`;
            } else if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                targetDesc = `msgs [${change.msg_indices.join(', ')}]`;
            } else if (['bulk_replace', 'regex', 'hide', 'unhide'].includes(change.action)) {
                if (change.msg_range) targetDesc = `msgs [${change.msg_range[0]}–${change.msg_range[1]}]`;
                else targetDesc = `msg #${change.msg_index}`;
            } else {
                const resolved = _resolveStMsgByIndexOrId(change);
                targetDesc = resolved ? `#${resolved.idx} ${stMsgs[resolved.idx]?.is_user ? '(user)' : '(assistant)'}` : `Index ${change.msg_index ?? change.msg_id}`;
            }
            targetDescEl.textContent = targetDesc;
        };
        updateTargetDesc();

        const actionBadge = document.createElement('span');
        actionBadge.className = 'scp-lb-proposal-action';
        actionBadge.innerHTML = ACTION_LABELS[c.action] || c.action;
        
        meta.appendChild(actionBadge);
        meta.appendChild(targetDescEl);
        
        const warnEl = document.createElement('div');
        warnEl.style.cssText = 'font-size:10px;color:var(--scp-danger);margin-top:4px;width:100%;display:none;cursor:pointer;';
        warnEl.title = 'Click to open the edit panel and fix manually';
        meta.appendChild(warnEl);

        const btns = document.createElement('div');
        btns.className = 'scp-lb-proposal-item-btns';

        if (['replace', 'overwrite', 'bulk_replace', 'regex'].includes(c.action)) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'scp-lb-proposal-diff-btn'; diffBtn.title = 'View diff'; diffBtn.innerHTML = ICONS.diff;
            diffBtn.addEventListener('click', e => {
                e.stopPropagation();
                const change = editableChanges[ci];
                let targetIdxList = [];
                if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                    targetIdxList = change.msg_indices.filter(i => stMsgs[i]);
                } else {
                    let startIdx = change.msg_index !== undefined ? change.msg_index : (change.msg_range ? change.msg_range[0] : null);
                    let endIdx = change.msg_index !== undefined ? change.msg_index : (change.msg_range ? change.msg_range[1] : null);
                    if (startIdx === null || endIdx === null) { toastr.warning('Message index not specified.', EXT_DISPLAY); return; }
                    for (let i = startIdx; i <= endIdx; i++) { if (stMsgs[i]) targetIdxList.push(i); }
                }

                if (!targetIdxList.length) { toastr.warning('Message index not specified.', EXT_DISPLAY); return; }
                
                let origCombined = [];
                let newCombined = [];
                let changesFound = 0;
                
                for (const i of targetIdxList) {
                    const origText = stMsgs[i].mes || '';
                    const newText = getChatChangeResult(change, origText);
                    
                    if (origText !== newText || targetIdxList.length === 1) {
                        const prefix = targetIdxList.length > 1 ? `[Message #${i}]\n` : '';
                        origCombined.push(prefix + origText);
                        newCombined.push(prefix + newText);
                        changesFound++;
                    }
                }

                if (changesFound === 0) {
                    toastr.info('No changes would be made to these messages.', EXT_DISPLAY);
                    return;
                }

                const finalOrig = origCombined.join('\n\n' + '—'.repeat(30) + '\n\n');
                const finalNew = newCombined.join('\n\n' + '—'.repeat(30) + '\n\n');
                const title = targetIdxList.length === 1
                    ? `Diff: ${stMsgs[targetIdxList[0]]?.is_user ? 'User' : 'Copilot/Char'} Message #${targetIdxList[0]}`
                    : `Diff: Messages [${targetIdxList.join(', ')}]`;

                openTextDiffModal(title, finalOrig, finalNew);
            });
            btns.appendChild(diffBtn);
        }

        let editToggleBtn = null;
        let editPanel = null;
        if (c.action !== 'delete') {
            editToggleBtn = document.createElement('button');
            editToggleBtn.className = 'scp-lb-proposal-edit-toggle'; editToggleBtn.title = 'Edit before applying'; editToggleBtn.textContent = '✎';
            btns.appendChild(editToggleBtn);
        }

        const applyBtn = document.createElement('button');
        applyBtn.className = 'scp-lb-proposal-item-apply'; applyBtn.title = 'Apply'; applyBtn.textContent = '✓';
        
        const refreshValidation = () => {
            const { valid, reason } = validateChatChange(editableChanges[ci]);
            if (!valid) {
                applyBtn.disabled = true; applyBtn.title = reason;
                item.style.borderLeftColor = 'var(--scp-danger)';
                warnEl.textContent = `⚠ ${reason}`; warnEl.style.display = 'block';
            } else {
                applyBtn.disabled = false; applyBtn.title = 'Apply';
                item.style.borderLeftColor = ''; 
                warnEl.style.display = 'none';
            }
        };

        applyBtn.addEventListener('click', async e => {
            e.stopPropagation();
            if (itemStates[ci] !== 'pending' || applyBtn.disabled) return;
            applyBtn.disabled = true; applyBtn.textContent = '…';
            try {
                await applyChatChanges([editableChanges[ci]], card.dataset.for);
                itemStates[ci] = 'applied';
                item.classList.add('scp-lb-item-applied');
                btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
                persistState(); countBadge.textContent = `${getPending()} pending`; updateFooterBtns(); syncBlockToMessage(); checkAllResolved();
            } catch(err) {
                toastr.error(`Failed: ${err.message}`, EXT_DISPLAY);
                applyBtn.disabled = false; applyBtn.textContent = '✓';
            }
        });

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'scp-lb-proposal-item-reject'; rejectBtn.title = 'Reject'; rejectBtn.textContent = '✕';
        rejectBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (itemStates[ci] !== 'pending') return;
            itemStates[ci] = 'rejected';
            item.classList.add('scp-lb-item-rejected');
            btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
            logChatEditHistory([editableChanges[ci]], 'Rejected', card.dataset.for);
            persistState(); countBadge.textContent = `${getPending()} pending`; updateFooterBtns(); syncBlockToMessage(); checkAllResolved();
        });
        btns.appendChild(applyBtn); btns.appendChild(rejectBtn);
        hdr.appendChild(meta); hdr.appendChild(btns);
        item.appendChild(hdr);

        const buildPreview = () => {
            const change = editableChanges[ci];
            if (change.action === 'hide') return 'Exclude message(s) from AI prompt context.';
            if (change.action === 'unhide') return 'Include message(s) back into AI context.';
            if (change.action === 'replace' && change.patches?.length) {
                const target = Array.isArray(change.msg_indices) && change.msg_indices.length
                    ? ` (msgs ${change.msg_indices.join(', ')})` : '';
                return change.patches.map((p, pi) => `Patch ${pi+1}${target}: "${(p.search||p.anchor||'').slice(0,60)}" → "${(p.replace||'').slice(0,60)}"`).join('\n');
            }
            if (change.action === 'bulk_replace' && change.replacements?.length) {
                return change.replacements.map(r => `"${(r.search||r.anchor||'').slice(0,40)}" → "${(r.replace||'').slice(0,40)}"`).join('\n');
            }
            if (change.action === 'regex') {
                return `Regex: ${change.regex}\nReplace: ${change.replace || ''}`;
            }
            return change.content || '';
        };
        let _expanded = false;
        const previewEl = document.createElement('div');
        previewEl.className = 'scp-lb-proposal-preview';
        previewEl.style.whiteSpace = 'pre-wrap';
        const refreshPreview = () => {
            const raw = buildPreview();
            previewEl.textContent = (!_expanded && raw.length > 140) ? raw.slice(0, 140) + '…' : raw;
        };
        refreshPreview();
        previewEl.style.cursor = 'pointer';
        previewEl.addEventListener('click', e => { e.stopPropagation(); _expanded = !_expanded; refreshPreview(); });
        item.appendChild(previewEl);

        if (c.action !== 'delete') {
            editPanel = document.createElement('div');
            editPanel.className = 'scp-lb-proposal-edit-panel';
            editPanel.style.display = 'none';

            const mkRow = (labelHtml, el) => {
                const row = document.createElement('div'); row.className = 'scp-lb-pe-row';
                const lbl = document.createElement('label'); lbl.className = 'scp-lb-pe-label'; lbl.innerHTML = labelHtml;
                row.appendChild(lbl); row.appendChild(el); return row;
            };

            const rebuildEditPanel = () => {
                editPanel.innerHTML = '';
                const change = editableChanges[ci];
                
                if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                    const idxInp = document.createElement('input');
                    idxInp.type = 'text'; idxInp.className = 'scp-lb-pe-input';
                    idxInp.value = change.msg_indices.join(', ');
                    idxInp.placeholder = 'e.g. 12, 17, 19';
                    idxInp.addEventListener('input', () => {
                        change.msg_indices = idxInp.value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                        refreshPreview(); refreshValidation(); updateTargetDesc();
                    });
                    editPanel.appendChild(mkRow('Message Indices (comma-separated)', idxInp));
                } else if (change.msg_range) {
                    const rangeRow = document.createElement('div');
                    rangeRow.style.cssText = 'display:flex;gap:8px;';
                    const sInp = document.createElement('input'); sInp.type='number'; sInp.className='scp-lb-pe-input'; sInp.value=change.msg_range[0];
                    const eInp = document.createElement('input'); eInp.type='number'; eInp.className='scp-lb-pe-input'; eInp.value=change.msg_range[1];
                    sInp.addEventListener('input', () => { change.msg_range[0] = parseInt(sInp.value)||0; refreshPreview(); refreshValidation(); updateTargetDesc(); });
                    eInp.addEventListener('input', () => { change.msg_range[1] = parseInt(eInp.value)||0; refreshPreview(); refreshValidation(); updateTargetDesc(); });
                    rangeRow.append(sInp, eInp);
                    editPanel.appendChild(mkRow('Msg Range (Start - End)', rangeRow));
                } else if (change.msg_index !== undefined || change.msg_id !== undefined) {
                    const idxInp = document.createElement('input'); idxInp.type='number'; idxInp.className='scp-lb-pe-input'; idxInp.value=change.msg_index ?? change.msg_id;
                    idxInp.addEventListener('input', () => { change.msg_index = parseInt(idxInp.value)||0; refreshPreview(); refreshValidation(); updateTargetDesc(); });
                    editPanel.appendChild(mkRow('Message Index', idxInp));
                }

                if (['hide', 'unhide'].includes(change.action)) {
                    return;
                }
                if (change.action === 'add') {
                    const roleSel = document.createElement('select');
                    roleSel.className = 'scp-lb-pe-input';
                    ['user', 'assistant', 'system'].forEach(r => {
                        const opt = document.createElement('option'); opt.value = r; opt.textContent = r;
                        roleSel.appendChild(opt);
                    });
                    roleSel.value = change.role || 'assistant';
                    roleSel.addEventListener('change', () => { change.role = roleSel.value; refreshValidation(); updateTargetDesc(); });
                    editPanel.appendChild(mkRow('Role', roleSel));

                    const valueTa = document.createElement('textarea');
                    valueTa.className = 'scp-lb-pe-textarea'; 
                    valueTa.rows = 4; 
                    valueTa.placeholder = 'Type the message content here...';
                    valueTa.value = change.content || '';
                    valueTa.addEventListener('input', () => { 
                        change.content = valueTa.value; 
                        refreshPreview(); 
                        refreshValidation(); 
                    });
                    editPanel.appendChild(mkRow('Content', valueTa));
                } else if (change.action === 'replace') {
                    (change.patches || []).forEach((patch, pi) => {
                        const pHdr = document.createElement('div');
                        pHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px';
                        pHdr.innerHTML = `<span style="font-size:10px;font-weight:700;color:var(--scp-accent);text-transform:uppercase;letter-spacing:.04em">Patch ${pi+1}</span>`;
                        if (change.patches.length > 1) {
                            const delP = document.createElement('button');
                            delP.style.cssText = 'background:none;border:none;color:var(--scp-danger);cursor:pointer;font-size:11px;padding:0;font-family:var(--scp-font)';
                            delP.textContent = '✕ Remove';
                            delP.addEventListener('click', () => { change.patches.splice(pi, 1); rebuildEditPanel(); refreshPreview(); refreshValidation(); });
                            pHdr.appendChild(delP);
                        }
                        editPanel.appendChild(pHdr);
                        const searchTa = document.createElement('textarea');
                        searchTa.className = 'scp-lb-pe-textarea'; searchTa.rows = 2; searchTa.value = patch.search || patch.anchor || '';
                        searchTa.addEventListener('input', () => { change.patches[pi].search = searchTa.value; refreshPreview(); refreshValidation(); });
                        const replaceTa = document.createElement('textarea');
                        replaceTa.className = 'scp-lb-pe-textarea'; replaceTa.rows = 3; replaceTa.value = patch.replace || '';
                        replaceTa.addEventListener('input', () => { change.patches[pi].replace = replaceTa.value; refreshPreview(); refreshValidation(); });
                        editPanel.appendChild(mkRow('Anchor', searchTa));
                        editPanel.appendChild(mkRow('Replace', replaceTa));
                    });
                    const addPatchBtn = document.createElement('button');
                    addPatchBtn.className = 'scp-action-btn'; addPatchBtn.style.marginTop = '8px';
                    addPatchBtn.innerHTML = `${ICONS.plus}<span>Add Patch</span>`;
                    addPatchBtn.addEventListener('click', () => { change.patches.push({ search: '', replace: '' }); rebuildEditPanel(); });
                    editPanel.appendChild(addPatchBtn);
                } else if (change.action === 'bulk_replace') {
                    (change.replacements || []).forEach((rp, ri) => {
                        const searchTa = document.createElement('textarea');
                        searchTa.className = 'scp-lb-pe-textarea'; searchTa.rows = 1; searchTa.value = rp.search || rp.anchor || '';
                        searchTa.addEventListener('input', () => { change.replacements[ri].search = searchTa.value; refreshPreview(); refreshValidation(); });
                        const replaceTa = document.createElement('textarea');
                        replaceTa.className = 'scp-lb-pe-textarea'; replaceTa.rows = 1; replaceTa.value = rp.replace || '';
                        replaceTa.addEventListener('input', () => { change.replacements[ri].replace = replaceTa.value; refreshPreview(); refreshValidation(); });
                        editPanel.appendChild(mkRow(`Replace pair ${ri+1} — Anchor`, searchTa));
                        editPanel.appendChild(mkRow('Replace', replaceTa));
                    });
                } else if (change.action === 'regex') {
                    const regTa = document.createElement('textarea');
                    regTa.className = 'scp-lb-pe-textarea'; regTa.rows = 1; regTa.value = change.regex || '';
                    regTa.addEventListener('input', () => { change.regex = regTa.value; refreshPreview(); refreshValidation(); });
                    editPanel.appendChild(mkRow('Regex Pattern', regTa));
                    
                    const replTa = document.createElement('textarea');
                    replTa.className = 'scp-lb-pe-textarea'; replTa.rows = 2; replTa.value = change.replace || '';
                    replTa.addEventListener('input', () => { change.replace = replTa.value; refreshPreview(); refreshValidation(); });
                    editPanel.appendChild(mkRow('Replace', replTa));
                } else {
                    const valueTa = document.createElement('textarea');
                    valueTa.className = 'scp-lb-pe-textarea'; valueTa.rows = 5; valueTa.value = change.content || '';
                    valueTa.addEventListener('input', () => { change.content = valueTa.value; refreshPreview(); refreshValidation(); });
                    editPanel.appendChild(mkRow('Content', valueTa));
                }
            };
            rebuildEditPanel();
            item.appendChild(editPanel);

            if (editToggleBtn) {
                const toggleEditPanel = (e) => {
                    e.stopPropagation();
                    const isOpen = editPanel.style.display !== 'none';
                    editPanel.style.display = isOpen ? 'none' : 'flex';
                    previewEl.style.display = isOpen ? '' : 'none';
                    editToggleBtn.classList.toggle('active', !isOpen);
                    if (!isOpen) rebuildEditPanel();
                };
                editToggleBtn.addEventListener('click', toggleEditPanel);
                
                warnEl.addEventListener('click', (e) => {
                    if (editPanel.style.display === 'none') toggleEditPanel(e);
                });
            }
        }

        refreshValidation();

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

    const syncBlockToMessage = () => {
        const session = getCurrentSession();
        const msg = session.messages.find(m => m.id === card.dataset.for);
        if (!msg) return;
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        const stripped = stripChatChangesBlock(msg.content);
        if (pending.length === 0) {
            msg.content = stripped;
        } else {
            msg.content = stripped + '\n\n' + reconstructChatChangesBlock(pending);
        }
        if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
        saveSessionsToMetadata();
    };

    const footer = document.createElement('div');
    footer.className = 'scp-lb-proposal-footer';
    const applyAllBtn = document.createElement('button');
    applyAllBtn.className = 'scp-lb-proposal-apply'; applyAllBtn.textContent = 'Apply All';
    const rejectAllBtn = document.createElement('button');
    rejectAllBtn.className = 'scp-lb-proposal-reject'; rejectAllBtn.textContent = 'Reject All';

    const updateFooterBtns = () => {
        const p = getPending();
        applyAllBtn.style.display = p > 0 ? '' : 'none';
        rejectAllBtn.style.display = p > 0 ? '' : 'none';
    };
    updateFooterBtns();

    applyAllBtn.addEventListener('click', async () => {
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        if (!pending.length) return;
        applyAllBtn.disabled = true; applyAllBtn.textContent = 'Applying…';
        try {
            await applyChatChanges(pending, card.dataset.for);
            itemStates.forEach((s, i) => { if (s === 'pending') { itemStates[i] = 'applied'; itemEls[i]?.classList.add('scp-lb-item-applied'); itemEls[i]?.querySelectorAll('button').forEach(b => { b.disabled = true; }); } });
            persistState(); countBadge.textContent = `${getPending()} pending`; updateFooterBtns(); syncBlockToMessage(); checkAllResolved();
        } catch(e) { toastr.error(`Failed: ${e.message}`, EXT_DISPLAY); applyAllBtn.disabled = false; applyAllBtn.textContent = 'Apply All'; }
    });
    rejectAllBtn.addEventListener('click', () => {
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        itemStates.forEach((s, i) => { if (s === 'pending') { itemStates[i] = 'rejected'; itemEls[i]?.classList.add('scp-lb-item-rejected'); itemEls[i]?.querySelectorAll('button').forEach(b => { b.disabled = true; }); } });
        logChatEditHistory(pending, 'Rejected', card.dataset.for);
        persistState(); countBadge.textContent = `${getPending()} pending`; updateFooterBtns(); syncBlockToMessage(); checkAllResolved();
    });

    footer.appendChild(applyAllBtn); footer.appendChild(rejectAllBtn);
    card.appendChild(header); card.appendChild(list); card.appendChild(footer);
    const body = msgEl.querySelector('.scp-msg-body');
    if (body) body.insertBefore(card, body.querySelector('.scp-swipe-bar'));
    else msgEl.after(card);
}
