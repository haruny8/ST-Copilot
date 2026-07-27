/**
 * settings.js
 * Extension-wide settings: reads/writes SillyTavern's per-extension
 * settings object, filling in defaults for any key that isn't set yet.
 * (Not to be confused with session.js, which stores per-chat roleplay
 * session/message history in separate files.)
 *
 * Moved from original index.js "Settings" section (lines 5419-5521, 102 lines).
 */

import { EXT_NAME, THEME_PRESETS } from './constants.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_LB_MANAGE_PROMPT } from './default-prompts.js';
import { dbgDiffSettings } from './utils/util-debug.js';

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXT_NAME]) extensionSettings[EXT_NAME] = {};
    const s = extensionSettings[EXT_NAME];
    const defaults = {
        enabled: true,
        performanceMode: false,
        windowVisible: false,
        minimized: false,
        windowX: null, windowY: null,
        iconX: null, iconY: null,
        windowW: 440, windowH: 600,
        opacity: 95,
        hotkey: 'Alt+Shift+C',
        hotkeyEnabled: true,
        searchHotkey: 'Ctrl+F',
        searchHotkeyEnabled: true,
        contextDepth: 15,
        localHistoryLimit: 50,
        connectionSource: 'default',
        connectionProfileId: '',
        maxTokens: 8048,
        includeSystemPrompt: false,
        includeAuthorsNote: true,
        includeCharacterCard: true,
        includeUserPersonality: true,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        profiles: {},
        activeProfile: '',
        profileBindings: {},
        customTheme: { ...THEME_PRESETS.default },
        savedThemes: {},
        activeThemeProfile: '',
        sessions: {},
        lorebookEnabled: true,
        lorebookAutoKeyword: true,
        lorebookSelectedBooks: [],
        lorebookEntryOverrides: {},
        lorebookAIManageEnabled: true,
        lorebookManagePrompt: DEFAULT_LB_MANAGE_PROMPT,
        lorebookSTScanDepth: 5,
        lorebookCopilotScanDepth: 6,
        floatingIconPersistent: false,
        reasoningTrimStrings: '',
        ghostModeOpacity: 15,
        ghostModeHotkey: 'Alt+Shift+G',
        ghostModeHotkeyEnabled: true,
        quickPromptsVisible: false,
        quickPrompts: [
            { id: 'qp_d1', label: 'Analyze', icon: '🔍', text: 'Analyze the current scene and character motivations in detail.' },
            { id: 'qp_d2', label: 'Ideas', icon: '💡', text: 'Give me 3 creative plot twist ideas for the current scene.' },
            { id: 'qp_d3', label: 'Summary', icon: '📋', text: 'Summarize everything that has happened in the roleplay so far.' },
            { id: 'qp_d4', label: 'Feelings', icon: '💭', text: 'What is {{char}} likely feeling right now and why?' },
            { id: 'qp_d5', label: 'Next?', icon: '🎯', text: 'What are the most interesting directions the story could go next?' },
        ],
        quickPromptSets: {},
        activeQuickPromptSet: '',
        promptPresets: {},
        stats: { g: {}, c: {}, ch: {} },
        changelogAutoShow: true,
        lastSeenVersion: '',
        starredMessages: {},
        forceStreaming: 'auto',
        applyRegexToContext: true,
        includeInlineSummaryOriginals: false,
        charEditAIEnabled: true,
        charEditPrompt: '',
        charEditFields: {
            tags: true,
            description: true,
            personality: true,
            scenario: true,
            first_mes: true,
            mes_example: true,
            alternate_greetings: false,
            authors_note: true,
        },
        completionSound: 'none',
        completionSoundVolume: 80,
        completionSoundOnlyWhenUnfocused: false,
        wobbleWindow: false,
        altGreetingIndices: [],
        chatEditAIEnabled: true,
        chatEditPrompt: '',
        lorebookExcludedBooks: [],
        windowBgUrl: '',
        windowBgDim: 50,
        windowBgType: 'none',
        pickerPreviewLines: 1,
        pickerPreviewLastLines: 0,
        imageAnalysisMode: 'direct',
        attachedFiles: [],
    };
    for (const [k, v] of Object.entries(defaults)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
    dbgDiffSettings();
}
