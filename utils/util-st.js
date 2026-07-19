/**
 * util-st.js
 * Helpers that read SillyTavern's own global context/state to answer
 * "what character/chat is active right now" style questions.
 *
 * Moved from original index.js lines 6320–6344, physically sitting right
 * before "Storage Subsystem" but used in 19 places across the codebase —
 * it's a general-purpose ST helper, not storage-specific, so it gets its
 * own file. `getUserPersona`/`getAuthorsNote` (old lines 6685–6713) and
 * `getTagsForCharacter` (old line 902, inside the Lorebook Module section)
 * are the same kind of helper — pure reads of SillyTavern's own global
 * state — so they've been folded in here too rather than waiting for
 * Lorebook Module / "ST Context Helpers" to be split as their own pass.
 */

export function getUserPersona() {
    const ctx = SillyTavern.getContext();

    try {
        let expanded = '';
        if (typeof ctx.substituteParams === 'function') {
            expanded = ctx.substituteParams('{{persona}}');
        } else if (typeof window.substituteParams === 'function') {
            expanded = window.substituteParams('{{persona}}');
        }
        if (expanded && expanded !== '{{persona}}') return expanded;
    } catch (_) {}

    try {
        const pu = window.power_user;
        if (pu) {
            if (typeof pu.persona_description === 'string' && pu.persona_description) return pu.persona_description;
            if (pu.personas && pu.persona && pu.personas[pu.persona]?.description) return pu.personas[pu.persona].description;
            if (typeof pu.persona === 'string' && pu.persona.length > 30 && !pu.persona.endsWith('.json')) return pu.persona;
        }
    } catch (_) {}

    return ctx.persona || ctx.userPersona || ctx.user_persona || '';
}

export function getAuthorsNote() {
    const ctx = SillyTavern.getContext();
    return ctx.chatMetadata?.note_prompt || ctx.authorsNote || ctx.authors_note || '';
}

export function getTagsForCharacter(char) {
    if (!char) return [];
    const ctx = SillyTavern.getContext();
    const avatar = char.avatar;
    if (!avatar) return [];

    const tagMap = ctx.tagMap || {};
    const tagIds = tagMap[avatar];
    if (!Array.isArray(tagIds)) return [];

    const allTags = ctx.tags || [];
    return tagIds.map(id => {
        const found = allTags.find(t => t.id === id);
        return found ? found.name : null;
    }).filter(Boolean);
}

export function getBindingKey() {
    const ctx = SillyTavern.getContext();
    let charId = 'global';
    if (ctx.characterId !== undefined && ctx.characterId !== null) {
        charId = String(ctx.characterId);
    } else if (typeof window.this_chid !== 'undefined' && window.this_chid !== null) {
        charId = String(window.this_chid);
    }

    let chatId = 'default';
    try {
        if (typeof window.chat_file_name === 'string' && window.chat_file_name) {
            chatId = String(window.chat_file_name);
        } else if (typeof ctx.getCurrentChatId === 'function') {
            const r = ctx.getCurrentChatId(); if (r) chatId = String(r);
        }

        if (chatId === 'default' || !chatId) {
            if (ctx.chatId) chatId = String(ctx.chatId);
            else if (typeof window.chat_id !== 'undefined' && window.chat_id !== null) chatId = String(window.chat_id);
        }
    } catch (_) {}

    return { charId, chatId };
}
