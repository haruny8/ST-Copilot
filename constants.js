/**
 * constants.js
 * Static, non-mutating values used across ST-Copilot: extension identifiers,
 * DOM element ids, changelog entries, theme presets, and SVG icon strings.
 *
 * Nothing in this file holds runtime state — if a value changes while the
 * extension is running, it does NOT belong here (see state.js instead).
 */

export const EXT_NAME = 'st_copilot';
export const EXT_DISPLAY = 'ST-Copilot';
export const WIN_ID = 'scp-window';
export const ICON_ID = 'scp-dock-icon';
export const MODAL_ID = 'scp-ctx-modal';
export const ICON_STORAGE_KEY = 'scp-icon-position';

// ─── Changelog Data ──────────────────────────────────────────────────────────
export const CHANGELOG = [
{
    version: '2.7.2',
    date: '5/29/2026',
    announce: true,
    notes: [
        '<strong>Shortcuts Overlay</strong> — Introduced a dedicated "Shortcuts" configuration window in the settings panel.',
        '<strong>Context-Aware Search</strong> — Refined the search shortcut to trigger exclusively when the Copilot window is active.',
        '<strong>Character Factory Fixes</strong> — Resolved several bugs affecting character creation and metadata initialization.',
        '<strong>Asset Optimization</strong> — Overhauled background storage logic for better performance and reduced storage overhead.'
    ],
},
{
    version: '2.7.1',
    date: '5/28/2026',
    announce: true,
    notes: [
        '<strong>Character Tagging</strong> — Added the ability to modify the "tags" field for already existing characters.',
        '<strong>Low Performance Mode</strong> — Introduced a new toggle to optimize resource usage on lower-end hardware.',
        '<strong>Session Stability</strong> — Completely overhauled the session saving system to prevent spontaneous session loss and data corruption.',
        '<strong>General Optimization</strong> — Improved core logic for better performance and overall stability of ST-Copilot. Fixed AI Generation errors.'
    ],
},
{
    version: '2.7.0',
    date: '5/27/2026',
    announce: false,
    notes: [
        '<strong>Proposed Chat Edits</strong> — Bulk-modify, delete, or hide message ranges using natural language instructions.',
        '<strong>File Attachments & Vision</strong> — Support for text/image uploads with vision model integration and an internal previewer.',
        '<strong>Message Swiping</strong> — Regenerate Copilot responses and navigate through multiple swipe iterations.',
        '<strong>Multimedia Backgrounds</strong> — Custom image/video backgrounds (local or URL) with adjustable dimming.',
        '<strong>Character Creator</strong> — Added "tags" field support and optimized generation prompts for AI-assisted creation.',
        '<strong>Configuration Sync</strong> — AI settings are now linked to Configuration Profiles and Session Overrides.',
        '<strong>UX Enhancements</strong> — Added "Always Off" Lorebook state, sender-based group selection in context picker, and focus-aware notification sounds.',
        '<strong>UI & Maintenance</strong> — Improved "Save" button feedback, better theme support for lists, and optimized generation logic.'
    ],
},
{
    version: '2.5.1',
    date: '5/22/2026',
    announce: false,
    notes: [
        '<strong>Continue Message</strong> — Added a "Continue" button to extend the last Copilot generation.',
        '<strong>Debug Export</strong> — Introduced a downloadable debug log in settings for easier troubleshooting (refreshes on page load).',
        '<strong>Smooth Streaming</strong> — Fixed chat scrolling behavior, allowing users to scroll up during active message streaming.',
        '<strong>Bug Fixes</strong> — Potential fix for the "profile not found" error and minor stability improvements.'
    ],
},
{
    version: '2.5.0',
    date: '5/20/2026',
    announce: false,
    notes: [
        '<strong>Character Card Manager</strong> — You can now create new characters entirely from scratch or edit existing card fields directly within the extension.',
        '<strong>Massive Token Optimization</strong> — "Proposed Changes" now uses a smart search-and-replace method, reducing token consumption by over 80% (Huge thanks to Steel-skull for the PR!).',
        '<strong>Robust Parsing</strong> — The system now successfully finds and applies "proposed changes" blocks even if the AI makes formatting mistakes.',
        '<strong>Session Management</strong> — Added the ability to export and import sessions. Under-the-hood session saving has also been rewritten to be much more efficient.',
        '<strong>UI, Sounds & Polish</strong> — Added a generation-complete sound notification, soothing window wobble physics, smooth chart animations in Stats, and new Streaming modes (Auto, Force On, Force Off).',
        '<strong>Lorebook Updates</strong> — Added a "constant" parameter for proposed changes and moved toggles to the main Settings. ⚠️ <em>Important: Please reset your Lorebook AI Edit prompt to default!</em>',
        '<strong>Mobile & Fixes</strong> — The Enter key on mobile keyboards now correctly inserts line breaks instead of sending messages. Fixed mobile UI headers, resolved duplicate user message bugs, and redesigned system message outputs.'
    ],
},    
{
    version: '2.3.0',
    date: '5/10/2026',
    announce: false,
    notes: [
        '<strong>Stream Support</strong> — Added streaming support so you can see generations in real-time.',
        '<strong>Reasoning Blocks</strong> — Added support for displaying Reasoning blocks',
        '<strong>Regex Support</strong> — Clean up formatting and fluff from chat messages included in the context.',
        '<strong>Preset Customization</strong> — Modify QuickPrompts and SystemPrompts presets directly (SystemPrompts handled via session override).',
        '<strong>Favorite Messages</strong> — You can now mark specific messages as Favorites.',
        '<strong>In-app Changelog</strong> — Added a Changelog window to easily track new updates.',
        '<strong>Fixes & Polish</strong> — Synced chat context picker numbering with ST (0 to N), fixed Lorebook context persistence after disconnection, and improved the default Lorebook edit prompt.'
    ],
},
{
    version: '2.0.0',
    date: '5/03/2026',
    announce: false,
    notes: [
        '<strong>Messages Payload</strong> — Handpick specific messages from the chat history and feed them directly to the AI.',
        '<strong>Quick Prompts</strong> — Fully customizable prompt buttons with emoji icons.',
        '<strong>Ghost Mode</strong> — Copilot can now become semi-transparent and completely click-through.',
        '<strong>Expanded Context Awareness</strong> — Context now includes Character Note, Example of Dialogue, and respects settings overrides.',
        '<strong>Temporary Sessions</strong> — Create sessions that automatically delete themselves when you switch.',
        '<strong>Usage Stats</strong> — A new interactive Statistics window to track your metrics.',
        '<strong>UI & QoL Enhancements</strong> — Save edited messages without regenerating, mobile responsive improvements, HTML support, and clean connecting lines for lists.'
    ],
},
{
    version: '1.9.0',
    date: '4/28/2026',
    announce: false,
    notes: [
        '<strong>Integrated Settings Window</strong> — Dedicated settings UI for seamless adjustments.',
        '<strong>Session-Specific Configuration</strong> — Override global settings for individual sessions.',
        '<strong>Dynamic Context Scaling</strong> — The CTX slider dynamically adjusts its range based on chat length.',
        '<strong>Advanced In-Chat Search</strong> — Quickly locate specific information using (Ctrl + F).',
        '<strong>Theme Portability</strong> — Import and Export custom themes as JSON. Added the new "Dark Sky" preset.'
    ],
},
{
    version: '1.7.2',
    date: '4/27/2026',
    announce: false,
    notes: [
        '<strong>Comfortable Color Picker</strong> — Choose colors natively without leaving the app.',
        '<strong>Default Colors</strong> — Individually reset specific colors to the original theme defaults.',
        '<strong>Resizable edit window</strong> — You can now manually resize the "content" window in the Lorebook Manager.'
    ],
},
{
    version: '1.7.1',
    date: '4/26/2026',
    announce: false,
    notes: [
        '<strong>Expandable Entry Descriptions</strong> — Click to expand chat entry descriptions.',
        '<strong>Lorebook Dropdowns</strong> — Individual Lorebook selection dropdowns for each entry proposal.',
        '<strong>Data Protection</strong> — Added unsaved changes warnings when switching profiles.',
        '<strong>New Macro</strong> — Added support for {{active_lorebooks}}.'
    ],
},
{
    version: '1.7.0',
    date: '4/26/2026',
    announce: false,
    notes: [
        '<strong>AI Lorebook Management</strong> — Copilot AI now actively assists in world-building (AI-Edit).',
        '<strong>Interactive Proposals</strong> — AI generates Proposal Cards to review, edit, or reject changes via a Diff View modal.',
        '<strong>Lorebook Manager UI</strong> — Added manual overrides, Auto-Keywords, and Active Indicators.',
        '<strong>String Trimming</strong> — Automatically remove specific tags (like &lt;think&gt; blocks) from AI responses.',
        '<strong>Persistent Icon</strong> — Option to keep the floating dock icon visible at all times.'
    ],
}
];

    
// ─── Theme Presets ──────────────────────────────────────────────────────────

export const THEME_PRESETS = {
    default: {
        label: 'Dark Sky',
        bg: 'rgba(0,0,0,0.85)', blur: 'blur(14px)',
        text: '#e2e2e6', textMuted: 'rgb(176,176,176)',
        accent: 'rgb(191,191,191)', accentDim: 'rgba(209,209,209,0.4)',
        accentBg: 'rgba(112,112,112,0.08)',
        headerBg: 'rgba(255,255,255,0.04)', toolbarBg: 'rgba(0,0,0,0.25)',
        msgUserBg: 'rgba(214,214,214,0.1)', msgAiBg: 'rgba(214,214,214,0.03)',
        inputBg: 'rgba(0,0,0,0.30)', codeBg: 'rgba(0,0,0,0.35)',
        radius: '10px', danger: '#ff5c5c', success: '#4caf7d',
        shadow: '0 24px 64px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.09)', font: '',
    },
    blue_ocean : {
        label: 'Blue Ocean',
        bg: 'rgba(18,18,22,0.94)', blur: 'blur(14px)',
        text: '#e2e2e6', textMuted: '#72728a',
        accent: '#7c6dfa', accentDim: 'rgba(124,109,250,0.45)',
        accentBg: 'rgba(124,109,250,0.12)',
        headerBg: 'rgba(255,255,255,0.04)', toolbarBg: 'rgba(0,0,0,0.25)',
        msgUserBg: 'rgba(124,109,250,0.10)', msgAiBg: 'rgba(255,255,255,0.03)',
        inputBg: 'rgba(0,0,0,0.30)', codeBg: 'rgba(0,0,0,0.35)',
        radius: '10px', danger: '#ff5c5c', success: '#4caf7d',
        shadow: '0 24px 64px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.09)', font: '',
    },
    onyx_ivory: {
        label: 'Onyx & Ivory',
        bg: 'rgba(17,17,17,0.96)', blur: 'blur(16px)',
        text: '#f4ede4', textMuted: '#b8a898',
        accent: '#d4c4b0', accentDim: 'rgba(212,196,176,0.4)',
        accentBg: 'rgba(212,196,176,0.08)',
        headerBg: 'rgba(244,237,228,0.04)', toolbarBg: 'rgba(0,0,0,0.3)',
        msgUserBg: 'rgba(244,237,228,0.07)', msgAiBg: 'rgba(255,255,255,0.02)',
        inputBg: 'rgba(0,0,0,0.35)', codeBg: 'rgba(0,0,0,0.45)',
        radius: '10px', danger: '#e05c5c', success: '#6ab88a',
        shadow: '0 28px 70px rgba(0,0,0,0.7), 0 4px 18px rgba(0,0,0,0.5)',
        border: '1px solid rgba(244,237,228,0.1)', font: '',
    },
    violet_sun: {
        label: 'Violet & Sun',
        bg: 'rgba(20,8,42,0.97)', blur: 'blur(18px)',
        text: '#f0e8ff', textMuted: '#9a80c0',
        accent: '#ffd60a', accentDim: 'rgba(255,214,10,0.45)',
        accentBg: 'rgba(255,214,10,0.1)',
        headerBg: 'rgba(90,24,154,0.15)', toolbarBg: 'rgba(0,0,0,0.3)',
        msgUserBg: 'rgba(255,214,10,0.07)', msgAiBg: 'rgba(90,24,154,0.06)',
        inputBg: 'rgba(0,0,0,0.4)', codeBg: 'rgba(0,0,0,0.5)',
        radius: '10px', danger: '#ff5c5c', success: '#4caf7d',
        shadow: '0 24px 64px rgba(0,0,0,0.75), 0 0 40px rgba(90,24,154,0.15)',
        border: '1px solid rgba(90,24,154,0.3)', font: '',
    },
    forest_gold: {
        label: 'Forest & Gold',
        bg: 'rgba(2,16,10,0.97)', blur: 'blur(12px)',
        text: '#e8dfc8', textMuted: '#8a9e80',
        accent: '#d4a373', accentDim: 'rgba(212,163,115,0.45)',
        accentBg: 'rgba(212,163,115,0.1)',
        headerBg: 'rgba(212,163,115,0.06)', toolbarBg: 'rgba(0,0,0,0.35)',
        msgUserBg: 'rgba(212,163,115,0.08)', msgAiBg: 'rgba(255,255,255,0.02)',
        inputBg: 'rgba(0,0,0,0.4)', codeBg: 'rgba(0,0,0,0.5)',
        radius: '8px', danger: '#e05c5c', success: '#69a458',
        shadow: '0 24px 64px rgba(0,0,0,0.8), 0 0 30px rgba(2,48,32,0.4)',
        border: '1px solid rgba(212,163,115,0.15)', font: '',
    },
    crimson_cream: {
        label: 'Crimson & Cream',
        bg: 'rgba(28,4,4,0.97)', blur: 'blur(14px)',
        text: '#fff3e0', textMuted: '#c09070',
        accent: '#e85555', accentDim: 'rgba(214,40,40,0.45)',
        accentBg: 'rgba(214,40,40,0.1)',
        headerBg: 'rgba(214,40,40,0.07)', toolbarBg: 'rgba(0,0,0,0.32)',
        msgUserBg: 'rgba(214,40,40,0.08)', msgAiBg: 'rgba(255,243,224,0.02)',
        inputBg: 'rgba(0,0,0,0.38)', codeBg: 'rgba(0,0,0,0.48)',
        radius: '10px', danger: '#ff5c5c', success: '#6ab88a',
        shadow: '0 24px 64px rgba(0,0,0,0.75), 0 0 30px rgba(214,40,40,0.08)',
        border: '1px solid rgba(214,40,40,0.2)', font: '',
    },
    teal_midnight: {
        label: 'Teal & Midnight',
        bg: 'rgba(10,12,24,0.97)', blur: 'blur(16px)',
        text: '#d8f0ee', textMuted: '#5a8a88',
        accent: '#2ec4b6', accentDim: 'rgba(46,196,182,0.4)',
        accentBg: 'rgba(46,196,182,0.1)',
        headerBg: 'rgba(46,196,182,0.06)', toolbarBg: 'rgba(0,0,0,0.3)',
        msgUserBg: 'rgba(46,196,182,0.08)', msgAiBg: 'rgba(255,255,255,0.02)',
        inputBg: 'rgba(0,0,0,0.38)', codeBg: 'rgba(0,0,0,0.48)',
        radius: '10px', danger: '#ff5c5c', success: '#2ec4b6',
        shadow: '0 24px 64px rgba(0,0,0,0.75), 0 0 40px rgba(26,26,46,0.5)',
        border: '1px solid rgba(46,196,182,0.15)', font: '',
    },
    ember_sand: {
        label: 'Ember & Sand',
        bg: 'rgba(22,10,4,0.97)', blur: 'blur(14px)',
        text: '#f5ebe0', textMuted: '#b08060',
        accent: '#ff6f3c', accentDim: 'rgba(255,111,60,0.4)',
        accentBg: 'rgba(255,111,60,0.1)',
        headerBg: 'rgba(255,111,60,0.06)', toolbarBg: 'rgba(0,0,0,0.32)',
        msgUserBg: 'rgba(255,111,60,0.08)', msgAiBg: 'rgba(245,235,224,0.02)',
        inputBg: 'rgba(0,0,0,0.36)', codeBg: 'rgba(0,0,0,0.46)',
        radius: '10px', danger: '#ff5c5c', success: '#6ab88a',
        shadow: '0 24px 64px rgba(0,0,0,0.75), 0 0 30px rgba(255,111,60,0.06)',
        border: '1px solid rgba(255,111,60,0.18)', font: '',
    },
    sage_mist: {
        label: 'Sage & Mist',
        bg: 'rgba(10,18,14,0.96)', blur: 'blur(16px)',
        text: '#e7edeb', textMuted: '#7a9a88',
        accent: '#69a481', accentDim: 'rgba(105,164,129,0.4)',
        accentBg: 'rgba(105,164,129,0.1)',
        headerBg: 'rgba(105,164,129,0.05)', toolbarBg: 'rgba(0,0,0,0.28)',
        msgUserBg: 'rgba(105,164,129,0.08)', msgAiBg: 'rgba(231,237,235,0.02)',
        inputBg: 'rgba(0,0,0,0.32)', codeBg: 'rgba(0,0,0,0.42)',
        radius: '12px', danger: '#e05c5c', success: '#69a481',
        shadow: '0 24px 64px rgba(0,0,0,0.65), 0 0 30px rgba(10,18,14,0.4)',
        border: '1px solid rgba(105,164,129,0.15)', font: '',
    },
    glass: {
        label: 'Glass',
        bg: 'rgba(40,40,55,0.55)', blur: 'blur(22px) saturate(1.6)',
        text: '#f0efff', textMuted: '#9898b8',
        accent: '#a78bfa', accentDim: 'rgba(167,139,250,0.5)',
        accentBg: 'rgba(167,139,250,0.14)',
        headerBg: 'rgba(255,255,255,0.07)', toolbarBg: 'rgba(255,255,255,0.05)',
        msgUserBg: 'rgba(167,139,250,0.10)', msgAiBg: 'rgba(255,255,255,0.05)',
        inputBg: 'rgba(0,0,0,0.25)', codeBg: 'rgba(0,0,0,0.30)',
        radius: '12px', danger: '#ff5c5c', success: '#4caf7d',
        shadow: '0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1) inset',
        border: '1px solid rgba(255,255,255,0.18)', font: '',
    },
    hacker: {
        label: 'Hacker',
        bg: 'rgba(6,14,6,0.97)', blur: 'blur(0px)',
        text: '#88ee88', textMuted: '#3a6640',
        accent: '#00ff88', accentDim: 'rgba(0,255,136,0.45)',
        accentBg: 'rgba(0,255,136,0.08)',
        headerBg: 'rgba(0,255,136,0.06)', toolbarBg: 'rgba(0,0,0,0.6)',
        msgUserBg: 'rgba(0,255,136,0.05)', msgAiBg: 'rgba(0,0,0,0.4)',
        inputBg: 'rgba(0,0,0,0.55)', codeBg: 'rgba(0,0,0,0.7)',
        radius: '4px', danger: '#ff4444', success: '#00ff88',
        shadow: '0 0 30px rgba(0,255,136,0.08), 0 16px 48px rgba(0,0,0,0.8)',
        border: '1px solid #00c77044', font: "'Consolas','Courier New',monospace",
    },
    native: {
        label: 'Native ST',
        bg: 'var(--SmartThemeBlurTrans, rgba(20,20,24,0.92))', blur: 'var(--smartThemeBlur, blur(12px))',
        text: 'var(--SmartThemeBodyColorText, #e2e2e6)', textMuted: 'var(--SmartThemeBodyColorTextMuted, #72728a)',
        accent: 'var(--smartThemeMenuColorText, #7c6dfa)', accentDim: 'var(--white30a, rgba(255,255,255,0.3))',
        accentBg: 'var(--white10a, rgba(255,255,255,0.08))',
        headerBg: 'var(--black30a, rgba(0,0,0,0.3))', toolbarBg: 'var(--black50a, rgba(0,0,0,0.25))',
        msgUserBg: 'var(--black30a, rgba(0,0,0,0.18))', msgAiBg: 'rgba(255,255,255,0.025)',
        inputBg: 'var(--black50a, rgba(0,0,0,0.3))', codeBg: 'var(--black50a, rgba(0,0,0,0.35))',
        radius: '10px', danger: '#ff5c5c', success: '#4caf7d',
        shadow: '0 24px 64px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)',
        border: 'var(--smartThemeBorder, 1px solid rgba(255,255,255,0.09))', font: '',
    },
    
};

export const THEME_VAR_DEFS = [
    { key: 'bg',         label: 'Background',    hint: 'rgba(r,g,b,a)' },
    { key: 'text',       label: 'Text',          hint: '#hex or rgba' },
    { key: 'textMuted',  label: 'Muted Text',    hint: '#hex or rgba' },
    { key: 'accent',     label: 'Accent',        hint: '#hex or rgba' },
    { key: 'accentDim',  label: 'Accent Dim',    hint: 'rgba(r,g,b,a)' },
    { key: 'accentBg',   label: 'Accent BG',     hint: 'rgba(r,g,b,a)' },
    { key: 'headerBg',   label: 'Header BG',     hint: 'rgba(r,g,b,a)' },
    { key: 'toolbarBg',  label: 'Toolbar BG',    hint: 'rgba(r,g,b,a)' },
    { key: 'msgUserBg',  label: 'User Msg BG',   hint: 'rgba(r,g,b,a)' },
    { key: 'msgAiBg',    label: 'AI Msg BG',     hint: 'rgba(r,g,b,a)' },
    { key: 'inputBg',    label: 'Input BG',      hint: 'rgba(r,g,b,a)' },
    { key: 'codeBg',     label: 'Code BG',       hint: 'rgba(r,g,b,a)' },
    { key: 'danger',     label: 'Danger Color',  hint: '#ff5c5c' },
    { key: 'success',    label: 'Success Color', hint: '#4caf7d' },
    { key: 'blur',       label: 'Blur',          hint: 'blur(14px)' },
    { key: 'border',     label: 'Border',        hint: '1px solid rgba(...)' },
    { key: 'radius',     label: 'Corner Radius', hint: '10px' },
    { key: 'shadow',     label: 'Shadow',        hint: 'CSS box-shadow' },
    { key: 'font',       label: 'Font Family',   hint: "system-ui, sans-serif" },
];

export const THEME_CSS_MAP = {
    bg: '--scp-bg', blur: '--scp-blur', border: '--scp-border',
    text: '--scp-text', textMuted: '--scp-text-muted',
    accent: '--scp-accent', accentDim: '--scp-accent-dim', accentBg: '--scp-accent-bg',
    headerBg: '--scp-header-bg', toolbarBg: '--scp-toolbar-bg',
    msgUserBg: '--scp-msg-user-bg', msgAiBg: '--scp-msg-ai-bg',
    inputBg: '--scp-input-bg', codeBg: '--scp-code-bg',
    radius: '--scp-radius', shadow: '--scp-shadow',
    danger: '--scp-danger', success: '--scp-success', font: '--scp-font',
};


// ─── SVG Icons ──────────────────────────────────────────────────────────────

export const ICONS = {
    diff: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>`,
    copy: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    edit: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    send: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    search: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    refresh: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    minus: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    x: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    plus: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    bot: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7" /><ellipse cx="12" cy="12" rx="11" ry="3" transform="rotate(-25 12 12)" /><circle cx="21.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" /></svg>`,
    user: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    stop: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`,
    book: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
    opacity: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor"/></svg>`,
    check: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    chevron: `<svg class="scp-sess-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    gear: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    ghost: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>`,
    lightning: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    pick: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="9" y2="10" stroke-width="3" stroke-linecap="round"/><line x1="12" y1="10" x2="12" y2="10" stroke-width="3" stroke-linecap="round"/><line x1="15" y1="10" x2="15" y2="10" stroke-width="3" stroke-linecap="round"/></svg>`,
    star: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    starFill: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    continueArrow: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>`,
    chevronLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    chevronRight: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    chatEdit: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2v5Z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>`,
    paperclip: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
};

