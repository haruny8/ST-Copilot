import { EXT_DISPLAY, ICONS, THEME_PRESETS } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { applyCustomTheme } from '../ui/ui-window.js';
import { estimateTokens } from '../ui/ui-chat.js';
import { getUserPersona } from '../utils/util-st.js';
import {
    getActiveCharacterEntities, getCharFieldValue, saveCharacterField,
    getEffectiveCharField, getCharFieldOverride, setCharFieldOverride,
    isCharacterExcluded, setCharacterExcluded,
} from './feature-character-engine.js';

const I = ICONS;

const FIELD_GROUPS = [
    { title: 'Identity', fields: [
        { key: 'name', label: 'Name' },
        { key: 'tags', label: 'Tags' },
        { key: 'description', label: 'Description', multiline: true },
        { key: 'personality', label: 'Personality', multiline: true },
    ]},
    { title: 'Scene', fields: [
        { key: 'scenario', label: 'Scenario', multiline: true },
        { key: 'first_mes', label: 'First Message', multiline: true },
        { key: 'mes_example', label: 'Example Dialogue', multiline: true },
    ]},
];

const OV_FIELDS = [
    { key: 'tags', label: 'Tags' },
    { key: 'description', label: 'Description' },
    { key: 'personality', label: 'Personality' },
    { key: 'scenario', label: 'Scenario' },
    { key: 'first_mes', label: 'First Message' },
    { key: 'mes_example', label: 'Example Dialogue' },
    { key: 'authors_note', label: "Author's Note" },
    { key: 'alternate_greetings', label: 'Alternate Greetings' },
];

const PRIVATE_NOTE_FIELDS = [
    { key: 'profile', label: 'Character Profile', multiline: true, showTokens: false },
    { key: 'relationships', label: 'Relationships', multiline: true, showTokens: false },
    { key: 'lorebook', label: 'Lorebook', multiline: true, showTokens: false },
    { key: 'importantDetails', label: 'Important Details', multiline: true, showTokens: false },
    { key: 'notes', label: 'Freeform Notes', multiline: true, showTokens: false },
];

let _selectedEntityId = null;
let _lastActiveTab = 'info';
let _lastScrollTop = 0;
let _currentIsDirty = false;
let _currentSaveFn = null;
let _currentUpdateButtons = null;
let _currentExternalChange = false;
let _currentSaveInProgress = false;

function _showUnsavedDialog(onSave, onDiscard) {
    const overlay = document.createElement('div');
    overlay.className = 'scp-dialog-overlay';
    overlay.style.zIndex = '2147483055';
    overlay.innerHTML = `
        <div class="scp-dialog-box">
            <div class="scp-dialog-title">Unsaved Changes</div>
            <div class="scp-dialog-msg">You have unsaved changes. What would you like to do?</div>
            <div class="scp-dialog-btns">
                <button class="scp-dialog-btn scp-dialog-cancel" data-action="cancel">Cancel</button>
                <button class="scp-dialog-btn scp-dialog-cancel" data-action="discard" style="color:var(--scp-danger,#ff5c5c)">Discard</button>
                <button class="scp-dialog-btn scp-dialog-ok" data-action="save">Save &amp; Exit</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
    const close = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 150); };
    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        if (action === 'cancel') close();
        if (action === 'discard') { close(); onDiscard(); }
        if (action === 'save') { close(); onSave(); }
    });
}

function _getPersonaEntity() {
    const ctx = SillyTavern.getContext();
    let avatar = window.user_avatar || ctx.user_avatar || ctx.userAvatar || ctx.personaId || ctx.activePersonaId || ctx.active_persona_id;
    const selected = document.querySelector('#user_avatar_block .avatar-container.selected, #persona_container .avatar-container.selected, .persona_selected');
    if (!avatar && selected) avatar = selected.getAttribute('data-avatar-id') || selected.dataset?.avatarId;
    if (typeof avatar === 'object' && avatar !== null) {
        avatar = avatar.avatarId || avatar.avatar_id || avatar.user_avatar || avatar.userAvatar || avatar.id;
    }
    const personaKey = String(avatar || ctx.name1 || 'default');
    return { id: `persona:${personaKey}`, name: ctx.name1 || 'User', avatar: avatar || '', isPersona: true };
}

function _getPrivateNotesKey(entity) {
    const prefix = entity.isPersona ? 'persona' : 'character';
    return `${prefix}:${String(entity.avatar || entity.id || 'default')}`;
}

function _getPrivateNotes(entity) {
    const notes = getSettings().charMgrPrivateNotes?.[_getPrivateNotesKey(entity)];
    return notes && typeof notes === 'object' ? notes : {};
}

function _isManagerVisible() {
    return document.getElementById('scp-char-overlay')?.style.display === 'flex';
}

function _handleExternalDataChange(kind, payload) {
    if (!_isManagerVisible() || _currentSaveInProgress) return;

    const ctx = SillyTavern.getContext();
    if (kind === 'character') {
        const current = ctx.characters?.[ctx.characterId];
        const changed = payload?.detail?.character || payload?.character;
        if (changed?.avatar && current?.avatar && changed.avatar !== current.avatar) return;
    } else {
        const changedAvatar = typeof payload === 'string'
            ? payload
            : payload?.avatarId || payload?.avatar_id || payload?.detail?.avatarId;
        const activeAvatar = _getPersonaEntity().avatar;
        if (changedAvatar && activeAvatar && changedAvatar !== activeAvatar) return;
    }

    if (_currentIsDirty) {
        if (_lastActiveTab === 'info') {
            _currentExternalChange = true;
            _currentUpdateButtons?.();
            toastr.warning('Native SillyTavern fields changed. Revert this panel before saving to reload the latest values.', EXT_DISPLAY);
        }
        return;
    }

    _renderCharList();
}

function _avatarUrl(entity) {
    const ctx = SillyTavern.getContext();
    try {
        if (typeof ctx.getThumbnailUrl === 'function') {
            return ctx.getThumbnailUrl(entity.isPersona ? 'persona' : 'avatar', entity.avatar);
        }
        return entity.isPersona ? `/User Avatars/${entity.avatar}` : `/characters/${entity.avatar}`;
    } catch (_) {
        return '';
    }
}

async function _calcTotalTokens(entity) {
    const text = entity.isPersona
        ? getUserPersona()
        : ['description', 'personality', 'scenario', 'first_mes', 'mes_example']
            .map(field => String(getCharFieldValue(entity.char, field) || '')).join('\n');
    return estimateTokens(text);
}

function _buildCharListRow(entity, settings) {
    const row = document.createElement('div');
    row.className = 'scp-char-row';
    row.dataset.id = entity.id;

    const avatar = document.createElement('img');
    avatar.className = 'scp-char-row-avatar';
    avatar.src = _avatarUrl(entity);
    avatar.alt = '';
    avatar.onerror = () => { avatar.style.visibility = 'hidden'; };

    const name = document.createElement('span');
    name.className = 'scp-char-row-name';
    name.textContent = entity.name || 'Unnamed character';
    row.append(avatar, name);

    if (entity.isPersona) {
        const lock = document.createElement('span');
        lock.className = 'scp-char-row-lock';
        lock.innerHTML = I.lock;
        lock.title = 'Persona inclusion is controlled by the global settings.';
        row.appendChild(lock);
    } else {
        const checkbox = document.createElement('div');
        checkbox.className = `scp-char-row-cb${isCharacterExcluded(settings, entity.id) ? '' : ' checked'}`;
        checkbox.title = 'Include this character in AI context';
        checkbox.addEventListener('click', event => {
            event.stopPropagation();
            const wasIncluded = checkbox.classList.contains('checked');
            setCharacterExcluded(getSettings(), entity.id, wasIncluded);
            saveSettings();
            checkbox.classList.toggle('checked', !wasIncluded);
        });
        row.appendChild(checkbox);
    }

    row.addEventListener('click', () => _selectEntity(entity));
    return row;
}

function _selectEntity(entity) {
    if (!entity || _selectedEntityId === entity.id) return;
    const select = () => {
        _lastScrollTop = 0;
        _selectedEntityId = entity.id;
        document.querySelectorAll('#scp-char-list .scp-char-row').forEach(row => {
            row.classList.toggle('selected', row.dataset.id === entity.id);
        });
        _renderCharDetail(entity);
    };

    if (_currentIsDirty && _currentSaveFn) {
        _showUnsavedDialog(async () => {
            const saved = await _currentSaveFn();
            if (saved !== false) select();
        }, select);
    } else {
        select();
    }
}

function _renderCharList() {
    const list = document.getElementById('scp-char-list');
    if (!list) return;
    list.innerHTML = '';

    const settings = getSettings();
    const persona = _getPersonaEntity();
    const characters = getActiveCharacterEntities();
    const entities = [persona, ...characters];
    const fragment = document.createDocumentFragment();
    entities.forEach(entity => fragment.appendChild(_buildCharListRow(entity, settings)));

    if (!characters.length) {
        const empty = document.createElement('div');
        empty.className = 'scp-char-list-empty';
        empty.textContent = 'No active character found.';
        fragment.appendChild(empty);
    }
    list.appendChild(fragment);

    const selected = entities.find(entity => entity.id === _selectedEntityId) || persona;
    _selectedEntityId = null;
    _selectEntity(selected);
}

function _buildBanner(entity) {
    const banner = document.createElement('div');
    banner.className = 'scp-char-banner';
    banner.style.setProperty('--scp-char-banner-img', `url("${_avatarUrl(entity)}")`);

    const avatar = document.createElement('img');
    avatar.className = 'scp-char-banner-avatar';
    avatar.src = _avatarUrl(entity);
    avatar.alt = '';
    avatar.onerror = () => { avatar.style.visibility = 'hidden'; };

    const info = document.createElement('div');
    info.className = 'scp-char-banner-info';
    const name = document.createElement('div');
    name.className = 'scp-char-banner-name';
    name.textContent = entity.name || 'Unnamed character';
    const tokens = document.createElement('div');
    tokens.className = 'scp-char-banner-tokens';
    tokens.textContent = '~... tokens total';
    info.append(name, tokens);
    banner.append(avatar, info);

    _calcTotalTokens(entity).then(count => {
        if (tokens.isConnected) tokens.textContent = `~${count} tokens total`;
    });
    return banner;
}

function _openExpandedFieldEditor(field, input) {
    const host = document.body;
    document.querySelectorAll('.scp-char-field-editor-overlay').forEach(editor => editor.remove());
    const overlay = document.createElement('div');
    overlay.className = 'scp-char-field-editor-overlay';
    overlay.id = 'scp-char-field-editor-overlay';
    overlay.innerHTML = `
        <div class="scp-char-field-editor" role="dialog" aria-modal="true" aria-label="Edit ${field.label}">
            <div class="scp-char-field-editor-header">
                <div class="scp-char-field-editor-title">${field.label}</div>
                <div class="scp-char-field-editor-header-actions">
                    <button class="scp-hbtn scp-char-field-editor-search-toggle" type="button" title="Search in text (Ctrl+F)" aria-label="Search in text">${I.search}</button>
                    <button class="scp-hbtn scp-hbtn-close scp-char-field-editor-close" type="button" title="Close" aria-label="Close">${I.x}</button>
                </div>
            </div>
            <div class="scp-char-field-editor-search" aria-label="Search in text">
                <input class="scp-char-field-editor-search-input" type="search" placeholder="Search in text" aria-label="Search in text" autocomplete="off" spellcheck="false">
                <span class="scp-char-field-editor-search-count" aria-live="polite"></span>
                <button class="scp-hbtn scp-char-field-editor-search-nav" type="button" data-direction="previous" title="Previous match (Shift+Enter)" aria-label="Previous match">${I.chevronLeft}</button>
                <button class="scp-hbtn scp-char-field-editor-search-nav" type="button" data-direction="next" title="Next match (Enter)" aria-label="Next match">${I.chevronRight}</button>
            </div>
            <div class="scp-char-field-editor-canvas">
                <div class="scp-char-field-editor-input" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true"></div>
            </div>
            <div class="scp-char-field-editor-footer">
                <span class="scp-char-field-editor-hint">Changes apply when you click Apply.</span>
                <div class="scp-char-field-editor-actions">
                    <button class="scp-action-btn scp-char-field-editor-cancel" type="button">Cancel</button>
                    <button class="scp-action-btn scp-char-field-editor-apply" type="button">${I.check}<span>Apply</span></button>
                </div>
            </div>
        </div>`;
    host.appendChild(overlay);
    applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    const descriptionColors = getSettings().charMgrDescriptionColors || {};
    overlay.style.setProperty('--scp-char-description-bold', descriptionColors.bold || '#f2bd72');
    overlay.style.setProperty('--scp-char-description-italic', descriptionColors.italic || '#78c9ba');
    overlay.style.setProperty('--scp-char-description-bullet', descriptionColors.bullet || '#91b8f2');
    overlay.style.setProperty('--scp-char-description-xml', descriptionColors.xml || '#c7a6f7');

    const editor = overlay.querySelector('.scp-char-field-editor-input');
    const closeButton = overlay.querySelector('.scp-char-field-editor-close');
    const searchToggle = overlay.querySelector('.scp-char-field-editor-search-toggle');
    const searchBar = overlay.querySelector('.scp-char-field-editor-search');
    const searchInput = overlay.querySelector('.scp-char-field-editor-search-input');
    const searchCount = overlay.querySelector('.scp-char-field-editor-search-count');
    const searchNavButtons = overlay.querySelectorAll('.scp-char-field-editor-search-nav');
    const formattedDescription = field.key === 'description' || field.key === 'user_persona';
    let searchMatches = [];
    let activeMatch = -1;
    let viewportRaf = 0;
    let searchOpen = false;
    let editorValue = '';
    let composing = false;
    let pendingEditorState = null;
    let compositionEditorState = null;
    const undoHistory = [];
    const redoHistory = [];

    const syncMobileViewport = () => {
        if (viewportRaf) return;
        viewportRaf = requestAnimationFrame(() => {
            viewportRaf = 0;
            if (!window.visualViewport || !window.matchMedia('(max-width: 900px)').matches) return;
            const viewport = window.visualViewport;
            overlay.style.position = 'fixed';
            overlay.style.inset = 'auto';
            overlay.style.left = `${viewport.offsetLeft}px`;
            overlay.style.top = `${viewport.offsetTop}px`;
            overlay.style.width = `${viewport.width}px`;
            overlay.style.height = `${viewport.height}px`;
        });
    };
    const viewport = window.visualViewport;
    if (viewport) {
        viewport.addEventListener('resize', syncMobileViewport);
        viewport.addEventListener('scroll', syncMobileViewport);
    }
    syncMobileViewport();

    const close = () => {
        if (viewport) {
            viewport.removeEventListener('resize', syncMobileViewport);
            viewport.removeEventListener('scroll', syncMobileViewport);
        }
        if (viewportRaf) cancelAnimationFrame(viewportRaf);
        overlay.remove();
    };
    const applyButton = overlay.querySelector('.scp-char-field-editor-apply');
    const hint = overlay.querySelector('.scp-char-field-editor-hint');
    const updateSearchCount = () => {
        const hasMatches = searchMatches.length > 0;
        searchNavButtons.forEach(button => { button.disabled = !hasMatches; });
        if (!searchMatches.length) {
            searchCount.textContent = searchInput.value ? 'No matches' : '';
            return;
        }
        searchCount.textContent = `${activeMatch + 1} of ${searchMatches.length}`;
    };
    const readEditorText = () => {
        let text = '';
        const visit = node => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.nodeValue;
                return;
            }
            if (node.nodeName === 'BR' && !(editor.childNodes.length === 1 && node.parentNode === editor)) {
                text += '\n';
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE && node !== editor) return;
            if (node.nodeName === 'BR') return;
            Array.from(node.childNodes).forEach(child => {
                const isBlock = child.nodeType === Node.ELEMENT_NODE && /^(DIV|P)$/.test(child.nodeName);
                if (isBlock && text && !text.endsWith('\n')) text += '\n';
                visit(child);
            });
        };
        Array.from(editor.childNodes).forEach(visit);
        return text;
    };
    const getSelectionOffsets = () => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
            return { start: editorValue.length, end: editorValue.length };
        }
        const getOffset = (node, offset) => {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.setEnd(node, offset);
            return range.toString().length;
        };
        return {
            start: getOffset(selection.anchorNode, selection.anchorOffset),
            end: getOffset(selection.focusNode, selection.focusOffset),
        };
    };
    const captureEditorState = () => ({ value: editorValue, selection: getSelectionOffsets() });
    const setSelectionOffsets = (start, end = start) => {
        const textNodes = [];
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        const findPosition = target => {
            let remaining = target;
            for (const node of textNodes) {
                if (remaining <= node.nodeValue.length) return [node, remaining];
                remaining -= node.nodeValue.length;
            }
            const last = textNodes[textNodes.length - 1];
            return last ? [last, last.nodeValue.length] : [editor, 0];
        };
        const selection = window.getSelection();
        const [startNode, startOffset] = findPosition(start);
        const [endNode, endOffset] = findPosition(end);
        if (selection.setBaseAndExtent) {
            selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
        } else {
            const range = document.createRange();
            selection.removeAllRanges();
            if (start <= end) {
                range.setStart(startNode, startOffset);
                range.setEnd(endNode, endOffset);
                selection.addRange(range);
            } else {
                range.setStart(endNode, endOffset);
                range.collapse(true);
                selection.addRange(range);
                selection.extend(startNode, startOffset);
            }
        }
    };
    const findMatches = query => {
        searchMatches = [];
        if (!query) return;
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(escapedQuery, 'giu');
        let match;
        while ((match = pattern.exec(editorValue))) {
            searchMatches.push({ start: match.index, end: match.index + match[0].length });
        }
    };
    const renderEditor = (selectionOffsets = null) => {
        const styleRanges = [];
        const addRange = (start, end, className) => {
            if (end > start) styleRanges.push({ start, end, className });
        };
        if (formattedDescription) {
            const xmlTagPattern = /<\/?[^\s<>/]+(?:[ \t]+[^\s<>]+)*>/g;
            let xmlTag;
            while ((xmlTag = xmlTagPattern.exec(editorValue))) {
                addRange(xmlTag.index, xmlTag.index + xmlTag[0].length, 'scp-char-format-xml');
            }
            const lines = editorValue.split(/(?<=\n)/);
            let lineOffset = 0;
            lines.forEach(lineWithBreak => {
                const line = lineWithBreak.endsWith('\n') ? lineWithBreak.slice(0, -1) : lineWithBreak;
                const emphasisPattern = /(\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g;
                let emphasis;
                while ((emphasis = emphasisPattern.exec(line))) {
                    const className = emphasis[0].startsWith('**') ? 'scp-char-format-bold' : 'scp-char-format-italic';
                    addRange(lineOffset + emphasis.index, lineOffset + emphasis.index + emphasis[0].length, className);
                }
                const bullet = /^(\s*)(-)([ \t]+)([^:\r\n]+)(:)/.exec(line);
                if (bullet) {
                    addRange(lineOffset + bullet[1].length, lineOffset + bullet[1].length + 1, 'scp-char-format-bullet');
                    const labelStart = lineOffset + bullet[1].length + bullet[2].length + bullet[3].length;
                    addRange(labelStart, labelStart + bullet[4].length, 'scp-char-format-label');
                }
                lineOffset += lineWithBreak.length;
            });
        }
        const query = searchOpen ? searchInput.value.trim() : '';
        findMatches(query);
        searchMatches.forEach((match, index) => addRange(
            match.start,
            match.end,
            index === activeMatch ? 'scp-char-editor-match-active' : 'scp-char-editor-match',
        ));

        const boundaries = new Set([0, editorValue.length]);
        styleRanges.forEach(range => { boundaries.add(range.start); boundaries.add(range.end); });
        const ordered = [...boundaries].sort((a, b) => a - b);
        const nodes = [];
        for (let index = 0; index < ordered.length - 1; index++) {
            const start = ordered[index];
            const end = ordered[index + 1];
            if (end <= start) continue;
            const classes = styleRanges.filter(range => range.start <= start && range.end >= end).map(range => range.className);
            const span = document.createElement('span');
            span.className = [...new Set(classes)].join(' ');
            span.textContent = editorValue.slice(start, end);
            nodes.push(span);
        }
        editor.replaceChildren(...nodes);
        if (selectionOffsets) setSelectionOffsets(selectionOffsets.start, selectionOffsets.end);
    };
    const restoreEditorHistory = undo => {
        const source = undo ? undoHistory : redoHistory;
        const destination = undo ? redoHistory : undoHistory;
        if (!source.length) return;
        destination.push({ value: readEditorText(), selection: getSelectionOffsets() });
        const state = source.pop();
        editorValue = state.value;
        findMatches(searchOpen ? searchInput.value.trim() : '');
        activeMatch = searchMatches.length ? Math.min(Math.max(activeMatch, 0), searchMatches.length - 1) : -1;
        renderEditor(state.selection);
        updateSearchCount();
        editor.focus({ preventScroll: true });
    };
    const selectMatch = (matchIndex, keepSearchFocus = false, selectEditorMatch = true) => {
        if (!searchMatches.length) {
            activeMatch = -1;
            updateSearchCount();
            return;
        }
        activeMatch = (matchIndex + searchMatches.length) % searchMatches.length;
        const match = searchMatches[activeMatch];
        const restoreSearchFocus = keepSearchFocus;
        if (selectEditorMatch) {
            renderEditor({ start: match.start, end: match.end });
            if (!restoreSearchFocus) editor.focus({ preventScroll: true });
            setSelectionOffsets(match.start, match.end);
            if (restoreSearchFocus) searchInput.focus({ preventScroll: true });
        } else {
            renderEditor();
        }
        editor.querySelector('.scp-char-editor-match-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        updateSearchCount();
    };
    const refreshSearch = (selectFirst = true, keepSearchFocus = false, selectEditorMatch = true) => {
        const query = searchInput.value.trim();
        const selectionOffsets = getSelectionOffsets();
        findMatches(query);
        activeMatch = searchMatches.length && selectFirst ? 0 : -1;
        renderEditor(selectionOffsets);
        updateSearchCount();
        if (activeMatch !== -1) selectMatch(activeMatch, keepSearchFocus, selectEditorMatch);
        else if (keepSearchFocus) searchInput.focus({ preventScroll: true });
    };
    const insertTextAtSelection = text => {
        const selection = window.getSelection();
        const range = selection?.rangeCount && editor.contains(selection.anchorNode)
            ? selection.getRangeAt(0)
            : document.createRange();
        if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
            range.selectNodeContents(editor);
            range.collapse(false);
        }
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    };
    const handleEditorInput = previousState => {
        previousState ||= pendingEditorState || captureEditorState();
        pendingEditorState = null;
        const selectionOffsets = getSelectionOffsets();
        const nextValue = readEditorText();
        if (composing) {
            editorValue = nextValue;
            return;
        }
        if (previousState.value !== nextValue) {
            undoHistory.push(previousState);
            redoHistory.length = 0;
        }
        editorValue = nextValue;
        if (searchOpen) {
            findMatches(searchInput.value.trim());
            activeMatch = searchMatches.length ? 0 : -1;
            updateSearchCount();
        }
        renderEditor(selectionOffsets);
    };
    const setSearchOpen = open => {
        searchOpen = open;
        searchBar.classList.toggle('open', open);
        searchToggle.classList.toggle('active', open);
        searchToggle.setAttribute('aria-expanded', String(open));
        if (open) {
            searchInput.focus();
            searchInput.select();
            syncMobileViewport();
        } else {
            activeMatch = -1;
            searchMatches = [];
            updateSearchCount();
            renderEditor(getSelectionOffsets());
            editor.focus();
        }
    };
    const apply = () => {
        editorValue = readEditorText();
        input.value = editorValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        applyButton.classList.add('active');
        applyButton.querySelector('span').textContent = 'Applied';
        hint.textContent = 'Changes applied to the field.';
    };
    editor.setAttribute('aria-label', `Edit ${field.label}`);
    editorValue = String(input.value || '');
    renderEditor({ start: 0, end: 0 });
    searchToggle.setAttribute('aria-expanded', 'false');
    searchToggle.addEventListener('click', () => setSearchOpen(!searchOpen));
    searchInput.addEventListener('input', () => refreshSearch(true, true));
    searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            selectMatch(activeMatch + (event.shiftKey ? -1 : 1), true);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setSearchOpen(false);
        }
    });
    searchNavButtons.forEach(button => button.addEventListener('click', () => {
        const direction = button.dataset.direction === 'previous' ? -1 : 1;
        selectMatch(activeMatch + direction, true);
    }));
    editor.addEventListener('beforeinput', event => {
        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
            event.preventDefault();
            restoreEditorHistory(event.inputType === 'historyUndo');
            return;
        }
        pendingEditorState = captureEditorState();
        if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
            event.preventDefault();
            const previousState = pendingEditorState;
            pendingEditorState = null;
            insertTextAtSelection('\n');
            handleEditorInput(previousState);
        }
    });
    editor.addEventListener('paste', event => {
        event.preventDefault();
        const previousState = captureEditorState();
        pendingEditorState = null;
        insertTextAtSelection((event.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n'));
        handleEditorInput(previousState);
    });
    editor.addEventListener('compositionstart', () => {
        compositionEditorState = captureEditorState();
        pendingEditorState = null;
        composing = true;
    });
    editor.addEventListener('compositionend', () => {
        composing = false;
        const previousState = compositionEditorState || captureEditorState();
        compositionEditorState = null;
        pendingEditorState = null;
        handleEditorInput(previousState);
    });
    editor.addEventListener('input', () => handleEditorInput());
    applyButton.addEventListener('click', apply);
    overlay.querySelector('.scp-char-field-editor-cancel').addEventListener('click', close);
    closeButton.addEventListener('click', close);
    overlay.addEventListener('scp-char-editor-find', () => {
        if (!searchOpen) setSearchOpen(true);
        else { searchInput.focus(); searchInput.select(); }
    });
    overlay.addEventListener('keydown', event => {
        const hasShortcutModifier = event.ctrlKey || event.metaKey;
        const shortcutKey = event.key.toLowerCase();
        if (hasShortcutModifier && (shortcutKey === 'z' || shortcutKey === 'y')) {
            event.preventDefault();
            restoreEditorHistory(shortcutKey === 'z' && !event.shiftKey);
        } else if (hasShortcutModifier && shortcutKey === 'f') {
            event.preventDefault();
            if (!searchOpen) setSearchOpen(true);
            else { searchInput.focus(); searchInput.select(); }
        } else if (event.key === 'Escape' && searchOpen) {
            event.preventDefault();
            setSearchOpen(false);
        } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            apply();
        }
    });
    requestAnimationFrame(() => {
        refreshSearch();
        editor.focus();
        setSelectionOffsets(editorValue.length);
    });
}

function _buildFieldRow(field, getValue, onDirty) {
    const row = document.createElement('div');
    row.className = 'scp-char-field-row';
    const labelRow = document.createElement('div');
    labelRow.className = 'scp-char-field-label-row';
    const label = document.createElement('span');
    label.className = 'scp-char-field-label';
    label.textContent = field.label;
    const tokenCount = document.createElement('span');
    tokenCount.className = 'scp-char-field-tokens';
    const showTokens = field.showTokens !== false;
    const expandButton = document.createElement('button');
    expandButton.className = 'scp-char-field-expand';
    expandButton.type = 'button';
    expandButton.innerHTML = I.expand;
    expandButton.title = `Expand ${field.label} editor`;
    expandButton.setAttribute('aria-label', `Expand ${field.label} editor`);
    labelRow.append(label);
    if (showTokens) labelRow.appendChild(tokenCount);
    labelRow.appendChild(expandButton);

    const input = document.createElement(field.multiline ? 'textarea' : 'input');
    input.className = field.multiline ? 'scp-char-field-textarea' : 'scp-char-field-input';
    if (!field.multiline) input.type = 'text';
    if (field.multiline) input.rows = 5;
    let timer = 0;
    const initial = String(getValue() || '');
    input.value = initial;
    row.append(labelRow, input);
    expandButton.addEventListener('click', () => _openExpandedFieldEditor(field, input));

    const updateTokens = async value => {
        try {
            const count = await estimateTokens(value);
            if (tokenCount.isConnected) tokenCount.textContent = `[~${count} tokens]`;
        } catch (_) {
            if (tokenCount.isConnected) tokenCount.textContent = '';
        }
    };
    if (showTokens) updateTokens(initial);
    input.addEventListener('input', () => {
        onDirty(input.value, initial);
        if (!showTokens) return;
        tokenCount.textContent = '[...]';
        clearTimeout(timer);
        timer = setTimeout(() => updateTokens(input.value), 600);
    });
    return row;
}

function _buildCurrentInfoTab(entity, saveButton, revertButton) {
    const pane = document.createElement('div');
    pane.className = 'scp-char-pane scp-char-pane-info';
    const groups = entity.isPersona
        ? [{ title: 'Identity', fields: [{ key: 'user_persona', label: 'Persona Description', multiline: true }] }]
        : FIELD_GROUPS;
    const dirty = {};
    const char = entity.isPersona ? null : entity.char;

    const updateButtons = () => {
        const hasChanges = Object.keys(dirty).length > 0;
        saveButton.disabled = !hasChanges || _currentExternalChange;
        revertButton.disabled = !hasChanges;
        saveButton.style.opacity = hasChanges ? '1' : '0.4';
        revertButton.style.opacity = hasChanges ? '1' : '0.4';
        saveButton.title = _currentExternalChange
            ? 'Native SillyTavern fields changed. Revert this panel before saving.'
            : '';
        _currentIsDirty = hasChanges;
    };

    groups.forEach(group => {
        const section = document.createElement('section');
        section.className = 'scp-char-section';
        const title = document.createElement('div');
        title.className = 'scp-char-section-title';
        title.textContent = group.title;
        section.appendChild(title);
        group.fields.forEach(field => section.appendChild(_buildFieldRow(
            field,
            () => getCharFieldValue(char, field.key),
            (value, initial) => {
                if (value === initial) delete dirty[field.key];
                else dirty[field.key] = value;
                updateButtons();
            },
        )));
        pane.appendChild(section);
    });

    pane._saveFn = async () => {
        if (!Object.keys(dirty).length) return true;
        if (_currentExternalChange) {
            toastr.warning('Native SillyTavern fields changed. Revert this panel before saving.', EXT_DISPLAY);
            return false;
        }
        const originalLabel = saveButton.innerHTML;
        saveButton.disabled = true;
        saveButton.innerHTML = `${I.check}<span>Saving...</span>`;
        _currentSaveInProgress = true;
        try {
            for (const [field, value] of Object.entries(dirty)) {
                await saveCharacterField(char, field, value);
                delete dirty[field];
            }
            _currentIsDirty = false;
            toastr.success('Character fields saved.', EXT_DISPLAY);
            _renderCharDetail(entity);
            return true;
        } catch (error) {
            toastr.error(`Failed to save character: ${error.message}`, EXT_DISPLAY);
            saveButton.innerHTML = originalLabel;
            updateButtons();
            return false;
        } finally {
            _currentSaveInProgress = false;
        }
    };
    pane._updateButtons = updateButtons;
    return pane;
}

function _buildPrivateNotesTab(entity, saveButton, revertButton) {
    const pane = document.createElement('div');
    pane.className = 'scp-char-pane scp-char-pane-private-notes';

    const hint = document.createElement('div');
    hint.className = 'scp-char-private-hint';
    hint.textContent = 'These notes are private to you and are never sent to the AI.';
    pane.appendChild(hint);

    const initialNotes = _getPrivateNotes(entity);
    const dirty = {};
    const updateButtons = () => {
        const hasChanges = Object.keys(dirty).length > 0;
        saveButton.disabled = !hasChanges;
        revertButton.disabled = !hasChanges;
        saveButton.style.opacity = hasChanges ? '1' : '0.4';
        revertButton.style.opacity = hasChanges ? '1' : '0.4';
        _currentIsDirty = hasChanges;
    };

    const section = document.createElement('section');
    section.className = 'scp-char-section';
    const title = document.createElement('div');
    title.className = 'scp-char-section-title';
    title.textContent = 'Private Notes';
    section.appendChild(title);
    PRIVATE_NOTE_FIELDS.forEach(field => section.appendChild(_buildFieldRow(
        field,
        () => initialNotes[field.key],
        (value, initial) => {
            if (value === initial) delete dirty[field.key];
            else dirty[field.key] = value;
            updateButtons();
        },
    )));
    pane.appendChild(section);

    pane._saveFn = async () => {
        if (!Object.keys(dirty).length) return true;
        const originalLabel = saveButton.innerHTML;
        saveButton.disabled = true;
        saveButton.innerHTML = `${I.check}<span>Saving...</span>`;
        try {
            const settings = getSettings();
            if (!settings.charMgrPrivateNotes) settings.charMgrPrivateNotes = {};
            const key = _getPrivateNotesKey(entity);
            const notes = { ..._getPrivateNotes(entity) };
            for (const [field, value] of Object.entries(dirty)) notes[field] = value;
            settings.charMgrPrivateNotes[key] = notes;
            saveSettings();
            Object.assign(initialNotes, notes);
            Object.keys(dirty).forEach(field => delete dirty[field]);
            saveButton.innerHTML = originalLabel;
            updateButtons();
            _currentIsDirty = false;
            toastr.success('Private notes saved.', EXT_DISPLAY);
            return true;
        } catch (error) {
            toastr.error(`Failed to save private notes: ${error.message}`, EXT_DISPLAY);
            saveButton.innerHTML = originalLabel;
            updateButtons();
            return false;
        }
    };
    pane._updateButtons = updateButtons;
    return pane;
}

function _buildOverrideRow(entity, field) {
    const row = document.createElement('div');
    row.className = 'scp-char-ov-row';
    const label = document.createElement('label');
    label.className = 'scp-char-override-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = field.label;
    label.append(checkbox, text);

    const clear = document.createElement('button');
    clear.className = 'scp-char-override-reset';
    clear.title = 'Clear override';
    clear.textContent = 'Reset';

    const refresh = () => {
        const settings = getSettings();
        let override = getCharFieldOverride(settings, entity.id, field.key);
        const globalValue = getEffectiveCharField(settings, field.key);
        if (override !== undefined && override === globalValue) {
            setCharFieldOverride(settings, entity.id, field.key, undefined);
            saveSettings();
            override = undefined;
        }
        const hasOverride = override !== undefined;
        checkbox.checked = hasOverride ? override : globalValue;
        row.classList.toggle('scp-char-ov-row-active', hasOverride);
        clear.disabled = !hasOverride;
        clear.classList.toggle('active', hasOverride);
    };
    row._refreshOverride = refresh;
    refresh();

    checkbox.addEventListener('change', () => {
        const globalValue = getEffectiveCharField(getSettings(), field.key);
        setCharFieldOverride(getSettings(), entity.id, field.key, checkbox.checked === globalValue ? undefined : checkbox.checked);
        saveSettings();
        refresh();
    });
    clear.addEventListener('click', () => {
        setCharFieldOverride(getSettings(), entity.id, field.key, undefined);
        saveSettings();
        refresh();
    });
    row.append(label, clear);
    return row;
}

function _buildOverridesTab(entity) {
    const pane = document.createElement('div');
    pane.className = 'scp-char-pane scp-char-pane-overrides';
    const hint = document.createElement('div');
    hint.className = 'scp-char-ov-hint';
    hint.textContent = `Choose which fields of ${entity.name || 'this character'} are sent to AI context. Unchecked uses global settings.`;
    pane.appendChild(hint);
    OV_FIELDS.forEach(field => pane.appendChild(_buildOverrideRow(entity, field)));
    return pane;
}

function _renderCharDetail(entity) {
    const main = document.getElementById('scp-char-main');
    if (!main) return;
    main.innerHTML = '';
    _currentIsDirty = false;
    _currentSaveFn = null;
    _currentUpdateButtons = null;
    _currentExternalChange = false;

    const banner = _buildBanner(entity);
    const actions = document.createElement('div');
    actions.className = 'scp-char-banner-actions';
    const saveButton = document.createElement('button');
    saveButton.className = 'scp-action-btn scp-char-banner-save-btn';
    saveButton.innerHTML = `${I.check}<span>Save</span>`;
    saveButton.disabled = true;
    saveButton.style.opacity = '0.4';
    const revertButton = document.createElement('button');
    revertButton.className = 'scp-action-btn';
    revertButton.innerHTML = `${I.x}<span>Revert</span>`;
    revertButton.disabled = true;
    revertButton.style.opacity = '0.4';
    actions.append(saveButton, revertButton);
    banner.appendChild(actions);
    main.appendChild(banner);

    const tabs = document.createElement('div');
    tabs.className = 'scp-char-tabs';
    const infoTab = document.createElement('button');
    infoTab.className = 'scp-char-tab active';
    infoTab.textContent = 'Current Info';
    const overridesTab = document.createElement('button');
    overridesTab.className = 'scp-char-tab';
    overridesTab.textContent = 'Overrides';
    overridesTab.disabled = entity.isPersona;
    const privateNotesTab = document.createElement('button');
    privateNotesTab.className = 'scp-char-tab';
    privateNotesTab.textContent = 'Private Notes';
    tabs.append(infoTab, overridesTab, privateNotesTab);
    main.appendChild(tabs);

    const infoPane = _buildCurrentInfoTab(entity, saveButton, revertButton);
    const overridesPane = entity.isPersona ? null : _buildOverridesTab(entity);
    const privateNotesPane = _buildPrivateNotesTab(entity, saveButton, revertButton);
    saveButton.addEventListener('click', () => { if (!saveButton.disabled && _currentSaveFn) _currentSaveFn(); });
    revertButton.addEventListener('click', () => {
        if (!revertButton.disabled) {
            _currentIsDirty = false;
            _renderCharDetail(entity);
        }
    });
    main.appendChild(infoPane);
    if (overridesPane) {
        overridesPane.style.display = 'none';
        main.appendChild(overridesPane);
    }
    privateNotesPane.style.display = 'none';
    main.appendChild(privateNotesPane);

    const showInfo = () => {
        infoTab.classList.add('active');
        overridesTab.classList.remove('active');
        privateNotesTab.classList.remove('active');
        infoPane.style.display = '';
        if (overridesPane) overridesPane.style.display = 'none';
        privateNotesPane.style.display = 'none';
        actions.style.display = 'flex';
        _currentSaveFn = infoPane._saveFn;
        _currentUpdateButtons = infoPane._updateButtons;
        infoPane._updateButtons();
        _lastActiveTab = 'info';
    };
    const showOverrides = () => {
        if (!overridesPane) return;
        overridesTab.classList.add('active');
        infoTab.classList.remove('active');
        privateNotesTab.classList.remove('active');
        infoPane.style.display = 'none';
        overridesPane.style.display = '';
        privateNotesPane.style.display = 'none';
        actions.style.display = 'none';
        _currentSaveFn = null;
        _currentUpdateButtons = null;
        _lastActiveTab = 'overrides';
    };
    const showPrivateNotes = () => {
        privateNotesTab.classList.add('active');
        infoTab.classList.remove('active');
        overridesTab.classList.remove('active');
        infoPane.style.display = 'none';
        if (overridesPane) overridesPane.style.display = 'none';
        privateNotesPane.style.display = '';
        actions.style.display = 'flex';
        _currentSaveFn = privateNotesPane._saveFn;
        _currentUpdateButtons = privateNotesPane._updateButtons;
        privateNotesPane._updateButtons();
        _lastActiveTab = 'private-notes';
    };
    const switchTabWithGuard = (tabName, showTab) => {
        if (_lastActiveTab === tabName) return;
        if (!_currentIsDirty || !_currentSaveFn) {
            showTab();
            return;
        }
        const saveFn = _currentSaveFn;
        _showUnsavedDialog(async () => {
            const saved = await saveFn();
            if (saved !== false) {
                _lastActiveTab = tabName;
                _renderCharDetail(entity);
            }
        }, () => {
            _currentIsDirty = false;
            _lastActiveTab = tabName;
            _renderCharDetail(entity);
        });
    };
    infoTab.addEventListener('click', () => switchTabWithGuard('info', showInfo));
    overridesTab.addEventListener('click', () => switchTabWithGuard('overrides', showOverrides));
    privateNotesTab.addEventListener('click', () => switchTabWithGuard('private-notes', showPrivateNotes));
    if (_lastActiveTab === 'overrides' && overridesPane) showOverrides();
    else if (_lastActiveTab === 'private-notes') showPrivateNotes();
    else showInfo();
    requestAnimationFrame(() => { main.scrollTop = _lastScrollTop; });
}

export function openCharacterManager() {
    const overlay = document.getElementById('scp-char-overlay');
    if (!overlay) return;
    if (overlay.parentElement !== document.body) document.body.appendChild(overlay);
    applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    _renderCharList();
    overlay.style.display = 'flex';
}

export function closeCharacterManager() {
    const overlay = document.getElementById('scp-char-overlay');
    if (!overlay) return;
    const main = document.getElementById('scp-char-main');
    if (main) _lastScrollTop = main.scrollTop;
    if (_currentIsDirty && _currentSaveFn) {
        _showUnsavedDialog(async () => {
            const saved = await _currentSaveFn();
            if (saved !== false) {
                _currentIsDirty = false;
                _currentSaveFn = null;
                overlay.style.display = 'none';
            }
        }, () => {
            _currentIsDirty = false;
            _currentSaveFn = null;
            overlay.style.display = 'none';
        });
        return;
    }
    _currentIsDirty = false;
    _currentSaveFn = null;
    _currentUpdateButtons = null;
    _currentExternalChange = false;
    overlay.style.display = 'none';
}

export function setupCharacterManagerListeners() {
    const overlay = document.getElementById('scp-char-overlay');
    if (!overlay || overlay.dataset.bound === 'true') return;
    overlay.dataset.bound = 'true';
    let mouseDownTarget = null;
    overlay.addEventListener('mousedown', event => { mouseDownTarget = event.target; });
    overlay.addEventListener('click', event => {
        if (event.target === overlay && mouseDownTarget === overlay) closeCharacterManager();
    });
    document.getElementById('scp-char-close')?.addEventListener('click', closeCharacterManager);

    const ctx = SillyTavern.getContext();
    const es = ctx.eventSource || window.eventSource;
    const et = ctx.eventTypes || ctx.event_types || window.event_types || {};
    if (es) {
        es.on(et.CHARACTER_EDITED || 'character_edited', payload => _handleExternalDataChange('character', payload));
        es.on(et.PERSONA_UPDATED || 'persona_updated', payload => _handleExternalDataChange('persona', payload));
    }
}