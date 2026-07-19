/**
 * state.js
 * Shared MUTABLE runtime state that multiple feature/UI modules need to read
 * and/or write. In the original single-file build these were just top-level
 * `let` variables in the closure, so every function could freely read and
 * reassign them. Once split into ES modules that free-for-all isn't possible:
 * a module that does `import { windowEl } from './state.js'` gets a live
 * binding it can READ, but only the owning module (this one) can reassign a
 * `let`/`const`. So anything that needs to be *set* from outside gets a
 * getter + setter pair instead of a bare export.
 *
 * Rule of thumb for what belongs here vs. living inside a feature file:
 *   - Used by 3+ unrelated modules (UI shell, features, utils)  -> state.js
 *   - Only used within one feature's own functions                -> keep it
 *     as a module-private `let` inside that feature's file instead.
 * Don't turn this into a junk drawer — most of the ~90 `let`/`const`
 * variables in the old index.js are feature-private and should move with
 * their feature, not land here.
 */

// ── SillyTavern core module handles (populated once during init) ──────────
let _stWorldInfo = null;
let _stUtils = null;

export function getSTWorldInfo() { return _stWorldInfo; }
export function setSTWorldInfo(mod) { _stWorldInfo = mod; }

export function getSTUtils() { return _stUtils; }
export function setSTUtils(mod) { _stUtils = mod; }

// ── Extension identity / install path (resolved once during init) ────────
let _extVersion = '?';
let _extPath = 'third-party/ST-Copilot';

export function getExtVersion() { return _extVersion; }
export function setExtVersion(v) { _extVersion = v; }

export function getExtPath() { return _extPath; }
export function setExtPath(p) { _extPath = p; }

// Figures out the extension's own install path by inspecting the <script>
// tag that loaded it. Call this once, early, during bootstrap in index.js.
// (Moved verbatim from the top of the old index.js closure.)
export function resolveExtPath() {
    if (document.currentScript && document.currentScript.src) {
        const match = new URL(document.currentScript.src).pathname.match(/\/scripts\/extensions\/(.+)\/[^\/]+\.js$/);
        if (match) _extPath = match[1];
    } else {
        for (let s of document.getElementsByTagName('script')) {
            if (s.src && s.src.includes('index.js') && s.src.toLowerCase().includes('copilot')) {
                const match = new URL(s.src).pathname.match(/\/scripts\/extensions\/(.+)\/[^\/]+\.js$/);
                if (match) { _extPath = match[1]; break; }
            }
        }
    }
    return _extPath;
}

// ── Core DOM handles, set once by injectUI() during bootstrap ─────────────
let _windowEl = null;
let _iconEl = null;
let _modalEl = null;

export function getWindowEl() { return _windowEl; }
export function setWindowEl(el) { _windowEl = el; }

export function getIconEl() { return _iconEl; }
export function setIconEl(el) { _iconEl = el; }

export function getModalEl() { return _modalEl; }
export function setModalEl(el) { _modalEl = el; }

// ── Cross-feature flags ────────────────────────────────────────────────────
// Whether ST-Copilot is the active "driver" of generation for this chat.
// Read by Generation Flow, Continue Generation, and the window toolbar.
let _copilotActive = false;

export function isCopilotActive() { return _copilotActive; }
export function setCopilotActive(v) { _copilotActive = !!v; }
