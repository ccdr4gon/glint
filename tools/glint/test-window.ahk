; End-to-end test of the Glint window, without touching the real Claude app.
; A "Fake Claude" window stands in for Claude's message box; Glint runs against it with the
; plugin's fake `claude` (no real model calls) and a throwaway data folder. The test presses
; Alt+Enter and Alt+F like a user would and checks the message box text after each step.
; (Applying single fixes is a click on an "Apply" link; the plugin's `apply` command behind it is
; covered by plugins/glint/tests.)
;
; WARNING: this takes keyboard focus and sends keys for about 10 seconds. Only run it while nobody
; is using the computer, and never add Alt+1 here: it's the user's screenshot hotkey.
;
; Run: AutoHotkey64.exe test-window.ahk   (results go to test-window.log next to this file)
; It replaces a running Glint window; start your normal one again afterwards.

#Requires AutoHotkey v2.0
#SingleInstance Off
SendLevel 1  ; so Glint's hotkeys react to the keys this test sends

logFile := A_ScriptDir "\test-window.log"
try FileDelete(logFile)
Log(text) => FileAppend(text "`n", logFile, "UTF-8")
failures := 0
Expect(name, actual, expected) {
    global failures
    ok := (actual == expected)
    failures += !ok
    Log((ok ? "PASS " : "FAIL ") name (ok ? "" : "`n  expected: " expected "`n  actual:   " actual))
}

repo := A_ScriptDir "\..\.."
home := A_Temp "\glint-window-test"
try DirDelete(home, true)
DirCreate(home)
EnvSet("GLINT_HOME", home)
EnvSet("GLINT_CLAUDE", repo "\plugins\glint\tests\fake-claude.mjs")
EnvSet("GLINT_NO_DAEMON", "1")

; The stand-in for Claude's message box.
fake := Gui("+AlwaysOnTop", "Fake Claude")
box := fake.Add("Edit", "w420 r4", "the build got error, what to do next?")
fake.Show("x40 y40")

windowPid := 0
Run(Format('"{1}" "{2}" --target "Fake Claude ahk_class AutoHotkeyGUI" --theme light', A_AhkPath, A_ScriptDir "\glint-window.ahk"), , , &windowPid)
Sleep(2500)

FocusBox() {
    WinActivate("Fake Claude ahk_class AutoHotkeyGUI")
    WinWaitActive("Fake Claude ahk_class AutoHotkeyGUI", , 2)
    box.Focus()
    Sleep(150)
}

; 1. Alt+Enter: check the draft. The text must not change.
FocusBox()
Send("!{Enter}")
Sleep(3000)
Expect("Alt+Enter leaves the draft alone", box.Value, "the build got error, what to do next?")

; 2. Alt+F: the whole natural version.
FocusBox()
Send("!f")
Sleep(1500)
Expect("Alt+F uses the natural version", box.Value, "Why does the API throw an error?")

Log(failures ? failures " FAILED" : "ALL PASSED")
if windowPid
    ProcessClose(windowPid)
ExitApp(failures ? 1 : 0)
