/**
 * ui-chat.js
 * The chat surface itself: markdown/HTML-block rendering, message DOM
 * creation, swipe management, token counting, the message-count badge,
 * scroll tracking, copy/edit/delete/regen handlers, in-window chat search,
 * and the two entry points that actually drive generation — `runGenerate`
 * (send/regen) and `runContinue` (continue last message) — plus the
 * shared `setGeneratingState`/`showGenerationError`/`handleSend`/
 * `handleRegen` UI-state helpers those two lean on.
 *
 * This is the largest single file in the split (by section count) and the
 * one most other feature files were waiting on: it resolves nearly every
 * remaining injected forward-dependency from earlier files
 * (`renderMsgBodyContent`, `updateMsgCount`, `scrollToBottom`).
 *
 * Moved from original index.js: "Message Rendering" (8303-8925),
 * "Swipe Management" (8926-9330), "Message Interaction Handlers"
 * (9352-9542), "Chat Search" (9543-9696), "Generation Flow" (9697-9910),
 * "Continue Generation" (9911-10071), plus `setGeneratingState` /
 * `showGenerationError` / `handleSend` / `handleRegen` (old lines
 * 10427-10509) — found misplaced inside a "Session Import / Export"
 * section marker; they're generation-state UI, not import/export, so they
 * came here instead. (The real session import/export functions,
 * `exportCurrentSession` etc., were NOT included — they stay for a future
 * pass, e.g. `ui/ui-settings.js`.)
 *
 * A duplicate, dead-weight `getCurrentSession()` was found and removed
 * (identical to the real one already in `session.js`).
 *
 * DEPENDENCY NOTE: two small not-yet-built features are injected —
 * Completion Sound (`playCompletionSound`) and Favorites
 * (`isMessageStarred`/`toggleStarMessage`/`renderFavoritesPanel`). Wire up
 * once those exist:
 *
 *   import { setForwardDeps } from './ui/ui-chat.js';
 *   import { playCompletionSound } from './ui/ui-window.js';           // future
 *   import { isMessageStarred, toggleStarMessage, renderFavoritesPanel } from './features/feature-favorites.js'; // future
 *   setForwardDeps({ playCompletionSound, isMessageStarred, toggleStarMessage, renderFavoritesPanel });
 *
 * DEPENDENCY NOTE: Completion Sound (`playCompletionSound`) isn't built
 * yet — injected. `isMessageStarred`/`toggleStarMessage`/
 * `renderFavoritesPanel` are now real (`feature-favorites.js`), imported
 * directly — no cycle here, favorites doesn't need anything from this file.
 *
 *   import { setForwardDeps } from './ui/ui-chat.js';
 *   import { playCompletionSound } from './ui/ui-window.js'; // future
 *   setForwardDeps({ playCompletionSound });
 *
 * Until wired: the completion sound won't play — everything else
 * (rendering, editing, swiping, searching, sending, regenerating,
 * continuing, starring) works standalone.
 *
 * BUG FIX (later pass): `$` (element-lookup helper) was used 15 times in
 * this file but never imported — added to the util-dom.js import.
 *
 * ADDED (later pass): `setupSearchListeners`, wiring the search bar's
 * DOM buttons/input. This logic originally lived inline inside
 * `attachWindowListeners` in old index.js's "Window Event Listeners"
 * section, but it directly reassigns `_searchQuery`/`_searchWholeWord`/
 * `_searchDebounceId`, which are private to this module — so the setup
 * function lives here and index.js's attachWindowListeners just calls it.
 */

import { EXT_DISPLAY, ICONS } from '../constants.js';
import { dbgAdd } from '../utils/util-debug.js';
import { $, escHtml, showCustomDialog, autoResize, copyText } from '../utils/util-dom.js';
import { getBindingKey } from '../utils/util-st.js';
import { getSettings, saveSettings } from '../settings.js';
import {
    getEffectiveSettings, saveSessionsToMetadata, genId, getActiveSession,
    getCurrentSession, addMessage, updateMessage, truncateAfter, deleteMsg, truncateFrom,
} from '../session.js';
import { STAT, recordStat } from '../features/feature-stats.js';
import {
    expandMacros, assembleMessages, callGenerate,
    getAbortController, abortGeneration, registerHtmlBlock, getHtmlBlock,
} from '../api.js';
import {
    parseCharChangesFromText, stripCharChangesBlock, parseCharCreationFromText,
    stripCharCreationBlock, normalizeCharNamesInBlock, renderCharCreationCard, renderCharProposalCard,
} from '../features/feature-character-engine.js';
import { parseLBChangesFromText, stripLBChangesBlock } from '../features/feature-lorebook-engine.js';
import {
    renderLBHistoryContent, appendLBHistoryEl, parseChatChangesFromText,
    stripChatChangesBlock, renderChatProposalCard,
} from '../features/feature-chatedit-engine.js';
import { renderProposalCard } from '../features/feature-lorebook-ui.js';
import {
    getPendingAttachments, clearPendingAttachments, processAttachmentsBeforeSend,
    renderAttachmentPreviews, _openImageLightbox, _openTextLightbox,
} from '../features/feature-attachments.js';
import {
    isMessageStarred as _isMessageStarred,
    toggleStarMessage as _toggleStarMessage,
    renderFavoritesPanel as _renderFavoritesPanel,
} from '../features/feature-favorites.js';

// ── Injected forward dep (see header note) ──────────────────────────────────
let _playCompletionSound = () => {};

export function setForwardDeps({ playCompletionSound } = {}) {
    if (playCompletionSound) _playCompletionSound = playCompletionSound;
}

// Read access to the generation-in-progress flag for other modules
// (e.g. a future hotkey handler that needs to know whether to abort).
export function isGenerating() { return _generating; }

export function renderMarkdown(text) {
    const codeBlocks = [];
    let out = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        if (lang && lang.toLowerCase() === 'html') {
            const id = registerHtmlBlock(code.trim());
            return `\x00H${id}\x00`;
        }
        const i = codeBlocks.length;
        const escaped = code.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        codeBlocks.push(`<pre class="scp-code-block${lang ? ` lang-${lang}` : ''}"><code>${escaped}</code></pre>`);
        return `\x00B${i}\x00`;
    });

    out = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out = out.replace(/`([^`\n]+)`/g, '<code class="scp-inline-code">$1</code>');

    const applyInline = (s) => {
        let res = s;
        res = res.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        res = res.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        res = res.replace(/~~(.+?)~~/g, '<del>$1</del>');
        res = res.replace(/\*([^<>\*\n]+)\*/g, '<em>$1</em>');
        return res;
    };

    const lines = out.split('\n');

    const getULIndent = (l) => { const m = l.match(/^(\s*)[*\-+]\s+\S/); return m ? m[1].length : -1; };
    const getOLIndent = (l) => { const m = l.match(/^(\s*)\d+\.\s+\S/); return m ? m[1].length : -1; };
    const isListLine = (l) => getULIndent(l) >= 0 || getOLIndent(l) >= 0;

    const buildNestedList = (listLines) => {
        const stack = [];
        let r = '';
        const closeUntil = (targetIndent, targetType) => {
            while (stack.length) {
                const top = stack[stack.length - 1];
                if (top.indent > targetIndent || (top.indent === targetIndent && top.type !== targetType)) {
                    r += `</li></${top.type}>`;
                    stack.pop();
                } else {
                    break;
                }
            }
        };
        for (let line of listLines) {
            if (!line.trim()) continue;
            if (!isListLine(line)) {
                r += `<br>${applyInline(line.trim())}`;
                continue;
            }
            const ulI = getULIndent(line);
            const olI = getOLIndent(line);
            const indent = ulI >= 0 ? ulI : olI;
            const type = ulI >= 0 ? 'ul' : 'ol';
            const cls = `scp-list${type === 'ol' ? ' scp-list-ol' : ''}`;
            
            let content = type === 'ul'
                ? line.replace(/^\s*[*\-+]\s+/, '')
                : line.replace(/^\s*\d+\.\s+/, '');
            
            content = applyInline(content);

            closeUntil(indent, type);
            
            if (stack.length && stack[stack.length - 1].indent === indent && stack[stack.length - 1].type === type) {
                r += `</li><li>${content}`;
            } else {
                r += `<${type} class="${cls}"><li>${content}`;
                stack.push({ indent, type });
            }
        }
        while (stack.length) r += `</li></${stack.pop().type}>`;
        return r;
    };

    const segs = [];
    const pushBlock = (h) => segs.push({ t: 'block', h });
    const pushInline = (h) => segs.push({ t: 'inline', h });

    let listBuf = [];
    let tableRows = [];
    let bqLines = [];

    const flushList = () => {
        if (!listBuf.length) return;
        pushBlock(buildNestedList(listBuf));
        listBuf = [];
    };
    const flushTable = () => {
        if (!tableRows.length) return;
        pushBlock(`<div class="scp-table-wrap"><table class="scp-table"><tbody>${tableRows.join('')}</tbody></table></div>`);
        tableRows = [];
    };
    const flushBq = () => {
        if (!bqLines.length) return;
        pushBlock(`<blockquote class="scp-blockquote">${bqLines.join('<br>')}</blockquote>`);
        bqLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimLine = line.trim();

        if (/^(---+|\*\*\*+|___+)$/.test(trimLine)) {
            flushList(); flushTable(); flushBq();
            pushBlock('<hr class="scp-hr">');
            continue;
        }

        const hm = line.match(/^(#{1,6})\s+(.+)/);
        if (hm) {
            flushList(); flushTable(); flushBq();
            pushBlock(`<span class="scp-h${hm[1].length}">${applyInline(hm[2])}</span>`);
            continue;
        }

        const bq = line.match(/^&gt;\s*(.*)/);
        if (bq) { flushList(); flushTable(); bqLines.push(applyInline(bq[1])); continue; }

        const tm = trimLine.match(/^\|(.*)\|$/);
        if (tm) {
            flushList(); flushBq();
            if (/^[|\s\-:]+$/.test(trimLine)) continue;
            const cells = tm[1].split('|').map(c => applyInline(c.trim()));
            const tag = tableRows.length === 0 ? 'th' : 'td';
            tableRows.push(`<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join('')}</tr>`);
            continue;
        }

        if (isListLine(line)) {
            flushTable(); flushBq();
            listBuf.push(line);
            continue;
        }

        if (listBuf.length > 0 && trimLine && /^\s+/.test(line)) {
            listBuf.push(line);
            continue;
        }

        if (!trimLine) {
            let nextNonEmpty = '';
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim()) { nextNonEmpty = lines[j]; break; }
            }
            if (nextNonEmpty && isListLine(nextNonEmpty)) {
                listBuf.push('');
            } else {
                flushList(); flushTable(); flushBq();
                pushInline('');
            }
            continue;
        }

        flushList(); flushTable(); flushBq();
        pushInline(applyInline(line));
    }
    flushList(); flushTable(); flushBq();

    let result = '';
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.t === 'inline' && i > 0 && segs[i - 1].t === 'inline') result += '<br>';
        result += seg.h;
    }
    out = result;

    out = out.replace(/\x00H(scp-hb-\d+)\x00/g, (_, id) => `<div class="scp-html-block-ph" data-hbid="${id}"></div>`);
    out = out.replace(/\x00B(\d+)\x00/g, (_, i) => codeBlocks[+i]);

    return out;
}

export function prepareHtmlForIframe(code) {
    const cs = `<script>(function(){
export function isTransparent(c){return !c||c==='transparent'||c==='rgba(0, 0, 0, 0)'||c==='rgba(0,0,0,0)';}
export function hasVisualBg(el){
if(!el) return false;
var cs=window.getComputedStyle(el);
if(!isTransparent(cs.backgroundColor)) return true;
if(cs.backgroundImage&&cs.backgroundImage!=='none') return true;
return false;
}
export function applyFallbackTheme(){
var b=document.body,d=document.documentElement;
var hasBg=false;
// 1. computed styles on html + body
if(hasVisualBg(d)||hasVisualBg(b)) hasBg=true;
// 2. any element with inline style containing background
if(!hasBg){
    var styled=document.querySelectorAll('[style]');
    for(var i=0;i<styled.length;i++){if(hasVisualBg(styled[i])){hasBg=true;break;}}
}
// 3. <style> tags with body/html/root background rules
if(!hasBg){
    var styleText='';
    var styleEls=document.querySelectorAll('style');
    for(var j=0;j<styleEls.length;j++) styleText+=styleEls[j].textContent;
    if(/(?:body|html|:root)\s*\{[^}]*background/i.test(styleText)) hasBg=true;
}
if(!hasBg){
    b.style.backgroundColor='#ffffff';
    b.style.color='#1a1a1a';
    window.parent.postMessage({type:'scp-iframe-bg',hasBg:false},'*');
} else {
    window.parent.postMessage({type:'scp-iframe-bg',hasBg:true},'*');
}
}
export function sh(){var b=document.body,d=document.documentElement;var h=Math.max(b?b.scrollHeight:0,b?b.offsetHeight:0,d.scrollHeight,d.offsetHeight);window.parent.postMessage({type:'scp-iframe-h',h:h},'*');}
window.addEventListener('load',function(){
applyFallbackTheme();
sh();setTimeout(sh,150);setTimeout(sh,500);
if(window.ResizeObserver&&document.body){new ResizeObserver(sh).observe(document.body);}
else{var t;try{new MutationObserver(function(){clearTimeout(t);t=setTimeout(sh,80);}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});}catch(e){}}
});
window.onerror=function(m){window.parent.postMessage({type:'scp-iframe-err',msg:String(m)},'*');return true;};
})();<\/script>`;
    const hasHtml = /<html[\s>]/i.test(code);
    if (hasHtml) {
        return /<\/body>/i.test(code) ? code.replace(/<\/body>/i, cs + '</body>') : code + cs;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;padding:8px;font-family:system-ui,sans-serif;background:transparent}</style></head><body>${code}${cs}</body></html>`;
}

export function createHTMLBlockEl(code) {
    const wrap = document.createElement('div');
    wrap.className = 'scp-html-block';

    const toolbar = document.createElement('div');
    toolbar.className = 'scp-html-block-toolbar';
    const label = document.createElement('span');
    label.className = 'scp-html-block-label';
    label.textContent = 'HTML';
    const previewBtn = document.createElement('button');
    previewBtn.className = 'scp-html-block-btn active';
    previewBtn.textContent = 'Preview';
    const codeBtn = document.createElement('button');
    codeBtn.className = 'scp-html-block-btn';
    codeBtn.textContent = 'Code';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'scp-html-block-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', e => { e.stopPropagation(); copyText(code); });
    toolbar.append(label, previewBtn, codeBtn, copyBtn);

    const errorEl = document.createElement('div');
    errorEl.className = 'scp-html-block-error';
    errorEl.style.display = 'none';

    const iframe = document.createElement('iframe');
    iframe.className = 'scp-html-block-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock allow-downloads');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.srcdoc = prepareHtmlForIframe(code);

    const codePre = document.createElement('pre');
    codePre.className = 'scp-code-block scp-html-block-code';
    codePre.style.display = 'none';
    codePre.textContent = code;

    previewBtn.addEventListener('click', () => {
        iframe.style.display = '';
        codePre.style.display = 'none';
        previewBtn.classList.add('active');
        codeBtn.classList.remove('active');
    });
    codeBtn.addEventListener('click', () => {
        iframe.style.display = 'none';
        codePre.style.display = '';
        codeBtn.classList.add('active');
        previewBtn.classList.remove('active');
    });

    wrap.append(toolbar, errorEl, iframe, codePre);
    return wrap;
}

export function postProcessHTMLBlocks(el) {
    el.querySelectorAll('.scp-html-block-ph').forEach(ph => {
        const code = getHtmlBlock(ph.dataset.hbid);
        if (code !== undefined) ph.replaceWith(createHTMLBlockEl(code));
    });
}

export function getDisplayContent(rawText, settings) {
    let text = rawText;
    const trimLines = (settings.reasoningTrimStrings || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const ts of trimLines) text = text.split(ts).join('');
    const pats = [/<think>([\s\S]*?)<\/think>/i, /<thinking>([\s\S]*?)<\/thinking>/i];
    let reasoning = null;
    for (const p of pats) {
        const m = text.match(p);
        if (m) { reasoning = m[1].trim() || null; text = text.replace(m[0], '').trim(); break; }
    }
    return { reasoning, content: text };
}

export function createMsgEl(msg, onCopy, onEdit, onDelete, onRegen) {
    const isUser = msg.role === 'user';
    const wrap = document.createElement('div');
    wrap.className = `scp-msg ${isUser ? 'scp-msg-user' : 'scp-msg-assistant'}`;
    wrap.dataset.id = msg.id;

    const avatarWrap = document.createElement('div');
    avatarWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0';

    const avatar = document.createElement('div');
    avatar.className = 'scp-msg-avatar';
    avatar.innerHTML = isUser ? ICONS.user : ICONS.bot;

    const tokenCountEl = document.createElement('div');
    tokenCountEl.className = 'scp-msg-token-count';
    tokenCountEl.textContent = '…';
    _updateMsgTokenCount({ querySelector: () => tokenCountEl, isConnected: true }, msg.content);

    avatarWrap.appendChild(avatar);
    avatarWrap.appendChild(tokenCountEl);

    const body = document.createElement('div');
    body.className = 'scp-msg-body';

    const content = document.createElement('div');
    content.className = 'scp-msg-content';
    body.appendChild(content);

    const meta = document.createElement('div');
    meta.className = 'scp-msg-meta';
    meta.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const actions = document.createElement('div');
    actions.className = 'scp-msg-actions';

    const makeBtn = (icon, label, cls, cb) => {
        const b = document.createElement('button');
        b.className = `scp-msg-btn${cls ? ' ' + cls : ''}`;
        b.innerHTML = icon; b.title = label;
        b.addEventListener('click', cb);
        return b;
    };

    actions.appendChild(makeBtn(ICONS.copy, 'Copy', '', () => onCopy(msg)));
    actions.appendChild(makeBtn(ICONS.edit, 'Edit', '', () => onEdit(wrap, msg)));
    actions.appendChild(makeBtn(ICONS.refresh, 'Regen', '', () => onRegen(wrap, msg)));
    actions.appendChild(makeBtn(ICONS.trash, 'Delete', 'scp-msg-btn-danger', () => onDelete(wrap, msg)));

    const isStarred = _isMessageStarred(msg.id);
    const starBtn = makeBtn(isStarred ? ICONS.starFill : ICONS.star, isStarred ? 'Unstar' : 'Star message', `scp-msg-btn-star${isStarred ? ' starred' : ''}`, () => {
        const nowStarred = _toggleStarMessage(msg.id);
        starBtn.innerHTML = nowStarred ? ICONS.starFill : ICONS.star;
        starBtn.title = nowStarred ? 'Unstar' : 'Star message';
        starBtn.classList.toggle('starred', nowStarred);
        wrap.classList.toggle('scp-msg-starred', nowStarred);
        if (document.getElementById('scp-fav-panel')?.style.display !== 'none') _renderFavoritesPanel();
    });
    actions.appendChild(starBtn);
    if (isStarred) wrap.classList.add('scp-msg-starred');

    if (!isUser) {
        const continueBtn = makeBtn(ICONS.continueArrow, 'Continue response', 'scp-msg-btn-continue', () => runContinue(getCurrentSession(), msg.id));
        actions.appendChild(continueBtn);
    }

    body.appendChild(actions); body.appendChild(meta);

    // Swipe bar
    if (!isUser) {
        const swipeBar = document.createElement('div');
        swipeBar.className = 'scp-swipe-bar';
        swipeBar.style.display = 'none';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'scp-swipe-btn scp-swipe-prev';
        prevBtn.innerHTML = ICONS.chevronLeft;
        prevBtn.title = 'Previous swipe';
        prevBtn.disabled = true;

        const counter = document.createElement('span');
        counter.className = 'scp-swipe-counter';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'scp-swipe-btn scp-swipe-next';
        nextBtn.innerHTML = ICONS.chevronRight;
        nextBtn.title = 'New swipe (regenerate)';

        prevBtn.addEventListener('click', async () => {
            if (prevBtn.disabled || _generating) return;
            const session = getCurrentSession();
            if (!getSwipesForMsg(session, msg.id)) return;
            
            const bdy = wrap.querySelector('.scp-msg-body');
            if (bdy) {
                bdy.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
                bdy.classList.add('scp-swipe-anim-out-right'); 
                await new Promise(r => setTimeout(r, 150));
            }
            
            if (navigateSwipe(session, msg.id, -1)) {
                if (bdy) {
                    bdy.classList.remove('scp-swipe-anim-out-right');
                    void bdy.offsetWidth;
                    bdy.classList.add('scp-swipe-anim-left'); 
                }
                renderMsgBodyContent(wrap, session.messages.find(m => m.id === msg.id));
                updateSwipeBar(wrap, session, msg.id);
            }
        });

        nextBtn.addEventListener('click', async () => {
            if (nextBtn.disabled || _generating) return;
            const session = getCurrentSession();
            const msgData = session.messages.find(m => m.id === msg.id);
            if (!msgData) return;
            
            if (msgData.swipeIndex !== undefined && msgData.swipeIndex < (msgData.swipes?.length || 1) - 1) {
                const bdy = wrap.querySelector('.scp-msg-body');
                if (bdy) {
                    bdy.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
                    bdy.classList.add('scp-swipe-anim-out-left'); 
                    await new Promise(r => setTimeout(r, 150));
                }

                if (navigateSwipe(session, msg.id, 1)) {
                    if (bdy) {
                        bdy.classList.remove('scp-swipe-anim-out-left');
                        void bdy.offsetWidth;
                        bdy.classList.add('scp-swipe-anim-right'); 
                    }
                    renderMsgBodyContent(wrap, session.messages.find(m => m.id === msg.id));
                    updateSwipeBar(wrap, session, msg.id);
                }
            } else {
                _runSwipeRegen(session, msg.id, wrap);
            }
        });

        swipeBar.appendChild(prevBtn);
        swipeBar.appendChild(counter);
        swipeBar.appendChild(nextBtn);
        body.appendChild(swipeBar);
    }

    wrap.appendChild(avatarWrap); wrap.appendChild(body);
    renderMsgBodyContent(wrap, msg);
    
    return wrap;
}

export async function _runSwipeRegen(session, msgId, wrapEl) {
    if (_generating) return;
    const msgData = session.messages.find(m => m.id === msgId);
    if (!msgData) return;

    if (!msgData.swipes) {
        msgData.swipes = [{ content: msgData.content, reasoning: msgData.reasoning || null }];
        msgData.swipeIndex = 0;
    }

    _generating = true;
    const settings = getEffectiveSettings();
    setGeneratingState(true);

    const body = wrapEl.querySelector('.scp-msg-body');
    if (body) {
        body.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
        body.classList.add('scp-swipe-anim-out-left');
        await new Promise(r => setTimeout(r, 150));
    }

    const placeholderContent = '';
    msgData.swipes.push({ content: placeholderContent, reasoning: null });
    msgData.swipeIndex = msgData.swipes.length - 1;
    msgData.content = placeholderContent;
    msgData.reasoning = null;
    saveSessionsToMetadata();

    updateSwipeBar(wrapEl, session, msgId);

    let streamContentEl = wrapEl.querySelector('.scp-msg-content');
    if (streamContentEl) streamContentEl.innerHTML = '';
    const rBlock = wrapEl.querySelector('.scp-reasoning-block');
    if (rBlock) rBlock.style.display = 'none';
    
    wrapEl.querySelectorAll('.scp-lb-proposal-card').forEach(c => c.remove());
    wrapEl.querySelectorAll('.scp-msg-hist-wrap').forEach(c => c.remove());

    if (body) {
        body.classList.remove('scp-swipe-anim-out-left');
        void body.offsetWidth;
        body.classList.add('scp-swipe-anim-right');
    }

    let cursorEl = null;
    let streamAccumText = '';
    let streamAccumReasoning = null;

    const cleanupCursor = () => { if (cursorEl?.parentNode) cursorEl.remove(); cursorEl = null; };

    const onChunk = (text, reasoning) => {
        streamAccumText = text;
        streamAccumReasoning = reasoning;
        if (!cursorEl) {
            cursorEl = document.createElement('span');
            cursorEl.className = 'scp-stream-cursor';
            const bar = document.getElementById('scp-thinking-bar');
            if (bar) bar.style.display = 'flex';
            document.getElementById('scp-thinking-text') && (document.getElementById('scp-thinking-text').textContent = 'Streaming…');
        }
        if (streamContentEl) {
            const { content: disp } = getDisplayContent(text, settings);
            streamContentEl.innerHTML = renderMarkdown(disp);
            if (text) streamContentEl.appendChild(cursorEl);
        }
        smartScrollToBottom();
    };

    try {
        const messagesForRegen = [];
        const tempSession = { ...session, messages: session.messages.filter(m => m.id !== msgId) };
        const builtMessages = await assembleMessages(tempSession, settings, null);
        const fullPromptText = builtMessages.map(m => m.content).join('\n');
        const tokensIn = await estimateTokens(fullPromptText);

        const result = await callGenerate(tempSession, settings, null, onChunk);
        cleanupCursor();

        if (result === null) {
            msgData.swipes.pop();
            msgData.swipeIndex = msgData.swipes.length - 1;
            msgData.content = msgData.swipes[msgData.swipeIndex]?.content || '';
            msgData.reasoning = msgData.swipes[msgData.swipeIndex]?.reasoning || null;
            saveSessionsToMetadata();
            renderMsgBodyContent(wrapEl, msgData);
            updateSwipeBar(wrapEl, session, msgId);
            return;
        }

        const { text: rawText, reasoning: fullReasoning } = result;
        const fullText = normalizeCharNamesInBlock(rawText);

        msgData.swipes[msgData.swipeIndex] = { content: fullText, reasoning: fullReasoning || null };
        msgData.content = fullText;
        msgData.reasoning = fullReasoning || null;
        saveSessionsToMetadata();

        renderMsgBodyContent(wrapEl, msgData);
        updateSwipeBar(wrapEl, session, msgId);

        if (tokensIn > 0) recordStat(STAT.tokIn, tokensIn);
        const tokensOut = await estimateTokens(fullText);
        if (tokensOut > 0) recordStat(STAT.tokOut, tokensOut);
        recordStat(STAT.regen);
        updateMsgCount(session);
        _playCompletionSound();

    } catch(err) {
        cleanupCursor();
        msgData.swipes.pop();
        msgData.swipeIndex = msgData.swipes.length - 1;
        msgData.content = msgData.swipes[msgData.swipeIndex]?.content || '';
        msgData.reasoning = msgData.swipes[msgData.swipeIndex]?.reasoning || null;
        saveSessionsToMetadata();
        renderMsgBodyContent(wrapEl, msgData);
        updateSwipeBar(wrapEl, session, msgId);

        if (getAbortController()?.signal?.aborted || err?.message === 'userStopped') {} 
        else { showGenerationError(err); }
    } finally {
        _generating = false;
        setGeneratingState(false);
    }
}

export function _refreshSwipeBars(session) {
    const c = $('scp-messages');
    if (!c) return;
    c.querySelectorAll('.scp-swipe-bar').forEach(bar => { bar.style.display = 'none'; });
    if (_generating) return;
    const lastId = getLastAssistantMsgId(session);
    if (!lastId) return;
    const lastEl = c.querySelector(`.scp-msg[data-id="${lastId}"]`);
    if (!lastEl) return;
    const swipeBar = lastEl.querySelector('.scp-swipe-bar');
    if (!swipeBar) return;
    updateSwipeBar(lastEl, session, lastId);
    swipeBar.style.display = '';
}

let _userScrolledUp = false;

// ui-window.js's Visibility section resets this when the window is shown
// again, so a stale "user had scrolled up" flag doesn't suppress
// auto-scroll the next time a message comes in.
export function resetUserScrolledUp() { _userScrolledUp = false; }

export function scrollToBottom() {
    const c = $('scp-messages');
    if (!c) return;
    _userScrolledUp = false;
    c.scrollTop = c.scrollHeight;
}

export function smartScrollToBottom() {
    if (_userScrolledUp) return;
    const c = $('scp-messages');
    if (c) c.scrollTop = c.scrollHeight;
}

export function setupMessagesScrollTracking() {
    const c = $('scp-messages');
    if (!c) return;
    c.addEventListener('scroll', () => {
        _userScrolledUp = c.scrollHeight - c.scrollTop - c.clientHeight > 80;
    }, { passive: true });
}

export function _refreshContinueBtns() {
    const c = $('scp-messages');
    if (!c) return;
    c.querySelectorAll('.scp-msg-last-assistant').forEach(el => el.classList.remove('scp-msg-last-assistant'));
    if (_generating) return;
    const all = [...c.querySelectorAll('.scp-msg-assistant')];
    if (all.length) all[all.length - 1].classList.add('scp-msg-last-assistant');
}


export function getLastAssistantMsgId(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.role === 'user') return null;
        if (m.role === 'assistant' && !m.isLBHistory && !m.isCharEditHistory && !m.isChatEditHistory) {
            return m.id;
        }
    }
    return null;
}

export function getSwipesForMsg(session, msgId) {
    const msg = session.messages.find(m => m.id === msgId);
    if (!msg) return null;
    if (!msg.swipes) msg.swipes = [{ content: msg.content, reasoning: msg.reasoning || null }];
    if (msg.swipeIndex === undefined) msg.swipeIndex = 0;
    return msg;
}

export function addSwipe(session, msgId, content, reasoning = null) {
    const msg = getSwipesForMsg(session, msgId);
    if (!msg) return;
    msg.swipes.push({ content, reasoning: reasoning || null });
    msg.swipeIndex = msg.swipes.length - 1;
    msg.content = content;
    msg.reasoning = reasoning || null;
    saveSessionsToMetadata();
}

export function navigateSwipe(session, msgId, dir) {
    const msg = getSwipesForMsg(session, msgId);
    if (!msg || msg.swipes.length < 2) return false;
    const newIdx = msg.swipeIndex + dir;
    if (newIdx < 0 || newIdx >= msg.swipes.length) return false;
    msg.swipeIndex = newIdx;
    msg.content = msg.swipes[newIdx].content;
    msg.reasoning = msg.swipes[newIdx].reasoning || null;
    saveSessionsToMetadata();
    updateMsgCount(session);
    return true;
}

export function updateSwipeBar(msgEl, session, msgId) {
    const bar = msgEl.querySelector('.scp-swipe-bar');
    if (!bar) return;
    const msg = session.messages.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.swipes) {
        msg.swipes = [{ content: msg.content, reasoning: msg.reasoning || null }];
        msg.swipeIndex = 0;
    }
    const total = msg.swipes.length;
    const cur = (msg.swipeIndex ?? 0) + 1;
    const prevBtn = bar.querySelector('.scp-swipe-prev');
    const nextBtn = bar.querySelector('.scp-swipe-next');
    const counter = bar.querySelector('.scp-swipe-counter');
    if (prevBtn) prevBtn.disabled = cur <= 1 || _generating;
    if (nextBtn) nextBtn.disabled = _generating;
    if (counter) counter.innerHTML = `<span>${cur}</span>/${total}`;
    bar.style.display = '';
}

export function renderMsgBodyContent(msgEl, msg) {
    const settings = getSettings();
    let displayText = msg.content;
    let reasoning = null;
    if (msg.reasoning !== undefined) {
        reasoning = msg.reasoning || null;
    } else {
        const d = getDisplayContent(msg.content, settings);
        reasoning = d.reasoning;
        displayText = d.content;
    }

    const body = msgEl.querySelector('.scp-msg-body');
    if (!body) return;

    msgEl.querySelectorAll('.scp-lb-proposal-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-char-proposal-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-char-creation-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-chat-proposal-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-msg-hist-wrap').forEach(c => c.remove());

    let rBlock = msgEl.querySelector('.scp-reasoning-block');
    if (reasoning) {
        if (!rBlock) {
            rBlock = document.createElement('details');
            rBlock.className = 'scp-reasoning-block';
            rBlock.innerHTML = `<summary class="scp-reasoning-summary">Reasoning</summary><div class="scp-reasoning-content"></div>`;
            body.insertBefore(rBlock, body.firstChild);
        }
        rBlock.querySelector('.scp-reasoning-content').innerHTML = renderMarkdown(reasoning);
    } else if (rBlock) {
        rBlock.remove();
    }

    const contentEl = msgEl.querySelector('.scp-msg-content');
    
    if (msg.attachments && msg.attachments.length > 0) {
        const attWrap = document.createElement('div');
        attWrap.className = 'scp-msg-attachments';
        msg.attachments.forEach(att => {
            const badge = document.createElement('div');
            badge.className = 'scp-msg-att-badge';
            if (att.isImage) {
                badge.innerHTML = `<img src="${att.dataUrl}"> <span>${escHtml(att.name)}</span>`;
                badge.onclick = () => _openImageLightbox(att);
            } else {
                badge.innerHTML = `<i class="fa-solid fa-file"></i> <span>${escHtml(att.name)}</span>`;
                badge.onclick = () => _openTextLightbox(att);
            }
            attWrap.appendChild(badge);
        });
        body.insertBefore(attWrap, body.firstChild);
    }
    if (contentEl) {
        const lbChanges = parseLBChangesFromText(msg.content);
        const charChanges = parseCharChangesFromText(msg.content);
        const charCreation = parseCharCreationFromText(msg.content);
        const chatChanges = parseChatChangesFromText(msg.content);
        const needsStrip = lbChanges?.length || charChanges?.length || charCreation || chatChanges?.length;

        if (needsStrip) {
            let stripped = msg.content;
            if (lbChanges?.length) stripped = stripLBChangesBlock(stripped);
            if (charChanges?.length) stripped = stripCharChangesBlock(stripped);
            if (charCreation) stripped = stripCharCreationBlock(stripped);
            if (chatChanges?.length) stripped = stripChatChangesBlock(stripped);
            
            contentEl.innerHTML = renderMarkdown(getDisplayContent(stripped, settings).content);
            postProcessHTMLBlocks(contentEl);
            
            if (lbChanges?.length) renderProposalCard(lbChanges, msgEl);
            if (charChanges?.length) renderCharProposalCard(charChanges, msgEl);
            if (charCreation) renderCharCreationCard(charCreation, msgEl);
            if (chatChanges?.length) renderChatProposalCard(chatChanges, msgEl);
        } else {
            contentEl.innerHTML = renderMarkdown(getDisplayContent(displayText, settings).content);
            postProcessHTMLBlocks(contentEl);
        }
    }

    const currentSwipe = msg.swipes?.[msg.swipeIndex || 0];
    if (currentSwipe?.historyLines?.length) {
        const hw = document.createElement('div');
        hw.className = 'scp-msg-hist-wrap';
        
        const cEl = document.createElement('div');
        cEl.className = 'scp-msg-content scp-lb-history-content';
        cEl.style.cssText = 'margin-top:10px; padding:8px 12px; background:var(--scp-accent-bg); border:1px solid var(--scp-accent-dim); border-radius:6px;';
        renderLBHistoryContent({ appliedLines: currentSwipe.historyLines }, cEl);
        hw.appendChild(cEl);
        
        const swipeBar = body.querySelector('.scp-swipe-bar');
        if (swipeBar) body.insertBefore(hw, swipeBar);
        else body.appendChild(hw);
    }

    _updateMsgTokenCount(msgEl, msg.content, true);
}

let _tokenCountCache = new Map();
const DISPLAY_MESSAGE_BATCH_SIZE = 40;
let _renderedMessageStartIndex = 0;

function appendRenderedMessage(msg, beforeEl = null) {
    const c = $('scp-messages');
    if (!c) return;
    if (msg.isLBHistory) {
        appendLBHistoryEl(msg, null, beforeEl);
        return;
    }
    const el = createMsgEl(msg, handleCopy, handleEdit, handleDelete, handleMessageRegen);
    c.insertBefore(el, beforeEl);
}

function loadOlderMessageBatch(session, preserveScroll = true) {
    const c = $('scp-messages');
    const button = c?.querySelector('.scp-load-older-btn');
    if (!c || !button || _renderedMessageStartIndex <= 0) return false;

    const previousStart = _renderedMessageStartIndex;
    const nextStart = Math.max(0, previousStart - DISPLAY_MESSAGE_BATCH_SIZE);
    const previousHeight = c.scrollHeight;
    const previousScrollTop = c.scrollTop;
    for (const msg of session.messages.slice(nextStart, previousStart).reverse()) {
        appendRenderedMessage(msg, button.nextElementSibling);
    }
    _renderedMessageStartIndex = nextStart;
    if (_renderedMessageStartIndex > 0) {
        button.textContent = `Load older messages (${_renderedMessageStartIndex})`;
    } else {
        button.remove();
    }
    if (preserveScroll) c.scrollTop = previousScrollTop + c.scrollHeight - previousHeight;
    _refreshContinueBtns();
    _refreshSwipeBars(session);
    return true;
}

function renderLoadOlderButton(session) {
    const c = $('scp-messages');
    if (!c || _renderedMessageStartIndex <= 0) return null;
    const button = document.createElement('button');
    button.className = 'scp-load-older-btn';
    button.type = 'button';
    button.textContent = `Load older messages (${_renderedMessageStartIndex})`;
    button.addEventListener('click', () => loadOlderMessageBatch(session));
    c.appendChild(button);
    return button;
}

export function revealMessage(msgId) {
    const session = getCurrentSession();
    const targetIndex = session.messages.findIndex(msg => msg.id === msgId);
    if (targetIndex === -1) return null;
    while (targetIndex < _renderedMessageStartIndex && loadOlderMessageBatch(session, false)) {}
    return document.querySelector(`.scp-msg[data-id="${msgId}"]`);
}

export function _updateMsgTokenCount(msgEl, content, forceRecalc = false) {
    const el = msgEl.querySelector ? msgEl.querySelector('.scp-msg-token-count') : null;
    if (!el) return;
    if (!forceRecalc) {
        const cached = _tokenCountCache.get(content);
        if (cached !== undefined) { el.textContent = `${cached}t`; return; }
    } else {
        el.textContent = '\u2026';
    }
    estimateTokens(content).then(n => {
        _tokenCountCache.set(content, n);
        if (el.isConnected) el.textContent = `${n}t`;
    });
}

export function renderSession(session) {
    clearSearchHighlights();
    _searchMatches = [];
    _searchIdx = -1;
    updateSearchCount();
    const c = $('scp-messages');
    if (!c) return;
    c.innerHTML = '';
    if (!session.messages.length) {
        c.innerHTML = `
            <div class="scp-empty-state">
                <div class="scp-empty-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7" /><ellipse cx="12" cy="12" rx="11" ry="3" transform="rotate(-25 12 12)" /><circle cx="21.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" /></svg>
                </div>
                <div class="scp-empty-title">New Session</div>
                <div class="scp-empty-sub">Ask anything about your roleplay — continuity checks, character analysis, writing feedback, worldbuilding, and more.</div>
            </div>`;
        updateMsgCount(session);
        return;
    }
    _renderedMessageStartIndex = Math.max(0, session.messages.length - DISPLAY_MESSAGE_BATCH_SIZE);
    renderLoadOlderButton(session);
    for (const msg of session.messages.slice(_renderedMessageStartIndex)) {
        appendRenderedMessage(msg);
    }
    updateMsgCount(session);
    scrollToBottom();
    _refreshContinueBtns();
    _refreshSwipeBars(session);
}

export function resetRenderedHistory() {
    renderSession(getCurrentSession());
}

export function appendMsgEl(msg) {
    const c = $('scp-messages');
    if (!c) return;
    c.querySelector('.scp-empty-state')?.remove();

    const el = createMsgEl(msg, handleCopy, handleEdit, handleDelete, handleMessageRegen);
    c.appendChild(el);
    clearTimeout(_tokenCalcTid);
    const session = getCurrentSession();
    updateMsgCount(session);
    scrollToBottom();
    _refreshContinueBtns();
    _refreshSwipeBars(session);

    if (_searchOpen && _searchQuery.trim()) {
        const newMarks = _applyHighlightsInRoot(el);
        if (newMarks.length) {
            _searchMatches.push(...newMarks);
            updateSearchCount();
        }
    }
}

export function removeMsgEl(msgId) {
    const el = document.querySelector(`.scp-msg[data-id="${msgId}"]`);
    if (!el) return;
    document.querySelector(`.scp-lb-proposal-card[data-for="${msgId}"]`)?.remove();
    document.querySelector(`.scp-char-proposal-card[data-for="${msgId}"]`)?.remove();
    document.querySelector(`.scp-char-creation-card[data-for="${msgId}"]`)?.remove();
    document.querySelector(`.scp-chat-proposal-card[data-for="${msgId}"]`)?.remove();
    el.remove();
    _refreshContinueBtns();
    _refreshSwipeBars(getCurrentSession());
}

export function removeMsgElAndBelow(msgId) {
    const c = $('scp-messages'); if (!c) return;
    let found = false;
    for (const el of [...c.querySelectorAll('.scp-msg')]) {
        if (el.dataset.id === msgId) found = true;
        if (found) {
            document.querySelector(`.scp-lb-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-char-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-char-creation-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-chat-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            el.remove();
        }
    }
    c.querySelectorAll('.scp-lb-proposal-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    c.querySelectorAll('.scp-char-proposal-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    c.querySelectorAll('.scp-char-creation-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    c.querySelectorAll('.scp-chat-proposal-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    _refreshContinueBtns();
    _refreshSwipeBars(getCurrentSession());
}

export function removeMsgElAfter(msgId) {
    const c = $('scp-messages'); if (!c) return;
    let found = false;
    for (const el of [...c.querySelectorAll('.scp-msg')]) {
        if (found) {
            document.querySelector(`.scp-lb-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-char-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-char-creation-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-chat-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            el.remove();
        }
        if (el.dataset.id === msgId) found = true;
    }
    _refreshContinueBtns();
    _refreshSwipeBars(getCurrentSession());
}

let _tokenCalcTid = null;
const _tokenCountPromises = new Map();

export async function estimateTokens(text) {
    if (!text) return 0;
    let str = text;
    if (Array.isArray(text)) {
        str = text.map(t => t.type === 'text' ? t.text : '').join('\n');
    }
    
    if (_tokenCountCache.has(str)) return _tokenCountCache.get(str);
    if (_tokenCountPromises.has(str)) return _tokenCountPromises.get(str);

    const promise = (async () => {
        const ctx = SillyTavern.getContext();
        
        try {
            if (typeof ctx.getTokenCountAsync === 'function') return await ctx.getTokenCountAsync(str);
            if (typeof window.getTokenCountAsync === 'function') return await window.getTokenCountAsync(str);
        } catch (_) {}
        
        await new Promise(resolve => setTimeout(resolve, 0));

        try {
            if (typeof ctx.getTokenCount === 'function') return ctx.getTokenCount(str);
            if (typeof window.getTokenCount === 'function') return window.getTokenCount(str);
        } catch (_) {}
        
        try {
            const res = await fetch('/api/tokencount', {
                method: 'POST',
                headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: str })
            });
            if (res.ok) {
                const data = await res.json();
                if (typeof data.length === 'number') return data.length;
                if (typeof data.count === 'number') return data.count;
                if (typeof data === 'number') return data;
            }
        } catch (_) {}
        
        return Math.ceil(str.length / 3.5);
    })();

    _tokenCountPromises.set(str, promise);
    try {
        const count = await promise;
        if (_tokenCountCache.size > 500) {
            const keysToDel = Array.from(_tokenCountCache.keys()).slice(0, 100);
            keysToDel.forEach(k => _tokenCountCache.delete(k));
        }
        _tokenCountCache.set(str, count);
        return count;
    } finally {
        _tokenCountPromises.delete(str);
    }
}

let _isTokenCalculating = false;
let _pendingTokenCalc = false;

export function updateMsgCount(session) {
    const el = $('scp-msg-count');
    if (el && session) el.textContent = `${session.messages.length} msgs`;
    
    const tel = $('scp-token-count');
    if (tel && session) {
        clearTimeout(_tokenCalcTid);
        if (!_isTokenCalculating) tel.textContent = '... tkns';
        
        _tokenCalcTid = setTimeout(async () => {
            if (_isTokenCalculating) {
                _pendingTokenCalc = true;
                return;
            }
            
            const runCalc = async () => {
                _isTokenCalculating = true;
                try {
                    await new Promise(r => setTimeout(r, 0));
                    
                    const settings = getEffectiveSettings();
                    const currentInput = document.getElementById('scp-input')?.value || '';
                    
                    const processedAtts = await processAttachmentsBeforeSend(getPendingAttachments(), true);
                    const messages = await assembleMessages(session, settings, currentInput, processedAtts);
                    
                    const fullText = messages.map(m => {
                        let c = m.content;
                        if (Array.isArray(c)) {
                            return c.map(part => part.type === 'text' ? part.text : '').join('\n');
                        }
                        return c;
                    }).join('\n');
                    
                    const count = await estimateTokens(fullText);
                    const telNode = $('scp-token-count');
                    if (telNode) telNode.textContent = `~${count} tkns`;
                } finally {
                    _isTokenCalculating = false;
                    if (_pendingTokenCalc) {
                        _pendingTokenCalc = false;
                        runCalc();
                    }
                }
            };
            
            runCalc();
        }, 800);
    }
}



export function handleCopy(msg) { copyText(msg.content); }

export function handleEdit(wrapEl, msg) {
    if (wrapEl.classList.contains('is-editing')) return;
    wrapEl.classList.add('is-editing');
    const { charId, chatId } = getBindingKey();
    const session = getActiveSession(charId, chatId);
    const contentEl = wrapEl.querySelector('.scp-msg-content');
    const original = msg.content;

    const ta = document.createElement('textarea');
    ta.className = 'scp-edit-ta';
    ta.value = original;

    const row = document.createElement('div');
    row.className = 'scp-edit-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'scp-edit-btn scp-edit-save';
    saveBtn.innerHTML = msg.role === 'user'
        ? `${ICONS.check}<span>Save & Resend</span>`
        : `${ICONS.check}<span>Save</span>`;

    const saveOnlyBtn = msg.role === 'user' ? document.createElement('button') : null;
    if (saveOnlyBtn) {
        saveOnlyBtn.className = 'scp-edit-btn scp-edit-cancel';
        saveOnlyBtn.innerHTML = `${ICONS.check}<span>Save</span>`;
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'scp-edit-btn scp-edit-cancel';
    cancelBtn.innerHTML = `${ICONS.x}<span>Cancel</span>`;

    row.appendChild(saveBtn);
    if (saveOnlyBtn) row.appendChild(saveOnlyBtn);
    row.appendChild(cancelBtn);
    contentEl.replaceWith(ta);
    wrapEl.querySelector('.scp-msg-actions').after(row);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    autoResize(ta); ta.addEventListener('input', () => autoResize(ta));

    const restoreMessageDOM = (textToRender) => {
        const nc = document.createElement('div');
        nc.className = 'scp-msg-content';

        const lbChanges = parseLBChangesFromText(textToRender);
        const charChanges = parseCharChangesFromText(textToRender);
        const charCreation = parseCharCreationFromText(textToRender);
        const chatChanges = parseChatChangesFromText(textToRender);
        let stripped = textToRender;
        
        if (lbChanges?.length) { 
            stripped = stripLBChangesBlock(stripped); 
            renderProposalCard(lbChanges, wrapEl); 
        } else document.querySelector(`.scp-lb-proposal-card[data-for="${msg.id}"]`)?.remove();
        
        if (charChanges?.length) { 
            stripped = stripCharChangesBlock(stripped); 
            renderCharProposalCard(charChanges, wrapEl); 
        } else document.querySelector(`.scp-char-proposal-card[data-for="${msg.id}"]`)?.remove();
        
        if (charCreation) { 
            stripped = stripCharCreationBlock(stripped); 
            renderCharCreationCard(charCreation, wrapEl); 
        } else document.querySelector(`.scp-char-creation-card[data-for="${msg.id}"]`)?.remove();

        if (chatChanges?.length) { 
            stripped = stripChatChangesBlock(stripped); 
            renderChatProposalCard(chatChanges, wrapEl); 
        } else document.querySelector(`.scp-chat-proposal-card[data-for="${msg.id}"]`)?.remove();
        
        const displayString = getDisplayContent(stripped, getSettings()).content;

        nc.innerHTML = renderMarkdown(displayString);
        postProcessHTMLBlocks(nc);
        ta.replaceWith(nc);
        row.remove();
        wrapEl.classList.remove('is-editing');
    };

    cancelBtn.addEventListener('click', () => {
        restoreMessageDOM(original);
    });

    if (saveOnlyBtn) {
        saveOnlyBtn.addEventListener('click', () => {
            const rawText = ta.value.trim();
            if (!rawText) return;
            const newText = expandMacros(rawText);
            updateMessage(session, msg.id, newText);
            msg.content = newText;
            if (msg.swipes && msg.swipeIndex !== undefined) {
                msg.swipes[msg.swipeIndex] = { content: newText, reasoning: msg.reasoning || null };
                saveSessionsToMetadata();
            }
            recordStat(STAT.edit);
            restoreMessageDOM(newText);
            _updateMsgTokenCount(wrapEl, newText, true);
        });
    }

    saveBtn.addEventListener('click', async () => {
        const rawText = ta.value.trim();
        if (!rawText) return;
        const newText = expandMacros(rawText);
        updateMessage(session, msg.id, newText);
        msg.content = newText;
        if (msg.swipes && msg.swipeIndex !== undefined) {
            msg.swipes[msg.swipeIndex] = { content: newText, reasoning: msg.reasoning || null };
            saveSessionsToMetadata();
        }
        recordStat(STAT.edit);
        restoreMessageDOM(newText);
        _updateMsgTokenCount(wrapEl, newText, true);
        
        truncateAfter(session, msg.id);
        removeMsgElAfter(msg.id);
        if (msg.role === 'user') await runGenerate(session, newText, false);
    });
}

export async function handleMessageRegen(wrapEl, msg) {
    if (_generating) return;
    const { charId, chatId } = getBindingKey();
    const session = getActiveSession(charId, chatId);
    const idx = session.messages.findIndex(m => m.id === msg.id);
    if (idx === -1) return;

    const isUser = msg.role === 'user';
    
    const actualMsgsAfter = session.messages.slice(idx + 1).filter(m => !m.isLBHistory);
    const msgsAfterCount = actualMsgsAfter.length;

    let needsConfirm = false;
    if (isUser) {
        if (msgsAfterCount > 1 || (msgsAfterCount === 1 && actualMsgsAfter[0].role !== 'assistant')) {
            needsConfirm = true;
        }
    } else {
        if (msgsAfterCount > 0) {
            needsConfirm = true;
        }
    }

    if (needsConfirm) {
        const ok = await showCustomDialog({
            type: 'confirm',
            title: 'Regenerate Message',
            message: 'Regenerating will delete all subsequent messages. Continue?'
        });
        if (!ok) return;
    }

    if (isUser) {
        truncateAfter(session, msg.id);
        removeMsgElAfter(msg.id);
    } else {
        truncateFrom(session, msg.id);
        removeMsgElAndBelow(msg.id);
    }
    
    updateMsgCount(session);
    recordStat(STAT.regen);
    runGenerate(session, null, false);
}

export async function handleDelete(wrapEl, msg) {
    const isUser = msg.role === 'user';
    const confirmed = await showCustomDialog({
        type: 'confirm',
        title: 'Delete Message',
        message: isUser
            ? 'Delete this message and all subsequent messages?'
            : 'Delete this assistant message?',
    });
    if (!confirmed) return;
    const { charId, chatId } = getBindingKey();
    const session = getActiveSession(charId, chatId);
    if (isUser) {
        truncateFrom(session, msg.id);
        removeMsgElAndBelow(msg.id);
    } else {
        deleteMsg(session, msg.id);
        removeMsgEl(msg.id);
    }
    updateMsgCount(session);
    if (!session.messages.length) renderSession(session);
}


let _searchQuery = '';
let _searchMatches = [];
let _searchIdx = -1;
let _searchDebounceId = null;
let _searchOpen = false;
let _searchWholeWord = false;

// ui-window.js's Hotkey section needs to know whether the search bar is
// open (to focus its input on Ctrl+F instead of re-toggling it open).
export function isSearchOpen() { return _searchOpen; }

export function openSearch() {
    _searchOpen = true;
    const bar = document.getElementById('scp-search-bar');
    if (bar) {
        bar.classList.add('scp-search-open');
        requestAnimationFrame(() => {
            const inp = document.getElementById('scp-search-input');
            if (inp) { inp.focus(); inp.select(); }
        });
    }
    document.getElementById('scp-search-btn')?.classList.add('active');
}

export function closeSearch() {
    _searchOpen = false;
    _searchWholeWord = false;
    document.getElementById('scp-search-bar')?.classList.remove('scp-search-open');
    document.getElementById('scp-search-btn')?.classList.remove('active');
    document.getElementById('scp-search-word')?.classList.remove('active');
    clearSearchHighlights();
    _searchMatches = [];
    _searchIdx = -1;
    const inp = document.getElementById('scp-search-input');
    if (inp) inp.value = '';
    _searchQuery = '';
    updateSearchCount();
}

export function clearSearchHighlights() {
    const marks = document.querySelectorAll('#scp-messages mark.scp-search-hl');
    if (!marks.length) return;
    const parents = new Set();
    marks.forEach(m => {
        const p = m.parentNode;
        if (!p) return;
        p.replaceChild(document.createTextNode(m.textContent), m);
        parents.add(p);
    });
    parents.forEach(p => p.normalize());
}

export function updateSearchCount() {
    const el = document.getElementById('scp-search-count');
    if (!el) return;
    el.textContent = (_searchMatches.length && _searchQuery)
        ? `${_searchIdx + 1}/${_searchMatches.length}`
        : '';
}

export function _applyHighlightsInRoot(root) {
    const lq = _searchQuery.toLowerCase();
    let regex = null;
    if (_searchWholeWord) {
        try { regex = new RegExp(`\\b${lq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'); } catch(_) {}
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.closest('.scp-msg-actions,.scp-msg-meta,.scp-msg-avatar,.scp-reasoning-summary,.scp-search-hl'))
                return NodeFilter.FILTER_REJECT;
            if (!p.closest('.scp-msg-body')) return NodeFilter.FILTER_REJECT;
            if (regex) {
                regex.lastIndex = 0;
                const hit = regex.test(node.nodeValue);
                regex.lastIndex = 0;
                return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
            return node.nodeValue.toLowerCase().includes(lq)
                ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    const newMarks = [];
    for (const node of textNodes) {
        const text = node.nodeValue;
        const frag = document.createDocumentFragment();
        let lastIndex = 0;

        if (regex) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(text)) !== null) {
                if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                const mark = document.createElement('mark');
                mark.className = 'scp-search-hl';
                mark.textContent = match[0];
                frag.appendChild(mark);
                newMarks.push(mark);
                lastIndex = match.index + match[0].length;
            }
        } else {
            const lower = text.toLowerCase();
            let idx = lower.indexOf(lq, 0);
            if (idx === -1) continue;
            while (idx !== -1) {
                if (idx > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
                const mark = document.createElement('mark');
                mark.className = 'scp-search-hl';
                mark.textContent = text.slice(idx, idx + _searchQuery.length);
                frag.appendChild(mark);
                newMarks.push(mark);
                lastIndex = idx + _searchQuery.length;
                idx = lower.indexOf(lq, lastIndex);
            }
        }

        if (lastIndex === 0) continue;
        if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        node.parentNode.replaceChild(frag, node);
    }
    return newMarks;
}

export function performSearch() {
    clearSearchHighlights();
    _searchMatches = [];
    _searchIdx = -1;
    const q = _searchQuery.trim();
    if (!q) { updateSearchCount(); return; }
    const container = document.getElementById('scp-messages');
    if (!container) return;
    _searchMatches = _applyHighlightsInRoot(container);
    if (_searchMatches.length) {
        _searchIdx = 0;
        _searchMatches[0].classList.add('scp-search-current');
        _searchMatches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    updateSearchCount();
}

export function navigateSearch(dir) {
    if (!_searchMatches.length) return;
    _searchMatches[_searchIdx]?.classList.remove('scp-search-current');
    _searchIdx = (_searchIdx + dir + _searchMatches.length) % _searchMatches.length;
    const cur = _searchMatches[_searchIdx];
    cur.classList.add('scp-search-current');
    cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateSearchCount();
}

// Moved out of the original "Window Event Listeners" section's
// attachWindowListeners (old index.js 13924-13950-ish) rather than copied
// verbatim: those lines directly reassigned `_searchWholeWord`/
// `_searchQuery`/`_searchDebounceId`, which are private to this module.
// Keeping the reassignment here (and just calling this setup function once
// from index.js's attachWindowListeners) avoids exporting setters for
// state nothing else needs to touch.
export function setupSearchListeners() {
    $('scp-search-btn')?.addEventListener('click', () => { isSearchOpen() ? closeSearch() : openSearch(); });
    $('scp-search-close')?.addEventListener('click', closeSearch);
    $('scp-search-prev')?.addEventListener('click', () => navigateSearch(-1));
    $('scp-search-next')?.addEventListener('click', () => navigateSearch(1));
    $('scp-search-word')?.addEventListener('click', () => {
        _searchWholeWord = !_searchWholeWord;
        $('scp-search-word')?.classList.toggle('active', _searchWholeWord);
        if (_searchQuery.trim()) performSearch();
    });

    const searchInputEl = $('scp-search-input');
    if (searchInputEl) {
        searchInputEl.addEventListener('input', () => {
            _searchQuery = searchInputEl.value;
            clearTimeout(_searchDebounceId);
            _searchDebounceId = setTimeout(performSearch, 220);
        });
        searchInputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1); }
            if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); }
        });
    }
}



let _generating = false;


export async function runGenerate(session, userText, addUserMsg = true, processedAtts = null) {
    if (_generating) return;
    _generating = true;
    const settings = getEffectiveSettings();
    setGeneratingState(true);

    let streamMsgId = null;
    let streamMsgEl = null;
    let streamContentEl = null;
    let streamReasoningBlockEl = null;
    let streamReasoningSummaryEl = null;
    let streamReasoningContentEl = null;
    let cursorEl = null;
    let isStreaming = false;
    let streamAccumText = '';
    let streamAccumReasoning = null;

    const cleanupCursor = () => {
        if (cursorEl && cursorEl.parentNode) cursorEl.remove();
        cursorEl = null;
    };

    const onChunk = (text, reasoning, reasoningMs, reasoningDone) => {
        isStreaming = true;
        streamAccumText = text;
        streamAccumReasoning = reasoning;

        if (!streamMsgId) {
            const placeholder = { id: genId('msg'), role: 'assistant', content: '', reasoning: null, timestamp: Date.now() };
            session.messages.push(placeholder);
            streamMsgId = placeholder.id;

            const c = document.getElementById('scp-messages');
            c?.querySelector('.scp-empty-state')?.remove();
            streamMsgEl = createMsgEl(placeholder, handleCopy, handleEdit, handleDelete, handleMessageRegen);
            c?.appendChild(streamMsgEl);
            updateMsgCount(session);

            const body = streamMsgEl.querySelector('.scp-msg-body');
            streamContentEl = streamMsgEl.querySelector('.scp-msg-content');

            streamReasoningBlockEl = document.createElement('details');
            streamReasoningBlockEl.className = 'scp-reasoning-block';
            streamReasoningBlockEl.style.display = 'none';
            streamReasoningSummaryEl = document.createElement('summary');
            streamReasoningSummaryEl.className = 'scp-reasoning-summary';
            streamReasoningSummaryEl.textContent = 'Thinking…';
            streamReasoningContentEl = document.createElement('div');
            streamReasoningContentEl.className = 'scp-reasoning-content';
            streamReasoningBlockEl.appendChild(streamReasoningSummaryEl);
            streamReasoningBlockEl.appendChild(streamReasoningContentEl);
            if (body) body.insertBefore(streamReasoningBlockEl, streamContentEl);

            cursorEl = document.createElement('span');
            cursorEl.className = 'scp-stream-cursor';

            const bar = document.getElementById('scp-thinking-bar');
            const thinkingText = document.getElementById('scp-thinking-text');
            if (bar) bar.style.display = 'flex';
            if (thinkingText) thinkingText.textContent = 'Streaming…';
        }

        if (reasoning && streamReasoningBlockEl) {
            streamReasoningBlockEl.style.display = '';
            streamReasoningContentEl.innerHTML = renderMarkdown(reasoning);
            const secs = reasoningMs ? (reasoningMs / 1000).toFixed(1) : null;
            streamReasoningSummaryEl.textContent = reasoningDone
                ? `Thought for ${secs}s`
                : secs ? `Thinking for ${secs}s…` : 'Thinking…';
        }

        if (streamContentEl) {
            streamContentEl.innerHTML = renderMarkdown(text);
            if (text) streamContentEl.appendChild(cursorEl);
        }
        smartScrollToBottom();
    };

    try {
        if (addUserMsg && (userText || (processedAtts && processedAtts.length))) {
            const msgObj = addMessage(session, 'user', userText, { 
                attachments: processedAtts || []
            });
            appendMsgEl(msgObj);
            recordStat(STAT.msg);
        }

        const fullMessages = await assembleMessages(session, settings, null);
        const fullPromptText = fullMessages.map(m => m.content).join('\n');
        const tokensIn = await estimateTokens(fullPromptText);

        dbgAdd('GEN_START', {
            src: settings.connectionSource,
            profile: settings.connectionProfileId || null,
            maxTokens: settings.maxTokens,
            streaming: settings.forceStreaming,
            ctxDepth: settings.contextDepth,
            tokensIn
        });

        const result = await callGenerate(session, settings, null, onChunk);

        cleanupCursor();

        if (result === null) {
            if (streamMsgId && isStreaming && streamAccumText) {
                const msg = session.messages.find(m => m.id === streamMsgId);
                if (msg) { msg.content = streamAccumText; msg.reasoning = streamAccumReasoning || null; saveSettings(); }
                if (streamContentEl) { streamContentEl.innerHTML = renderMarkdown(streamAccumText); postProcessHTMLBlocks(streamContentEl); }
                if (streamReasoningBlockEl) streamReasoningBlockEl.style.display = streamAccumReasoning ? '' : 'none';
                if (streamReasoningBlockEl && streamAccumReasoning) {
                    streamReasoningContentEl.innerHTML = renderMarkdown(streamAccumReasoning);
                    streamReasoningSummaryEl.textContent = 'Reasoning';
                }
            } else if (streamMsgId) {
                const idx = session.messages.findIndex(m => m.id === streamMsgId);
                if (idx >= 0 && !session.messages[idx].content) {
                    session.messages.splice(idx, 1);
                    streamMsgEl?.remove();
                    updateMsgCount(session);
                }
            }
            return;
        }

        const { text: rawFullText, reasoning: fullReasoning } = result;
        const fullText = normalizeCharNamesInBlock(rawFullText);

        if (isStreaming && streamMsgId) {
            const msg = session.messages.find(m => m.id === streamMsgId);
            if (msg) { msg.content = fullText; msg.reasoning = fullReasoning || null; }
            saveSettings();

            const lbChanges = parseLBChangesFromText(fullText);
            const charChanges = parseCharChangesFromText(fullText);
            const charCreation = parseCharCreationFromText(fullText);
            const chatChanges = parseChatChangesFromText(fullText);
            const needsStrip = lbChanges?.length || charChanges?.length || charCreation || chatChanges?.length;
            if (needsStrip) {
                let stripped = fullText;
                if (lbChanges?.length) stripped = stripLBChangesBlock(stripped);
                if (charChanges?.length) stripped = stripCharChangesBlock(stripped);
                if (charCreation) stripped = stripCharCreationBlock(stripped);
                if (chatChanges?.length) stripped = stripChatChangesBlock(stripped);
                if (streamContentEl) { streamContentEl.innerHTML = renderMarkdown(stripped); postProcessHTMLBlocks(streamContentEl); }
                if (lbChanges?.length) renderProposalCard(lbChanges, streamMsgEl);
                if (charChanges?.length) renderCharProposalCard(charChanges, streamMsgEl);
                if (charCreation) renderCharCreationCard(charCreation, streamMsgEl);
                if (chatChanges?.length) renderChatProposalCard(chatChanges, streamMsgEl);
            } else {
                if (streamContentEl) { streamContentEl.innerHTML = renderMarkdown(fullText); postProcessHTMLBlocks(streamContentEl); }
            }

            if (fullReasoning && streamReasoningBlockEl) {
                streamReasoningBlockEl.style.display = '';
                streamReasoningContentEl.innerHTML = renderMarkdown(fullReasoning);
                streamReasoningSummaryEl.textContent = 'Reasoning';
            } else if (!fullReasoning && streamReasoningBlockEl) {
                streamReasoningBlockEl.style.display = 'none';
            }

            if (msg) {
                msg.swipes = [{ content: fullText, reasoning: fullReasoning || null }];
                msg.swipeIndex = 0;
                saveSessionsToMetadata();
            }
            _updateMsgTokenCount(streamMsgEl, fullText);
        } else {
            const newMsg = addMessage(session, 'assistant', fullText, { reasoning: fullReasoning || null });
            newMsg.swipes = [{ content: fullText, reasoning: fullReasoning || null }];
            newMsg.swipeIndex = 0;
            saveSessionsToMetadata();
            appendMsgEl(newMsg);
        }

        _refreshSwipeBars(session);

        if (tokensIn > 0) recordStat(STAT.tokIn, tokensIn);
        const tokensOut = await estimateTokens(fullText);
        if (tokensOut > 0) recordStat(STAT.tokOut, tokensOut);

        _playCompletionSound();
        dbgAdd('GEN_DONE', { chars: fullText?.length || 0, hasReasoning: !!fullReasoning, tokensOut });

    } catch (err) {
        cleanupCursor();
        if (getAbortController()?.signal?.aborted || err?.message === 'userStopped') {
            _generating = false;
            setGeneratingState(false);
            return;
        }
        
        const inputEl = document.getElementById('scp-input');
        if (inputEl && inputEl.value.trim() === '' && userText) {
            inputEl.value = userText;
            autoResize(inputEl);
        }

        dbgAdd('GEN_ERROR', { msg: err?.message || String(err), stack: err?.stack });
        console.error(`[${EXT_DISPLAY}] Generation failed:`, err);
        
        showGenerationError(err);
    } finally {
        _generating = false;
        setGeneratingState(false);
    }
}


export function _joinContinuation(existing, continuation) {
    if (!continuation) return existing;
    const trimmed = existing.trimEnd();
    // If existing ends with punctuation/word char, add a space before continuation
    const needsSpace = /[\w.,!?;:'")\]}>]$/.test(trimmed);
    return trimmed + (needsSpace ? ' ' : '') + continuation;
}

export async function runContinue(session, targetMsgId) {
    if (_generating) return;
    const targetMsg = session.messages.find(m => m.id === targetMsgId);
    if (!targetMsg || targetMsg.role !== 'assistant') return;

    _generating = true;
    const settings = getEffectiveSettings();
    setGeneratingState(true);

    const CONTINUE_PROMPT = 'Continue your response exactly from where you left off. Do not repeat any previously written text.';

    let streamContentEl = null;
    let cursorEl = null;
    let isStreaming = false;
    let streamAccumContinuation = '';
    const originalContent = targetMsg.content;

    const targetEl = document.querySelector(`.scp-msg[data-id="${targetMsgId}"]`);
    if (targetEl) streamContentEl = targetEl.querySelector('.scp-msg-content');

    const cleanupCursor = () => {
        if (cursorEl && cursorEl.parentNode) cursorEl.remove();
        cursorEl = null;
    };

    const onChunk = (text) => {
        isStreaming = true;
        streamAccumContinuation = text;
        if (!cursorEl) {
            cursorEl = document.createElement('span');
            cursorEl.className = 'scp-stream-cursor';
            const bar = document.getElementById('scp-thinking-bar');
            const thinkingText = document.getElementById('scp-thinking-text');
            if (bar) bar.style.display = 'flex';
            if (thinkingText) thinkingText.textContent = 'Streaming…';
        }
        const combined = _joinContinuation(originalContent, text);
        const { content: disp } = getDisplayContent(combined, settings);
        if (streamContentEl) {
            streamContentEl.innerHTML = renderMarkdown(disp);
            streamContentEl.appendChild(cursorEl);
        }
        smartScrollToBottom();
    };

    const _applyFinalContinuation = (fullCombined) => {
        const lbChanges = parseLBChangesFromText(fullCombined);
        const charChanges = parseCharChangesFromText(fullCombined);
        const charCreation = parseCharCreationFromText(fullCombined);
        const chatChanges = parseChatChangesFromText(fullCombined);
        const needsStrip = lbChanges?.length || charChanges?.length || charCreation || chatChanges?.length;

        if (needsStrip) {
            let stripped = fullCombined;
            if (lbChanges?.length) stripped = stripLBChangesBlock(stripped);
            if (charChanges?.length) stripped = stripCharChangesBlock(stripped);
            if (charCreation) stripped = stripCharCreationBlock(stripped);
            if (chatChanges?.length) stripped = stripChatChangesBlock(stripped);
            const { content: disp } = getDisplayContent(stripped, settings);
            if (streamContentEl) { streamContentEl.innerHTML = renderMarkdown(disp); postProcessHTMLBlocks(streamContentEl); }
            const msgEl = document.querySelector(`.scp-msg[data-id="${targetMsgId}"]`);
            if (msgEl) {
                if (lbChanges?.length) renderProposalCard(lbChanges, msgEl);
                if (charChanges?.length) renderCharProposalCard(charChanges, msgEl);
                if (charCreation) renderCharCreationCard(charCreation, msgEl);
                if (chatChanges?.length) renderChatProposalCard(chatChanges, msgEl);
            }
        } else {
            const { content: disp } = getDisplayContent(fullCombined, settings);
            if (streamContentEl) { streamContentEl.innerHTML = renderMarkdown(disp); postProcessHTMLBlocks(streamContentEl); }
        }
    };

    try {
        const fullMessages = await assembleMessages(session, settings, CONTINUE_PROMPT);
        const fullPromptText = fullMessages.map(m => m.content).join('\n');
        
        const tokensIn = await estimateTokens(fullPromptText);

        dbgAdd('CONTINUE_START', {
            src: settings.connectionSource,
            profile: settings.connectionProfileId || null,
            maxTokens: settings.maxTokens,
            streaming: settings.forceStreaming,
            ctxDepth: settings.contextDepth,
            tokensIn
        });

        const result = await callGenerate(session, settings, CONTINUE_PROMPT, onChunk);
        cleanupCursor();

        if (result === null) {
            if (isStreaming && streamAccumContinuation) {
                const combined = _joinContinuation(originalContent, streamAccumContinuation);
                targetMsg.content = combined;
                if (targetMsg.swipes && targetMsg.swipeIndex !== undefined) {
                    targetMsg.swipes[targetMsg.swipeIndex] = { content: combined, reasoning: targetMsg.reasoning || null };
                }
                saveSessionsToMetadata();
                _applyFinalContinuation(combined);
                const targetMsgEl2 = document.querySelector(`.scp-msg[data-id="${targetMsgId}"]`);
                if (targetMsgEl2) _updateMsgTokenCount(targetMsgEl2, combined);
            }
            return;
        }

        const { text: continuation, isMaxTokens } = result;
        const combined = _joinContinuation(originalContent, continuation);
        
        if (isMaxTokens) {
            toastr.warning('Generation stopped: reached Max Response Tokens limit.', EXT_DISPLAY, { timeOut: 10000 });
        }

        targetMsg.content = combined;

        // Update swipe data
        if (targetMsg.swipes && targetMsg.swipeIndex !== undefined) {
            targetMsg.swipes[targetMsg.swipeIndex] = { content: combined, reasoning: targetMsg.reasoning || null };
        }
        saveSessionsToMetadata();
        _applyFinalContinuation(combined);

        const targetMsgEl = document.querySelector(`.scp-msg[data-id="${targetMsgId}"]`);
        if (targetMsgEl) _updateMsgTokenCount(targetMsgEl, combined);

        if (tokensIn > 0) recordStat(STAT.tokIn, tokensIn);
        
        const tokensOut = await estimateTokens(continuation);
        if (tokensOut > 0) recordStat(STAT.tokOut, tokensOut);

        updateMsgCount(session);
        _playCompletionSound();
        dbgAdd('CONTINUE_DONE', { chars: continuation?.length || 0, tokensOut });

    } catch (err) {
        cleanupCursor();
        if (getAbortController()?.signal?.aborted || err?.message === 'userStopped') {
            _generating = false;
            setGeneratingState(false);
            return;
        }
        dbgAdd('GEN_ERROR', { msg: err?.message || String(err), stack: err?.stack });
        console.error(`[${EXT_DISPLAY}] Continuation failed:`, err);

        showGenerationError(err);
    } finally {
        _generating = false;
        setGeneratingState(false);
    }
}


export function setGeneratingState(on) {
    const bar = $('scp-thinking-bar'), sendBtn = $('scp-send-btn'),
        input = $('scp-input');
    if (bar) bar.style.display = on ? 'flex' : 'none';
    if (sendBtn) sendBtn.disabled = on;
    if (input) input.disabled = on;
    if (!on) {
        _refreshContinueBtns();
        _refreshSwipeBars(getCurrentSession());
    }
}

export function showGenerationError(err) {
    let errorSummary = err?.message || String(err);
    let fullError = '';

    if (err instanceof Error) {
        fullError = err.stack || err.message;
        if (err.cause) {
            fullError += '\n\n--- CAUSE ---\n' + (err.cause.stack || err.cause.message || JSON.stringify(err.cause, null, 2));
        }
    } else if (typeof err === 'object') {
        try {
            errorSummary = "API or Network Error";
            fullError = JSON.stringify(err, null, 2);
        } catch(e) {
            fullError = String(err);
        }
    } else {
        fullError = String(err);
    }

    if (window.last_api_error && errorSummary.includes('userStopped') === false) {
        fullError += '\n\n--- ST LAST API ERROR ---\n' + (typeof window.last_api_error === 'object' ? JSON.stringify(window.last_api_error, null, 2) : String(window.last_api_error));
    }

    showCustomDialog({
        type: 'alert',
        title: 'Generation Error',
        htmlMessage: `
            <div style="color:var(--scp-danger); margin-bottom: 10px; font-weight: 600; font-size: 14px; word-break: break-word; line-height: 1.4;">
                ${escHtml(errorSummary)}
            </div>
            <div style="font-size: 12px; margin-bottom: 8px; color: var(--scp-text-muted);">
                Please copy the technical details below to report the issue:
            </div>
            <textarea style="width:100%; height:160px; background:rgba(0,0,0,0.4); color:var(--scp-text-muted); border:1px solid rgba(255,255,255,0.15); padding:8px; border-radius:6px; font-family:var(--scp-font-mono, monospace); resize:vertical; font-size:11px; white-space:pre; word-wrap:normal; overflow-x:auto;" readonly onclick="this.select()">${escHtml(fullError)}</textarea>
        `
    });
}

export async function handleSend() {
    const input = $('scp-input'); if (!input) return;
    const rawText = input.value.trim();
    if (!rawText && !getPendingAttachments().length || _generating) return;
    const text = expandMacros(rawText || '');
    input.value = ''; autoResize(input);
    
    const processedAtts = await processAttachmentsBeforeSend(getPendingAttachments(), false);
    clearPendingAttachments();
    renderAttachmentPreviews();
    updateMsgCount(getCurrentSession()); 
    
    runGenerate(getCurrentSession(), text, true, processedAtts).catch(err => {
        console.error(err);
    });
}

export function handleRegen() {
    if (_generating) return;
    const sess = getCurrentSession(); if (!sess.messages.length) return;
    let lastUserIdx = -1;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
        if (sess.messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const userMsg = sess.messages[lastUserIdx];
    truncateAfter(sess, userMsg.id); removeMsgElAfter(userMsg.id);
    recordStat(STAT.regen);
    runGenerate(sess, userMsg.content, false);
}
