/**
 * util-text.js
 * Pure text/string helpers with no DOM or SillyTavern dependencies.
 *
 * Moved from original index.js line 2688 (`_repairJSON`, inside the
 * unlabeled section between Character Card Engine and Diff Engine).
 * Used in 5+ places across the codebase (lorebook parsing, character-edit
 * parsing, chat-edit parsing, session file loading) — always to recover a
 * usable object from LLM output or a possibly-corrupted save file that
 * isn't quite valid JSON (trailing commas, unescaped quotes, unbalanced
 * brackets).
 */

export function repairJSON(raw) {
    let s = raw;
    s = s.replace(/,\s*([\}\]])/g, '$1');
    try {
        s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (match, inner) => {
            const fixed = inner.replace(/(?<!\\)"/g, '\\"');
            return `"${fixed}"`;
        });
    } catch (_) {}
    const opens = (s.match(/[\[{]/g) || []).length;
    const closes = (s.match(/[\]\}]/g) || []).length;
    if (opens > closes) {
        const stack = [];
        for (const ch of s) {
            if (ch === '{') stack.push('}');
            else if (ch === '[') stack.push(']');
            else if (ch === '}' || ch === ']') stack.pop();
        }
        s += stack.reverse().join('');
    }
    return s;
}
