# Mandatory Character Manager Description Editor Invariants

These invariants remain required even after the compact-panel and overlay-positioning fixes. They protect the editor's source-text, highlighting, focus, and selection behavior; they are not instructions to recreate the old full-screen overlay.

These rules apply ONLY to the Character Manager's expanded character Description and user Persona Description editors, and to visual highlighting in those editors. Do not apply this requirement to other panels or text fields. Do not rely on prior chat history; follow this file whenever changing these Character Manager description editors.

- The editor MUST use a single editable surface for source text, Markdown emphasis colors, bullet/label colors, and search-match highlights. NEVER add a separately laid-out text overlay or mirrored preview.
- Format `**bold**`, `*italic*`, bullet dashes, and bullet labels only inside the same editable surface. Real bold and italic styling is allowed there because no second text layout is being aligned against it.
- Search MUST highlight every match and keep previous/next navigation and match counts functional without introducing a second rendered text layer.
- Preserve the exact plain-text source, including Markdown markers, punctuation, whitespace, and newlines, when reading from or saving the editable surface. Highlighting MUST NOT insert markup into the saved value, prompt construction, or roleplay model input.
- Verify editing, selection, paste, Enter/newlines, search navigation, save, and wrapping in the actual Character Manager editor. Test a long line wrapping near a word boundary with text selected across the wrap. Do not claim browser verification unless it was performed.