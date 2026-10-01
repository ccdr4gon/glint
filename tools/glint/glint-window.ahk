; Glint window: a small always-on-top helper for your English while you work in Claude.
;
;   Alt+Enter    In the Claude desktop app: check your draft. The suggestions appear here while the
;                cursor stays in Claude's message box. Enter and Shift+Enter work as before.
;   Apply        Click a fix's "Apply" link: just that phrase changes in Claude's message box.
;                Ctrl+Z in Claude undoes it. (No number shortcuts: Alt+1 is taken by a screenshot tool.)
;   Alt+F        Put the whole fixed (natural) version into Claude's message box. Then press Enter.
;   Ctrl+Alt+E   Anywhere: show or hide this window, e.g. to ask about an English word or phrase.
;   Esc          Hide this window.
;
; Checks and lookups go to Claude through the Glint plugin, and are saved to its journal
; so /glint:review can include them.
;
; Requires AutoHotkey v2 and Node.js. Run this file to start it. To start it with Windows, put a
; shortcut to it in the folder that opens with Win+R -> shell:startup.
; Optional: glint-window.ahk --theme light|dark  (default: follow the Windows app theme)
;           glint-window.ahk --hidden  (start in the background, e.g. from shell:startup; Ctrl+Alt+E shows it)
; For development: --show file.rtf previews content; --target "WinTitle" uses another window as Claude.

#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; ---------- settings ----------
SHOW_KEY := "^!e"                ; Ctrl+Alt+E: show or hide this window
HIDE_AFTER_SEND := true          ; hide a check result when you press Enter in Claude
KEEP_WARM := true                ; keep a Claude process ready so a check takes ~2 s (uses ~180 MB)
CLAUDE_WINDOW := ArgValue("--target", "ahk_exe claude.exe ahk_class Chrome_WidgetWin_1")  ; the Claude desktop app (tests point it elsewhere)
NODE := "node"
GLINT := A_ScriptDir "\..\..\plugins\glint\scripts\glint.mjs"
; Alt+Enter (check) and Alt+F (use fixed version) are set in the #HotIf blocks further down.

THEME := ArgValue("--theme", SystemTheme())
COLORS := (THEME = "dark")
    ? {bg: 0x202020, field: 0x2C2C2C, text: 0xF3F3F3, muted: 0xA8A8A8, line: 0x3A3A3A}
    : {bg: 0xF9F9F9, field: 0xFFFFFF, text: 0x1F1F1F, muted: 0x5F5F5F, line: 0xE3E3E3}

DATA_DIR := EnvGet("GLINT_HOME")
if (DATA_DIR = "")
    DATA_DIR := EnvGet("USERPROFILE") "\.claude\glint"
FEEDBACK_FILE := DATA_DIR "\window\feedback.txt"  ; gate mode, a held-back prompt: pop up
TIPS_FILE := DATA_DIR "\window\tips.txt"          ; gate mode, tips for a sent prompt: show only if open
NATURAL_FILE := DATA_DIR "\window\natural.txt"

job := ""                 ; the check or lookup running now, if any
fixText := ""             ; what Alt+F / "Use fixed version" puts into Claude
claudeHwnd := 0           ; the Claude window the draft came from
showingCheck := false     ; the window shows a check result (hidden again when you send)
lastFeedback := ReadText(FEEDBACK_FILE)  ; don't show feedback from before this window started
lastTips := ReadText(TIPS_FILE)

; Only one Glint window may listen for Alt+Enter: close the frosted-glass panel if it's running.
DetectHiddenWindows(true)
try WinClose("\glint-panel.ahk - AutoHotkey ahk_class AutoHotkey")
DetectHiddenWindows(false)

; ---------- window ----------
DllCall("LoadLibrary", "Str", "Msftedit.dll", "Ptr")  ; the rich edit control
g := Gui("+AlwaysOnTop +Resize -DPIScale +MinSize" S(420) "x" S(330), "Glint")
g.BackColor := Hex(COLORS.bg)
g.SetFont("s10 c" Hex(COLORS.text), "Segoe UI")
view := g.Add("Custom", "ClassRICHEDIT50W x0 y0 w10 h10 +0x200844 -E0x200")  ; multiline, read-only, vscroll, no border
status := g.Add("Text", "x0 y0 w10 h10 +0x200 c" Hex(COLORS.muted))         ; vertically centred
fixButton := g.Add("Button", "x0 y0 w10 h10 Disabled", "Use fixed version  (Alt+F)")
divider := g.Add("Text", "x0 y0 w10 h1 Background" Hex(COLORS.line))
question := g.Add("Edit", "x0 y0 w10 h10" (THEME = "dark" ? " Background" Hex(COLORS.field) : ""))  ; a custom light background hides the hint text
askButton := g.Add("Button", "x0 y0 w10 h10 Default", "Ask")
g.SetFont("s9 c" Hex(COLORS.muted))
hint := g.Add("Text", "x0 y0 w10 h10", "Alt+Enter check      Alt+F use all      Ctrl+Alt+E show / hide")

SendMessage(0x443, 0, ToBgr(COLORS.bg), view)  ; EM_SETBKGNDCOLOR
SendMessage(0x445, 0, 0x04000000, view)        ; EM_SETEVENTMASK: ENM_LINK, for the "Apply" links
view.OnNotify(0x070B, OnLink)                  ; EN_LINK
SendMessage(0x1501, 1, StrPtr('Ask about English, e.g. is "revert back" correct?'), question)  ; EM_SETCUEBANNER
if (THEME = "dark") {
    DllCall("dwmapi\DwmSetWindowAttribute", "Ptr", g.Hwnd, "Int", 20, "Int*", 1, "Int", 4)  ; dark title bar
    for ctrl in [view, fixButton, askButton]
        DllCall("uxtheme\SetWindowTheme", "Ptr", ctrl.Hwnd, "Str", "DarkMode_Explorer", "Ptr", 0)
    DllCall("uxtheme\SetWindowTheme", "Ptr", question.Hwnd, "Str", "DarkMode_CFD", "Ptr", 0)
}

askButton.OnEvent("Click", Ask)
fixButton.OnEvent("Click", (*) => UseFix())
g.OnEvent("Escape", (*) => g.Hide())
g.OnEvent("Close", (*) => g.Hide())
g.OnEvent("Size", (gui, minMax, width, height) => minMax = -1 ? "" : Layout(width, height))

A_IconTip := "Glint (Alt+Enter in Claude, Ctrl+Alt+E)"
Hotkey(SHOW_KEY, Toggle)
SetTimer(WatchFeedback, 700)
if KEEP_WARM {
    Warm()
    SetTimer(Warm, 10 * 60 * 1000)
}

; Start at the bottom-right of the screen.
g.Show("w" S(480) " h" S(490) " Hide")
MonitorGetWorkArea(MonitorGetPrimary(), , , &right, &bottom)
g.GetPos(, , &winW, &winH)  ; Gui.GetPos/Move work while the window is still hidden
g.Move(right - winW - S(24), bottom - winH - S(24))
showFile := ArgValue("--show", "")  ; for previews: show a .rtf file instead of the welcome text
SetRtf(showFile != "" ? ReadText(showFile) : MessageRtf("Glint is ready",
    "In Claude, press Alt+Enter to check your message.`nAlt+F puts the fixed version into Claude.`nType below to ask about any English word or phrase."))
if !HasArg("--hidden")
    ShowWindow()

#HotIf WinActive(CLAUDE_WINDOW)
!Enter::CheckDraft()
~Enter::AfterSend()
#HotIf (WinActive(CLAUDE_WINDOW) || WinActive("ahk_id " g.Hwnd)) && fixText != ""
!f::UseFix()
#HotIf

; ---------- layout and look ----------

S(n) => Round(n * A_ScreenDPI / 96)  ; DIPs to pixels
Hex(rgb) => Format("{:06X}", rgb)
ToBgr(rgb) => ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)

Layout(width, height) {
    m := S(16), w := width - 2 * m
    hintY := height - S(12) - S(18)
    inputY := hintY - S(10) - S(28)
    dividerY := inputY - S(12) - S(1)
    rowY := dividerY - S(12) - S(30)
    view.Move(m, S(14), w, rowY - S(10) - S(14))
    status.Move(m, rowY, w - S(210), S(30))
    fixButton.Move(width - m - S(200), rowY, S(200), S(30))
    divider.Move(m, dividerY, w, S(1))
    question.Move(m, inputY, w - S(80), S(28))
    askButton.Move(width - m - S(72), inputY, S(72), S(28))
    hint.Move(m, hintY, w, S(18))
}

SystemTheme() {
    try return RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme") ? "light" : "dark"
    return "light"
}

HasArg(name) {
    for arg in A_Args {
        if (arg = name)
            return true
    }
    return false
}

ArgValue(name, default) {
    for i, arg in A_Args {
        if (arg = name && i < A_Args.Length)
            return A_Args[i + 1]
    }
    return default
}

Toggle(*) {
    if WinActive("ahk_id " g.Hwnd)
        g.Hide()
    else
        ShowWindow()
}

ShowWindow() {
    g.Show()
    ScrollToTop()
    question.Focus()
    PostMessage(0xB1, 0, -1, question)  ; EM_SETSEL: select the old question so typing replaces it
}

IsShown() {
    return DllCall("IsWindowVisible", "Ptr", g.Hwnd)
}

SetStatus(text) {
    status.Value := text
}

ReadText(path) {
    try return FileRead(path, "UTF-8")
    return ""
}

Warm() {
    try Run(Format('"{1}" "{2}" warm', NODE, GLINT), A_Temp, "Hide")
}

; ---------- rich text ----------

; Show RTF (plain ASCII, from the plugin or MessageRtf) in the view.
SetRtf(rtf) {
    if (rtf = "")
        return
    settext := Buffer(8, 0)  ; SETTEXTEX: flags = ST_DEFAULT, codepage = CP_ACP
    buf := Buffer(StrPut(rtf, "CP0"))
    StrPut(rtf, buf, "CP0")
    SendMessage(0x461, settext.Ptr, buf.Ptr, view)  ; EM_SETTEXTEX
    ScrollToTop()
}

ScrollToTop() {
    SendMessage(0xB1, 0, 0, view)              ; EM_SETSEL: cursor to the start
    origin := Buffer(8, 0)                     ; POINT {0, 0}
    SendMessage(0x4DE, 0, origin.Ptr, view)    ; EM_SETSCROLLPOS: show the top
}

MessageRtf(title, body := "") {
    rtf := "{\rtf1\ansi\deff0\uc1{\fonttbl{\f0\fnil Segoe UI;}{\f1\fnil Segoe UI Semibold;}}"
        . "{\colortbl;" RtfColor(COLORS.text) RtfColor(COLORS.muted) "}"
        . "\pard\sa80\sl276\slmult1\f1\fs26\cf1 " RtfText(title) "\par"
    if (body != "")
        rtf .= "\pard\sb40\sl276\slmult1\f0\fs20\cf2 " RtfText(body) "\par"
    return rtf "}"
}

RtfColor(rgb) => Format("\red{}\green{}\blue{};", (rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF)

RtfText(text) {
    out := ""
    Loop Parse, text {
        ch := A_LoopField, code := Ord(ch)
        if (ch = "\" || ch = "{" || ch = "}")
            out .= "\" ch
        else if (ch = "`n")
            out .= "\line "
        else if (ch = "`r")
            continue
        else if (code < 128)
            out .= ch
        else
            out .= "\u" (code > 32767 ? code - 65536 : code) "?"
    }
    return out
}

; ---------- Alt+Enter, Enter, Alt+F in Claude ----------

CheckDraft() {
    global claudeHwnd
    claudeHwnd := WinActive(CLAUDE_WINDOW)
    KeyWait("Alt", "L T1")  ; Alt must be up (logically: also covers keys sent by software) before Ctrl+A/C
    StartJob("check", CopyDraft())
}

; Copy the message box's text without losing what was on the clipboard.
CopyDraft() {
    saved := ClipboardAll()
    A_Clipboard := ""
    Send("^a^c")
    text := ClipWait(1) ? A_Clipboard : ""
    Send("^{End}")  ; drop the selection and put the cursor back at the end
    A_Clipboard := saved
    return text
}

AfterSend() {
    global showingCheck
    if (!HIDE_AFTER_SEND || !showingCheck)
        return
    showingCheck := false
    if (IsObject(job) && job.kind = "check")
        StopJob()
    if IsShown()
        g.Hide()
}

UseFix() {
    if (fixText = "") {
        SetStatus("Nothing to use yet. Press Alt+Enter in Claude first.")
        return
    }
    if !FocusClaude()
        return
    PasteIntoClaude(fixText)
    SetStatus("Fixed version is in Claude. Press Enter to send.")
}

; Fix N only (its "Apply" link): re-read the draft (keeping any edits made since the check), change
; that one phrase, and put the message back. The plugin's `apply` command does the matching.
ApplyFix(n) {
    if !FocusClaude()
        return
    id := A_TickCount
    inFile := A_Temp "\glint-" id ".draft.txt"
    outFile := A_Temp "\glint-" id ".fixed.txt"
    FileAppend(CopyDraft(), inFile, "UTF-8-RAW")
    RunWait(Format('"{1}" "{2}" apply --index {3} --in "{4}" --out "{5}" --theme {6}', NODE, GLINT, n, inFile, outFile, THEME), A_Temp, "Hide")
    result := StrSplit(ReadText(outFile ".status"), "`n", "`r")
    if (result.Length >= 1 && result[1] = "ok")
        PasteIntoClaude(ReadText(outFile))
    SetRtf(ReadText(outFile ".rtf"))
    SetStatus(result.Length >= 2 ? result[2] : "Something went wrong applying that fix.")
    for path in [inFile, outFile, outFile ".rtf", outFile ".status"] {
        try FileDelete(path)
    }
}

; Bring the Claude window (the one the draft came from) to the front. Returns false if it can't.
FocusClaude() {
    global claudeHwnd
    hwnd := (claudeHwnd && WinExist("ahk_id " claudeHwnd)) ? claudeHwnd : WinExist(CLAUDE_WINDOW)
    if !hwnd {
        SetStatus("Open Claude first.")
        return false
    }
    KeyWait("Alt", "L T1")  ; Alt must be up (logically: also covers keys sent by software) first
    if !WinActive("ahk_id " hwnd) {
        WinActivate("ahk_id " hwnd)
        if !WinWaitActive("ahk_id " hwnd, , 1) {
            SetStatus("Couldn't switch to Claude.")
            return false
        }
    }
    claudeHwnd := hwnd
    return true
}

; Replace everything in Claude's message box with `text`, keeping the clipboard as it was.
PasteIntoClaude(text) {
    saved := ClipboardAll()
    A_Clipboard := text
    if ClipWait(1) {
        Send("^a^v")
        Sleep(250)  ; let the paste finish before the clipboard is restored
    }
    A_Clipboard := saved
}

; A click on an "Apply" link: its hidden target is "fix:N".
OnLink(ctrl, lParam) {
    if (NumGet(lParam, A_PtrSize * 3, "UInt") != 0x201)  ; act on WM_LBUTTONDOWN only
        return 0
    chrg := (A_PtrSize = 8) ? 44 : 24  ; ENLINK is packed to 4 bytes (richedit.h), even on 64-bit
    cpMin := NumGet(lParam, chrg, "Int")
    cpMax := NumGet(lParam, chrg + 4, "Int")
    if (cpMax <= cpMin)
        return 0
    text := Buffer((cpMax - cpMin + 2) * 2, 0)
    range := Buffer(8 + A_PtrSize, 0)  ; TEXTRANGEW { CHARRANGE chrg; LPWSTR lpstrText }
    NumPut("Int", cpMin, "Int", cpMax, range, 0)
    NumPut("Ptr", text.Ptr, range, 8)
    SendMessage(0x44B, 0, range.Ptr, ctrl)  ; EM_GETTEXTRANGE
    if RegExMatch(StrGet(text), "fix:(\d+)", &m)
        SetTimer(ApplyFix.Bind(Integer(m[1])), -1)  ; run after this notification returns
    return 1  ; handled: no caret, no selection
}

; ---------- gate mode: held-back prompts and tips ----------

WatchFeedback() {
    global lastFeedback, lastTips, fixText, showingCheck
    tips := ReadText(TIPS_FILE)
    if (tips != "" && tips != lastTips) {
        lastTips := tips
        if (IsShown() && !IsObject(job)) {  ; never interrupt a check or lookup for a tip
            SetRtf(MessageRtf("English tip", tips))
            SetStatus("Your prompt was sent.")
        }
    }
    text := ReadText(FEEDBACK_FILE)
    if (text = "" || text = lastFeedback)
        return
    lastFeedback := text
    StopJob()
    SetRtf(MessageRtf("Prompt held back", text))
    fixText := Trim(ReadText(NATURAL_FILE))
    fixButton.Enabled := (fixText != "")
    SetStatus("Fix it, or press Alt+F. Then send again.")
    showingCheck := true
    if !IsShown()
        g.Show("NoActivate")  ; keep the focus in Claude's message box
}

; ---------- running checks and lookups ----------

Ask(*) {
    text := Trim(question.Value)
    if (text != "")
        StartJob("ask", text)
}

StartJob(kind, text) {
    global job, fixText, showingCheck
    StopJob()
    fixText := ""
    fixButton.Enabled := false
    showingCheck := (kind = "check")
    id := A_TickCount
    job := {kind: kind, in: A_Temp "\glint-" id ".in.txt", out: A_Temp "\glint-" id ".out.txt", pid: 0, shown: "", started: A_TickCount}
    FileAppend(text, job.in, "UTF-8-RAW")
    SetRtf(MessageRtf((kind = "check") ? "Checking your message..." : "Looking it up...", (kind = "ask") ? text : ""))
    SetStatus("")
    if (kind = "check" && !IsShown())
        g.Show("NoActivate")  ; keep the focus in Claude's message box
    Run(Format('"{1}" "{2}" {3} --in "{4}" --out "{5}" --theme {6}', NODE, GLINT, kind, job.in, job.out, THEME), A_Temp, "Hide", &pid)
    job.pid := pid
    SetTimer(Poll, 150)
}

Poll() {
    global job, fixText
    if !IsObject(job) {
        SetTimer(Poll, 0)
        return
    }
    done := FileExist(job.out ".done")
    rtf := ReadText(job.out ".rtf")
    if (rtf != "" && rtf != job.shown) {
        job.shown := rtf
        SetRtf(rtf)
    }
    if done {
        seconds := Format("{:.1f}", (A_TickCount - job.started) / 1000)
        if (job.kind = "check") {
            fixText := Trim(ReadText(job.out ".natural"))
            fixButton.Enabled := (fixText != "")
            SetStatus(fixText != "" ? "Fix it in Claude, or press Alt+F. Then Enter to send." : "Press Enter in Claude to send.")
        } else {
            SetStatus("Answered in " seconds " s")
        }
        StopJob()
    } else if !ProcessExist(job.pid) {
        Sleep(300)  ; the .done marker may land just after the process exits
        if !FileExist(job.out ".done") {
            if (job.shown = "")
                SetRtf(MessageRtf("No answer came back", "Check that Node.js and the Claude CLI work in a terminal."))
            StopJob()
        }
    }
}

StopJob() {
    global job
    SetTimer(Poll, 0)
    if !IsObject(job)
        return
    if (job.pid && ProcessExist(job.pid))
        ProcessClose(job.pid)
    for path in [job.in, job.out, job.out ".rtf", job.out ".natural", job.out ".done"] {
        try FileDelete(path)
    }
    job := ""
}
