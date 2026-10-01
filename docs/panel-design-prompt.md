Design the panel for **Glint**, a small always-on-top Windows 11 utility that helps a Singaporean software developer improve their written English while they chat with Claude in the Claude desktop app.

## What the panel does

- While typing a message in Claude, the user presses **Alt+Enter**. Their draft is checked, and the result appears in this panel within about 2 seconds. The panel must not take keyboard focus: the cursor stays in Claude's message box.
- The result has three parts:
  - real mistakes: the original words, the fix, and a one-line reason
  - optional style ideas
  - a natural rewrite of the whole message
- **Each mistake and optional idea has its own Apply button.** It is mouse only, with no keyboard shortcut.
  - Clicking it changes just that phrase in Claude's message box, and the item then shows "Applied".
  - Items whose words are no longer in the message have no Apply button.
- **Alt+F**, or a button, replaces the whole draft with the natural version.
- Pressing Enter in Claude sends the message and hides the panel.
- **Ctrl+Alt+E** shows or hides the panel from anywhere. At the bottom, the user can ask any English question, such as "is 'revert back' correct?", and the answer streams in.

The user is learning, so the panel should feel encouraging and calm, like a helpful colleague, never like an error report. Use red only for the struck-through original words.

## Hard requirements

1. **No Windows title bar.** Design our own title bar, about 36 px tall, containing:
   - the app glyph (a "G") and "Glint"
   - a small status indicator (idle / checking / result)
   - a pin button for always on top, on by default
   - a close button, which hides the panel; it keeps running in the tray

   The bar is the drag area.
2. **Frosted glass.** The whole panel sits on Windows 11 Acrylic: the OS blurs the desktop behind it. Design the tint and layering on top so text stays readable over any background, such as a busy wallpaper, a white web page or a dark code editor. Aim for WCAG AA contrast against the tint at its most see-through. Provide a solid fallback for when Windows transparency effects are turned off.
3. **Light and dark themes**, following the system setting.
4. **Windows 11 Fluent look:** 8 px rounded corners, a hairline border, and a soft shadow.

## Size and layout

- **Size:** default 480 × 490 px at 100% scale, resizable down to 420 × 330. It opens at the bottom-right of the screen.
- **Regions, top to bottom:**
  - title bar
  - result area, which scrolls
  - action row: status text, and a "Use fixed version" button with an Alt+F keycap
  - ask box: placeholder `Ask about English, e.g. is "revert back" correct?` and an Ask button
  - a quiet row of keyboard hints: Alt+Enter check · Alt+F use all · Ctrl+Alt+E show/hide · Esc hide
- **Selectable text:** text in the result area can be selected and copied.
- **Long results:** up to 5 mistakes and a 120-word natural version must still work. The result area scrolls while the action row and ask box stay in place.

## States to design (use this real copy)

1. **Welcome:** "Glint is ready". Body: "In Claude, press Alt+Enter to check your message. Alt+F puts the fixed version into Claude. Type below to ask about any English word or phrase."
2. **Checking:** "Checking your message…", with subtle progress (about 2 s).
3. **Mistakes found:** heading "2 things to fix". Show fix 1 as already applied, and fixes 2 and 3 with Apply buttons.
   - Mistake: "I have ran the both commands" → "I have run both commands". Reason: "Use 'have' + past participle 'run'; drop 'the'."
   - Mistake: "can help check" → "can you help me check". Reason: "Include the subject 'you' in questions."
   - Optional idea: "what to do next?" → "what should I do next?". Reason: "A bit more natural as a direct question."
   - Natural version: "I have run both commands. Can you help me check what I should do next?"
   - Status: "Fix it in Claude, or press Alt+F. Then Enter to send."
4. **Optional ideas only:** heading "No mistakes", then a section "Optional ideas to sound more natural".
5. **Looks good:** heading "Looks good", body "No mistakes found." Status: "Press Enter in Claude to send."
6. **Not English:** the draft was in Chinese. Heading "In English", then "Please help me figure out why this test keeps failing."
7. **Lookup (streaming):**
   - Question: `how to say "this one cannot work already" politely to my lead`.
   - Answer: plain text with 3 numbered options, each with a short note. It ends with: `Your question: "this one cannot work already" -> "This won't work anymore"`.
   - Status: "Answered in 3.9 s".
8. **Messages and errors:**
   - "Nothing to check": "Type your message in Claude first, then press Alt+Enter."
   - "The check failed": "the Claude CLI is not logged in. Run claude in a terminal and use /login."

## Build constraints (the design will be implemented as you deliver it)

- **One self-contained HTML file:** inline CSS and vanilla JS, with no frameworks, CDNs, web fonts or images, because it runs offline. It will be hosted in a frameless WebView2 window whose background is transparent over Windows 11 Acrylic.
  - Keep `html, body` transparent and draw the tint yourself. Don't use `backdrop-filter` to fake the window glass; the OS blurs the desktop.
  - Mark the title bar with `app-region: drag` and its buttons with `app-region: no-drag`.
  - Font: `"Segoe UI Variable Text", "Segoe UI", sans-serif`.
  - Respect `prefers-color-scheme`, `prefers-reduced-motion` and `prefers-reduced-transparency`.
- **One render function** that the host calls, `window.glint.render(state)`, with these shapes:

  ```js
  { view: 'welcome' }
  { view: 'checking' }
  { view: 'check', mistakes: [{ original, better, reason, state }], suggestions: [{ original, better, reason, state }], natural: '...', notEnglish: false }
  // state: 'can' (show Apply), 'applied' (show Applied), 'fixed' (show Already fixed: an overlapping fix
  // already changed these words) or 'no' (no button). Items are numbered 1, 2, 3, ...
  // across mistakes and then suggestions; that number is the index sent with 'apply'.
  { view: 'lookup', question: '...', answer: '...', streaming: true }
  { view: 'message', title: '...', body: '...' }
  // any state may also carry: status: '...', canUseFix: true | false
  ```

- **User actions** are sent with `window.chrome.webview.postMessage(...)`:
  - `{ type: 'apply', index }`
  - `{ type: 'useFix' }`
  - `{ type: 'ask', text }`
  - `{ type: 'pin', on }`
  - `{ type: 'close' }`
- **Demo bar:** include a small demo bar, shown only when the URL has `?demo`, that switches between all states and both themes so each one can be reviewed.

## Deliverables

1. Mockups of every state in light and dark, shown over a busy wallpaper and over a code editor so the glass effect is visible.
2. The HTML file described above.
