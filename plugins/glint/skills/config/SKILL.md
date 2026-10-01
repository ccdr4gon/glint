---
name: config
description: Turn Glint on or off, or change how it checks English. Settings: mode hotkey/gate/inline, model, level light/normal/strict, maxItems, minWords, copyOnBlock on/off, position start/end, rewrite auto/always/never, journal on/off. Use when the user asks to pause, resume or adjust the English check.
argument-hint: "[on | off | hotkey | gate | inline | light | normal | strict | <setting> <value> | reset]"
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/glint.mjs" config "$ARGUMENTS"`

Show the user the output above as it is. If it's an error, briefly list the valid options. Changes apply from their next prompt. Don't do anything else.
