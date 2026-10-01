Update the Glint panel prototype you made earlier. Keep everything else as it is. This adds an Apply button to each fix and pins down the hotkeys.

## Hotkeys (the complete set)

| Key | Where | Shown in the panel as |
|---|---|---|
| Alt+Enter | in Claude | "check", in the hint row and the welcome text |
| Alt+F | in Claude or the panel | a keycap on the "Use fixed version" button, and "use all" in the hint row |
| Ctrl+Alt+E | anywhere | "show/hide", in the hint row |
| Esc | the panel | "hide", in the hint row |

The panel uses no Alt+number keys at all, because Alt+1 and Alt+3 belong to the user's screenshot tool. If an earlier version added Alt+1, Alt+2, … keycaps or hints, remove them.

## What's new

Each mistake and each optional idea now has its own Apply button. Clicking it changes only that phrase in the user's message in Claude, and Ctrl+Z in Claude undoes it. This lets the user choose fix by fix instead of replacing the whole message.

- **Mouse only.** There is no keyboard shortcut for Apply, so don't show keycaps on these buttons.
- **Numbering:** the host numbers the fixes 1, 2, 3, … across mistakes first, then optional ideas. The number is only sent with the apply action; it doesn't need to be shown.
- **States:** each fix shows one of four states, on its reason line or in its top-right corner, whichever suits your layout:
  - `can`: an "Apply" button. Keep it compact and secondary, so the fix text stays the focus.
  - `applied`: "✓ Applied" in the fix colour (green), with no button.
  - `fixed`: "✓ Already fixed", with no button. Another, overlapping fix already changed these words.
  - `no`: nothing. The words are no longer in the message, because the user edited them.
- **States can change for several fixes at once.** After each apply, every fix's state is recalculated. Applying one fix can turn an overlapping fix into "Already fixed" while the others keep their Apply buttons. Animate state changes subtly and respect `prefers-reduced-motion`.
- **Status line messages:**
  - success: "Applied fix 2. Ctrl+Z in Claude undoes it."
  - already done: "Fix 1 is already in your message."
  - words gone: `"got error" isn't in your message any more, so fix 1 can't be applied.`
- **Keyboard hints:** the hint row reads: Alt+Enter check · Alt+F use all · Ctrl+Alt+E show/hide · Esc hide
- **"Use fixed version (Alt+F)" stays.** It still replaces the whole message with the natural version.

## Data changes

- Each fix in `mistakes` and `suggestions` gains a `state`: `{ original, better, reason, state: 'can' | 'applied' | 'fixed' | 'no' }`.
- New action: `window.chrome.webview.postMessage({ type: 'apply', index })`, where `index` is the fix's number, starting from 1.
- After an apply, the host calls `render(state)` again with the updated states and status.

## Add these to the demo bar

1. **Mistakes found:** the same content as before, with fix 1 applied and fixes 2 and 3 showing Apply buttons.
2. **Overlapping fixes:** a longer fix has been applied, so a shorter one inside it shows "Already fixed":
   - "cause the claude design already ouput one proto previously" → "because Claude Design already output a prototype earlier": Applied
   - "ouput one proto" → "output a prototype": Already fixed
   - "what you changes" → "what you changed": Apply
   - Optional idea: "give me a prompt about what you changes in the recent link test" → "write me a prompt summarizing what you changed in the recent link test": Apply
3. **Words gone:** one fix in state `no`, with no button.

Show each state in light and dark, over a busy background. Deliver an updated version of the same single HTML file.
