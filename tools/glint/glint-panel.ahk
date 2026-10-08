; Glint panel: the frosted-glass Glint window. It shows the Claude Design panel
; (panel\glint-panel.html, from design\english-coach-panel-files, made when Glint was called
; English Coach) in a frameless WebView2 window with Windows 11 Acrylic behind it.
;
;   Alt+Enter    In the Claude desktop app: check your draft. The result appears here while the
;                cursor stays in Claude's message box. Enter and Shift+Enter work as before.
;   Apply        Click a fix's Apply button: just that phrase changes in Claude. Ctrl+Z undoes it.
;   Alt+F        Put the whole fixed version into Claude's message box. Then press Enter.
;   Ctrl+Alt+E   Anywhere: show or hide the panel, e.g. to ask about an English word or phrase.
;   Esc          Hide the panel.
;
; Requires AutoHotkey v2, Node.js and the WebView2 runtime (built into Windows 11). Uses
; lib\WebView2 from thqby/ahk2_lib (MIT). glint-window.ahk is the plain fallback; starting one
; closes the other, so only one listens for Alt+Enter.
;
; Options: --hidden (start in the background, e.g. from shell:startup), --theme light|dark.
; For development: --state file.json renders that state at start; --target "WinTitle" uses another
; window as Claude; --selftest sends each kind of page message through WebView2 and logs what the
; panel did to panel.log (use it with a --target that matches no window, so nothing touches Claude).

#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent
#Include lib\WebView2\WebView2.ahk
#Include glint-clipboard.ahk
#Include glint-uia.ahk

; ---------- settings ----------
SHOW_KEY := "^!e"                ; Ctrl+Alt+E: show or hide the panel
HIDE_AFTER_SEND := true          ; hide a check result when you press Enter in Claude
KEEP_WARM := true                ; keep a Claude process ready so a check takes ~2 s (uses ~180 MB)
EXTRA_TRANSPARENCY := 0.10       ; make the glass more see-through than the design: 0.10 = 10% more, 0 = as designed
CLAUDE_WINDOW := ArgValue("--target", "ahk_exe claude.exe ahk_class Chrome_WidgetWin_1")  ; the Claude desktop app
NODE := "node"
GLINT := A_ScriptDir "\..\..\plugins\glint\scripts\glint.mjs"
; Alt+Enter (check) and Alt+F (use fixed version) are set in the #HotIf blocks further down.

THEME := ArgValue("--theme", SystemTheme())
GLASS := TransparencyEffectsOn()  ; Windows "Transparency effects"; off = the page's solid fallback
DATA_DIR := EnvGet("GLINT_HOME")
if (DATA_DIR = "")
    DATA_DIR := EnvGet("USERPROFILE") "\.claude\glint"
FEEDBACK_FILE := DATA_DIR "\window\feedback.txt"  ; gate mode, a held-back prompt: pop up
TIPS_FILE := DATA_DIR "\window\tips.txt"          ; gate mode, tips for a sent prompt: show only if open
NATURAL_FILE := DATA_DIR "\window\natural.txt"

; Added to the page by the host (the design's HTML stays as designed): the window has no frame, so
; the page's outer 6 px are its resize edges, and a press on the title bar (not its buttons) moves
; the window. It posts "resize:<hit-test code>" or "drag", and the host hands those to Windows.
; The title bar is a drag area (app-region: drag), where the page may get no mouse events at all,
; so its edges are cut out of it with invisible strips: the top-left corner resizes too.
FRAME_JS := "
(
(function () {
  var EDGE = 6, TITLE_BAR = 36;
  var CURSOR = { 10: 'ew-resize', 11: 'ew-resize', 12: 'ns-resize', 15: 'ns-resize',
                 13: 'nwse-resize', 17: 'nwse-resize', 14: 'nesw-resize', 16: 'nesw-resize' };
  function edge(e) {
    var w = window.innerWidth, h = window.innerHeight;
    var l = e.clientX < EDGE, r = e.clientX >= w - EDGE, t = e.clientY < EDGE, b = e.clientY >= h - EDGE;
    return t && l ? 13 : t && r ? 14 : b && l ? 16 : b && r ? 17 : l ? 10 : r ? 11 : t ? 12 : b ? 15 : 0;
  }
  document.addEventListener('DOMContentLoaded', function () {
    var style = document.createElement('style');
    style.textContent = Object.keys(CURSOR).map(function (k) {
      return 'html[data-edge="' + k + '"], html[data-edge="' + k + '"] * { cursor: ' + CURSOR[k] + ' !important; }';
    }).join('\n') + '\n.host-edge { position: fixed; z-index: 2147483647; app-region: no-drag; -webkit-app-region: no-drag; }';
    document.head.appendChild(style);
    ['top: 0; left: 0; right: 0; height: ' + EDGE + 'px',
     'top: 0; left: 0; width: ' + EDGE + 'px; height: ' + TITLE_BAR + 'px',
     'top: 0; right: 0; width: ' + EDGE + 'px; height: ' + TITLE_BAR + 'px'].forEach(function (css) {
      var strip = document.createElement('div');
      strip.className = 'host-edge';
      strip.style.cssText = css;
      document.body.appendChild(strip);
    });
  });
  document.addEventListener('mousemove', function (e) {
    var k = edge(e);
    if (k) document.documentElement.setAttribute('data-edge', k);
    else document.documentElement.removeAttribute('data-edge');
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var k = edge(e);
    if (k) {
      e.preventDefault();
      e.stopPropagation();
      window.chrome.webview.postMessage('resize:' + k);
    } else if (e.target.closest && e.target.closest('.titlebar') && !e.target.closest('button')) {
      window.chrome.webview.postMessage('drag');
    }
  }, true);
})();
)"

job := ""                       ; the check or lookup running now, if any
fixText := ""                   ; what Alt+F / "Use fixed version" puts into Claude
fixHtml := ""                   ; the same as HTML, which keeps lists and /command chips (a Buffer, or "")
claudeHwnd := 0                 ; the Claude window the draft came from
showingCheck := false           ; the panel shows a check result (hidden again when you send)
lastState := '{"view":"welcome"}'  ; the page's current state, as JSON
pageReady := false
pinned := false                 ; always on top (the pin in the title bar): off at first
SELFTEST := HasArg("--selftest")
lastFeedback := ReadText(FEEDBACK_FILE)  ; don't show feedback from before the panel started
lastTips := ReadText(TIPS_FILE)

CloseOtherWindow("glint-window.ahk")

; ---------- window ----------
; No minimize box: a click on its taskbar button or Win+M can't minimize it out of sight.
g := Gui("-Caption +Resize -MaximizeBox -MinimizeBox -DPIScale +MinSize" S(420) "x" S(330), "Glint")
g.BackColor := "000000"  ; black under a frame extended over the whole window = see-through to the Acrylic
OnMessage(0x83, NcCalcSize)  ; WM_NCCALCSIZE
OnMessage(0x84, NcHitTest)   ; WM_NCHITTEST
OnMessage(0x86, NcActivate)  ; WM_NCACTIVATE
g.OnEvent("Size", (gui, minMax, *) => (minMax != -1 && IsSet(wvc)) ? wvc.Fill() : "")
g.OnEvent("Close", (*) => g.Hide())
MonitorGetWorkArea(MonitorGetPrimary(), , , &right, &bottom)
g.Move(right - S(480) - S(24), bottom - S(490) - S(24), S(480), S(490))  ; the whole window: it has no frame
SetFrame()

try {
    wvc := WebView2.CreateControllerAsync(g.Hwnd, 0, DATA_DIR "\webview2").await()
} catch as err {
    MsgBox("The Glint panel needs the Microsoft Edge WebView2 runtime.`n`n" err.Message
        "`n`nUse glint-window.ahk instead, or install the runtime from Microsoft.", "Glint", "Icon!")
    ExitApp()
}
wvc.IsVisible := true  ; created while the window was hidden, so it starts out invisible
Log("WebView2 ready, bounds=" BoundsText())
wvc.DefaultBackgroundColor := 0  ; transparent: the page draws its own tint over the Acrylic
wv := wvc.CoreWebView2
settings := wv.Settings
settings.AreDefaultContextMenusEnabled := false
settings.AreDevToolsEnabled := false
settings.IsStatusBarEnabled := false
settings.IsZoomControlEnabled := false
settings.AreBrowserAcceleratorKeysEnabled := false  ; no reload / find / print; copy and paste still work
try settings.IsNonClientRegionSupportEnabled := true  ; the page's title bar (app-region: drag); needs a 2024+ runtime
wv.SetVirtualHostNameToFolderMapping("glint.local", A_ScriptDir "\panel", 1)  ; 1 = allow
wv.AddScriptToExecuteOnDocumentCreated(FRAME_JS)  ; waits until registered, so it's in place before the page loads
if EXTRA_TRANSPARENCY
    wv.AddScriptToExecuteOnDocumentCreated(GlassJs(EXTRA_TRANSPARENCY))
wv.add_WebMessageReceived(OnPageMessage)
wv.add_NavigationCompleted(OnPageLoaded)
wv.Navigate("https://glint.local/glint-panel.html")

A_IconTip := "Glint (Alt+Enter in Claude, Ctrl+Alt+E)"
Hotkey(SHOW_KEY, Toggle)
SetTimer(WatchFeedback, 700)
if KEEP_WARM {
    Warm()
    SetTimer(Warm, 10 * 60 * 1000)
}
startState := ArgValue("--state", "")  ; for previews
if (startState != "")
    Render(ReadText(startState))
if !HasArg("--hidden")
    ShowPanel()

#HotIf WinActive(CLAUDE_WINDOW)
!Enter::CheckDraft()
~Enter::AfterSend()
#HotIf (WinActive(CLAUDE_WINDOW) || WinActive("ahk_id " g.Hwnd)) && fixText != ""
!f::UseFix()
#HotIf

; ---------- frame and look ----------

S(n) => Round(n * A_ScreenDPI / 96)  ; DIPs to pixels

SetFrame() {
    hwnd := g.Hwnd
    margins := Buffer(16, 0xFF)  ; MARGINS { -1, -1, -1, -1 }: the frame covers the whole window
    DllCall("dwmapi\DwmExtendFrameIntoClientArea", "Ptr", hwnd, "Ptr", margins)
    DllCall("dwmapi\DwmSetWindowAttribute", "Ptr", hwnd, "Int", 20, "Int*", THEME = "dark", "Int", 4)  ; DWMWA_USE_IMMERSIVE_DARK_MODE
    DllCall("dwmapi\DwmSetWindowAttribute", "Ptr", hwnd, "Int", 33, "Int*", 2, "Int", 4)               ; DWMWA_WINDOW_CORNER_PREFERENCE: round
    if GLASS
        DllCall("dwmapi\DwmSetWindowAttribute", "Ptr", hwnd, "Int", 38, "Int*", 3, "Int", 4)           ; DWMWA_SYSTEMBACKDROP_TYPE: Acrylic
    DllCall("SetWindowPos", "Ptr", hwnd, "Ptr", 0, "Int", 0, "Int", 0, "Int", 0, "Int", 0, "UInt", 0x37)  ; SWP_FRAMECHANGED | no move/size/z-order/activation
}

; EXTRA_TRANSPARENCY: lowers the opacity of the page's glass tint (82% in the design's light mode,
; 84% in dark mode). Only in glass mode: the solid fallback stays solid. A browser without relative
; colours keeps the design's tint.
GlassJs(amount) {
    css := '@supports (color: rgb(from red r g b)) { :root[data-glass="on"] #panel {'
        . ' background: rgb(from var(--tint-base) r g b / calc(alpha - ' Format("{:.2f}", amount) ')); } }'
    return "document.addEventListener('DOMContentLoaded', function () { var s = document.createElement('style');"
        . " s.textContent = " JsonString(css) "; document.head.appendChild(s); });"
}

; No window frame at all: the page covers the whole window, so no (white) frame can show. Windows
; still rounds the corners and draws the shadow. Moving and resizing are handled from the page
; (FRAME_JS), plus NcHitTest below for when WebView2 hands a title-bar press to the window.
NcCalcSize(wParam, lParam, msg, hwnd) {
    if (IsSet(g) && hwnd = g.Hwnd && wParam)
        return 0
}

; Windows draws the Acrylic only behind a window whose frame looks active, and the panel is rarely
; the active window (it leaves the focus in Claude). So its frame always looks active: ShowPanel
; sends this message too. Windows' default handling also paints its standard frame (about 10 px
; wide) under the see-through page, a white strip, so it runs with WS_VISIBLE briefly cleared,
; which stops the painting (the same trick Chromium uses).
NcActivate(wParam, lParam, msg, hwnd) {
    if (!IsSet(g) || hwnd != g.Hwnd)
        return
    style := DllCall("GetWindowLongPtr", "Ptr", hwnd, "Int", -16, "Ptr")              ; GWL_STYLE
    DllCall("SetWindowLongPtr", "Ptr", hwnd, "Int", -16, "Ptr", style & ~0x10000000)  ; WS_VISIBLE off
    DllCall("DefWindowProc", "Ptr", hwnd, "UInt", msg, "Ptr", 1, "Ptr", lParam)       ; 1: active
    DllCall("SetWindowLongPtr", "Ptr", hwnd, "Int", -16, "Ptr", style)
    return 1  ; TRUE: let a deactivation happen
}

NcHitTest(wParam, lParam, msg, hwnd) {
    if (!IsSet(g) || hwnd != g.Hwnd)
        return
    x := (lParam & 0xFFFF) - ((lParam & 0x8000) ? 0x10000 : 0)
    y := ((lParam >> 16) & 0xFFFF) - ((lParam & 0x80000000) ? 0x10000 : 0)
    WinGetPos(&winX, &winY, &winW, , "ahk_id " hwnd)
    if (y - winY < S(36) && x - winX < winW - S(80))  ; the title bar, left of its pin and close buttons
        return 2  ; HTCAPTION
}

BoundsText() {
    b := wvc.Bounds
    return NumGet(b, 0, "Int") "," NumGet(b, 4, "Int") "-" NumGet(b, 8, "Int") "," NumGet(b, 12, "Int") " visible=" wvc.IsVisible
}

SystemTheme() {
    try return RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme") ? "light" : "dark"
    return "light"
}

TransparencyEffectsOn() {
    try return RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "EnableTransparency") != 0
    return true
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

; Only one Glint window may listen for Alt+Enter: close the other kind if it's running.
CloseOtherWindow(scriptName) {
    DetectHiddenWindows(true)
    SetTitleMatchMode(2)
    try WinClose("\" scriptName " - AutoHotkey ahk_class AutoHotkey")
    DetectHiddenWindows(false)
}

ReadText(path) {
    try return FileRead(path, "UTF-8")
    return ""
}

; On screen: a minimized panel (e.g. by Show desktop) still counts as "visible" to Windows, but not here.
IsShown() {
    return DllCall("IsWindowVisible", "Ptr", g.Hwnd) && !DllCall("IsIconic", "Ptr", g.Hwnd)
}

; Show the panel at its current size. Not with g.Show(): that adds room for a window frame (20 px
; each way) every time, not knowing NcCalcSize removed the frame.
ShowPanel(activate := false) {
    if DllCall("IsIconic", "Ptr", g.Hwnd)
        DllCall("ShowWindow", "Ptr", g.Hwnd, "Int", 4)  ; SW_SHOWNOACTIVATE brings a minimized panel back
    ; Shown in front of Claude without taking the focus, and on top again if pinned (Show desktop can
    ; take it off the top). (Not ShowWindow: its first call in a program started from Explorer can
    ; activate the window anyway.) HWND_TOP doesn't reliably lift a window above the active one (Claude)
    ; from another app, so an unpinned panel goes on top for a moment and then off again: that leaves
    ; it at the top of the normal windows, in front of Claude, free to go behind other windows later.
    DllCall("SetWindowPos", "Ptr", g.Hwnd, "Ptr", -1, "Int", 0, "Int", 0, "Int", 0, "Int", 0
        , "UInt", 0x53)  ; HWND_TOPMOST; SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOMOVE
    if !pinned
        DllCall("SetWindowPos", "Ptr", g.Hwnd, "Ptr", -2, "Int", 0, "Int", 0, "Int", 0, "Int", 0
            , "UInt", 0x13)  ; HWND_NOTOPMOST; SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOMOVE
    DllCall("SendMessage", "Ptr", g.Hwnd, "UInt", 0x86, "Ptr", 1, "Ptr", 0)  ; WM_NCACTIVATE: look active, for the Acrylic
    if activate
        WinActivate("ahk_id " g.Hwnd)
}

Toggle(*) {
    if WinActive("ahk_id " g.Hwnd) {
        g.Hide()
        return
    }
    ShowPanel(true)
    wvc.MoveFocus(0)  ; COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC
    Js("document.getElementById('askInput').focus()")
}

Warm() {
    try Run(Format('"{1}" "{2}" warm', NODE, GLINT), A_Temp, "Hide")
}

; ---------- talking to the page ----------

Js(code) {
    if pageReady
        wv.ExecuteScriptAsync(code)
}

; Show a state (JSON text in the shape window.glint.render takes), optionally with a status line.
Render(state, status := "") {
    global lastState := state
    Js(status = "" ? "window.glint.render(" state ")"
        : "window.glint.render(Object.assign(" state ", {status: " JsonString(status) "}))")
}

SetStatus(text) {
    if SELFTEST
        Log("status: " text)
    Render(lastState, text)
}

MessageState(title, body := "") => '{"view":"message","title":' JsonString(title) ',"body":' JsonString(body) '}'

; Startup problems (and --selftest results) go to panel.log in the data folder.
Log(text) {
    path := DATA_DIR "\panel.log"
    try {
        if (FileExist(path) && FileGetSize(path) > 100000)
            FileDelete(path)
        FileAppend(FormatTime(, "HH:mm:ss") " " text "`n", path, "UTF-8")
    }
}

OnPageLoaded(sender, args) {
    Log("page loaded: success=" args.IsSuccess " error=" args.WebErrorStatus " bounds=" BoundsText())
    global pageReady := true
    Js("window.glint.setTheme(" JsonString(THEME) "); window.glint.setGlass(" (GLASS ? "true" : "false") ")")
    Js("window.glint.render(Object.assign(" lastState ", {pinned: " (pinned ? "true" : "false") "}))")  ; the page's pin starts on
    if SELFTEST
        SetTimer(RunSelfTest, -500)
}

; --selftest: each kind of message, sent by the page itself through the real WebView2 path.
RunSelfTest() {
    post(message) => Js("window.chrome.webview.postMessage(" message ")")
    onTop() => (WinGetExStyle("ahk_id " g.Hwnd) & 0x8) ? 1 : 0  ; WS_EX_TOPMOST
    Log("selftest: start, on top = " onTop())
    post("{type: 'pin', on: true}")
    Sleep(600)
    Log("selftest: after pin on, on top = " onTop())
    post("{type: 'pin', on: false}")
    Sleep(600)
    Log("selftest: after pin off, on top = " onTop())
    ; quotes, a new line and a Chinese character, to exercise the JSON decoding
    post("{type: 'ask', text: ['is ', 'revert back', ' correct?'].join(String.fromCharCode(34)) + String.fromCharCode(10, 0x5e2e)}")
    Sleep(4000)
    Log("selftest: after ask, state = " SubStr(lastState, 1, 140))
    post("{type: 'apply', index: 2}")
    Sleep(1500)
    post("{type: 'close'}")
    Sleep(800)
    Log("selftest: after close, visible = " IsShown())
    Log("selftest: done")
}

; Messages from the page: { type: 'apply', index } / 'useFix' / { type: 'ask', text } /
; { type: 'pin', on } / 'close', plus "drag" from the title bar. They run after this event returns.
OnPageMessage(sender, args) {
    json := args.WebMessageAsJson
    if SELFTEST
        Log("message: " json)
    if (json = '"drag"') {
        DllCall("ReleaseCapture")
        PostMessage(0xA1, 2, 0, , "ahk_id " g.Hwnd)  ; WM_NCLBUTTONDOWN on the caption: Windows moves the window
        return
    }
    if RegExMatch(json, '^"resize:(1[0-7])"$', &edge) {
        DllCall("ReleaseCapture")
        PostMessage(0xA1, Integer(edge[1]), 0, , "ahk_id " g.Hwnd)  ; WM_NCLBUTTONDOWN on that edge: Windows resizes
        return
    }
    if !RegExMatch(json, '"type"\s*:\s*"(\w+)"', &type)
        return
    switch type[1], true {
        case "apply":
            if RegExMatch(json, '"index"\s*:\s*(\d+)', &m)
                SetTimer(ApplyFix.Bind(Integer(m[1])), -1)
        case "useFix":
            SetTimer(UseFix, -1)
        case "ask":
            if RegExMatch(json, '"text"\s*:\s*"((?:[^"\\]|\\.)*)"', &m) {
                text := JsonUnescape(m[1])
                if SELFTEST
                    Log("ask text: " text)
                SetTimer(StartJob.Bind("ask", text), -1)
            }
        case "pin":
            global pinned := RegExMatch(json, '"on"\s*:\s*true') ? true : false
            WinSetAlwaysOnTop(pinned ? 1 : 0, "ahk_id " g.Hwnd)
        case "close":
            g.Hide()
    }
}

JsonString(text) {
    text := StrReplace(StrReplace(text, "\", "\\"), '"', '\"')
    text := StrReplace(StrReplace(StrReplace(text, "`r", ""), "`n", "\n"), "`t", "\t")
    return '"' text '"'
}

JsonUnescape(text) {
    out := "", i := 1, n := StrLen(text)
    while (i <= n) {
        ch := SubStr(text, i, 1)
        if (ch != "\") {
            out .= ch, i += 1
            continue
        }
        esc := SubStr(text, i + 1, 1)
        switch esc, true {
            case "n": out .= "`n"
            case "t": out .= "`t"
            case "r": out .= "`r"
            case "b": out .= Chr(8)
            case "f": out .= Chr(12)
            case "u":
                out .= Chr(Integer("0x" SubStr(text, i + 2, 4)))
                i += 4
            default: out .= esc  ; \" \\ \/
        }
        i += 2
    }
    return out
}

; ---------- Alt+Enter, Enter, Apply, Alt+F in Claude ----------

CheckDraft() {
    global claudeHwnd
    claudeHwnd := WinActive(CLAUDE_WINDOW)
    KeyWait("Alt", "L T1")  ; Alt must be up (logically: also covers keys sent by software) before Ctrl+A/C
    text := ReadDraft(&html)  ; through UI Automation: no copy (glint-uia.ahk)
    StartJob("check", text, html)
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
    PasteIntoClaude(fixText, FixedHtml(fixText, fixHtml))
    SetStatus("Fixed version is in Claude. Press Enter to send.")
}

; Fix N only (its Apply button): re-read the draft (keeping any edits made since the check), change
; that one phrase, and put the message back. The plugin's `apply` command does the matching.
ApplyFix(n) {
    if !FocusClaude()
        return
    id := A_TickCount
    inFile := A_Temp "\glint-" id ".draft.txt"
    outFile := A_Temp "\glint-" id ".fixed.txt"
    FileAppend(CopyDraft(&html), inFile, "UTF-8-RAW")
    if (html is Buffer)
        WriteBuffer(inFile ".html", html)
    RunWait(Format('"{1}" "{2}" apply --index {3} --in "{4}"{5} --out "{6}"', NODE, GLINT, n, inFile, HtmlArg(inFile ".html"), outFile), A_Temp, "Hide")
    result := StrSplit(ReadText(outFile ".status"), "`n", "`r")
    if (result.Length >= 1 && result[1] = "ok")
        PasteIntoClaude(ReadText(outFile), ReadBuffer(outFile ".cfhtml"))
    state := ReadText(outFile ".json")
    if (state != "")
        Render(state)
    else
        SetStatus(result.Length >= 2 ? result[2] : "Something went wrong applying that fix.")
    for path in [inFile, inFile ".html", outFile, outFile ".cfhtml", outFile ".rtf", outFile ".json", outFile ".status"] {
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

; ---------- gate mode: held-back prompts and tips ----------

WatchFeedback() {
    global lastFeedback, lastTips, fixText, fixHtml, showingCheck
    tips := ReadText(TIPS_FILE)
    if (tips != "" && tips != lastTips) {
        lastTips := tips
        if (IsShown() && !IsObject(job))  ; never interrupt a check or lookup for a tip
            Render(MessageState("English tip", tips), "Your prompt was sent.")
    }
    text := ReadText(FEEDBACK_FILE)
    if (text = "" || text = lastFeedback)
        return
    lastFeedback := text
    StopJob()
    fixText := Trim(ReadText(NATURAL_FILE))
    fixHtml := ""  ; gate mode only has the prompt's text
    Render(MessageState("Prompt held back", text), "Fix it, or press Alt+F. Then send again.")
    showingCheck := true
    ShowPanel()  ; in front, even if it was behind Claude; the focus stays in Claude's message box
}

; ---------- running checks and lookups ----------

StartJob(kind, text, html := "") {
    global job, fixText, fixHtml, showingCheck
    StopJob()
    fixText := "", fixHtml := ""
    showingCheck := (kind = "check")
    id := A_TickCount
    job := {kind: kind, in: A_Temp "\glint-" id ".in.txt", out: A_Temp "\glint-" id ".out.txt", pid: 0, shown: "", started: A_TickCount}
    FileAppend(text, job.in, "UTF-8-RAW")
    if (html is Buffer)
        WriteBuffer(job.in ".html", html)
    Render(kind = "check" ? '{"view":"checking"}'
        : '{"view":"lookup","question":' JsonString(text) ',"answer":"","streaming":true,"canUseFix":false}')
    if (kind = "check")
        ShowPanel()  ; in front, even if it was behind Claude; the focus stays in Claude's message box
    Run(Format('"{1}" "{2}" {3} --in "{4}"{5} --out "{6}"', NODE, GLINT, kind, job.in, HtmlArg(job.in ".html"), job.out), A_Temp, "Hide", &pid)
    job.pid := pid
    SetTimer(Poll, 150)
}

Poll() {
    global job, fixText, fixHtml
    if !IsObject(job) {
        SetTimer(Poll, 0)
        return
    }
    done := FileExist(job.out ".done")
    state := ReadText(job.out ".json")
    if (state != "" && state != job.shown) {
        job.shown := state
        if !done
            Render(state)  ; a lookup streaming in
    }
    if done {
        if (job.shown = "") {
            Render(MessageState("No answer came back", "Check that Node.js and the Claude CLI work in a terminal."))
        } else if (job.kind = "check") {
            fixText := Trim(ReadText(job.out ".natural"))
            fixHtml := (fixText != "") ? ReadBuffer(job.out ".naturalhtml") : ""
            Render(job.shown)
        } else {
            Render(job.shown, Format("Answered in {:.1f} s", (A_TickCount - job.started) / 1000))
        }
        StopJob()
    } else if !ProcessExist(job.pid) {
        Sleep(300)  ; the .done marker may land just after the process exits
        if !FileExist(job.out ".done") {
            if (job.shown = "")
                Render(MessageState("No answer came back", "Check that Node.js and the Claude CLI work in a terminal."))
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
    for path in [job.in, job.in ".html", job.out, job.out ".rtf", job.out ".json", job.out ".natural", job.out ".naturalhtml", job.out ".done"] {
        try FileDelete(path)
    }
    job := ""
}
