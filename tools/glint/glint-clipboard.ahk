; Copying and pasting Claude's message box, for glint-panel.ahk and glint-window.ahk. (Alt+Enter
; reads the message box without the clipboard, see glint-uia.ahk; changing it needs a paste.)
;
; The message box puts its content on the clipboard twice: as plain text, which leaves out the numbers
; of a numbered list and turns a /command chip into plain words, and as HTML ("HTML Format"), which
; keeps both. Glint reads the HTML too (glint.mjs turns it into text with the list numbers written
; out) and pastes HTML back, so lists, /commands and @mentions survive a fix.
;
; Whatever Glint puts on the clipboard, including the user's own content put back afterwards, is
; marked so Windows clipboard history, the cloud clipboard and clipboard managers skip it.

; Copy the message box without losing what was on the clipboard. Returns its plain text, and sets
; `html` to its "HTML Format" data (a Buffer), or "" if there was none.
CopyDraft(&html := "") {
    saved := ClipboardAll()
    A_Clipboard := ""
    Send("^a^c")
    text := ClipWait(1) ? A_Clipboard : ""
    html := (text != "") ? ClipboardHtml() : ""
    Send("^{End}")  ; drop the selection and put the cursor back at the end
    RestoreClipboard(saved)
    return text
}

; Replace everything in Claude's message box with `text`, keeping the clipboard as it was. With `html`
; (a Buffer of "HTML Format" data from glint.mjs), the message box rebuilds its lists and chips.
PasteIntoClaude(text, html := "") {
    saved := ClipboardAll()
    if SetClipboardRich(text, html) {
        Send("^a^v")
        Sleep(250)  ; let the paste finish before the clipboard is restored
    }
    RestoreClipboard(saved)
}

; Put back what was on the clipboard (a ClipboardAll), marked so it isn't recorded a second time.
RestoreClipboard(saved) {
    ; ClipboardAll data: for each format a UInt format number, a UInt size and the data; then a 0.
    entries := []
    offset := 0
    while (offset + 8 <= saved.Size && (format := NumGet(saved, offset, "UInt"))) {
        size := NumGet(saved, offset + 4, "UInt")
        ; Bitmaps, metafiles and palettes are handles rather than memory: AutoHotkey restores those.
        if (format = 2 || format = 3 || format = 9 || format = 14 || (format >= 0x80 && format <= 0x8E) || (format >= 0x300 && format <= 0x3FF)) {
            A_Clipboard := saved
            return
        }
        entries.Push({format: format, ptr: saved.Ptr + offset + 8, size: size})
        offset += 8 + size
    }
    if !OpenClipboardSoon() {
        A_Clipboard := saved
        return
    }
    try {
        DllCall("EmptyClipboard")
        for entry in entries
            PutClipboardData(entry.format, entry.ptr, entry.size)
        MarkPrivate()
    } finally DllCall("CloseClipboard")
}

; With the clipboard open: ask Windows clipboard history, the cloud clipboard and clipboard managers
; to skip what's on it.
MarkPrivate() {
    static zero := Buffer(4, 0)
    for name in ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard", "Clipboard Viewer Ignore"]
        PutClipboardData(DllCall("RegisterClipboardFormat", "Str", name, "UInt"), zero, 4)
}

; The clipboard's "HTML Format" data (UTF-8 bytes, header included) as a Buffer, or "" if none.
ClipboardHtml() {
    format := DllCall("RegisterClipboardFormat", "Str", "HTML Format", "UInt")
    if (!DllCall("IsClipboardFormatAvailable", "UInt", format) || !OpenClipboardSoon())
        return ""
    data := ""
    try {
        h := DllCall("GetClipboardData", "UInt", format, "Ptr")
        if (h && (p := DllCall("GlobalLock", "Ptr", h, "Ptr"))) {
            size := DllCall("GlobalSize", "Ptr", h, "UPtr")
            data := Buffer(size)
            DllCall("RtlMoveMemory", "Ptr", data, "Ptr", p, "UPtr", size)
            DllCall("GlobalUnlock", "Ptr", h)
        }
    } finally DllCall("CloseClipboard")
    return data
}

; Put `text` (plain text), and `html` (a Buffer of "HTML Format" data) if given, on the clipboard,
; marked so it isn't recorded.
SetClipboardRich(text, html := "") {
    format := DllCall("RegisterClipboardFormat", "Str", "HTML Format", "UInt")
    if !OpenClipboardSoon()
        return false
    ok := false
    try {
        DllCall("EmptyClipboard")
        ok := PutClipboardData(13, StrPtr(text), (StrLen(text) + 1) * 2)  ; CF_UNICODETEXT, with its terminator
        if (ok && html is Buffer && html.Size)
            ok := PutClipboardData(format, html, html.Size)
        MarkPrivate()
    } finally DllCall("CloseClipboard")
    return ok
}

PutClipboardData(format, src, size) {
    h := DllCall("GlobalAlloc", "UInt", 0x42, "UPtr", size + 1, "Ptr")  ; GMEM_MOVEABLE | GMEM_ZEROINIT, plus a terminator
    if !h
        return false
    p := DllCall("GlobalLock", "Ptr", h, "Ptr")
    DllCall("RtlMoveMemory", "Ptr", p, "Ptr", src, "UPtr", size)
    DllCall("GlobalUnlock", "Ptr", h)
    if DllCall("SetClipboardData", "UInt", format, "Ptr", h, "Ptr")
        return true
    DllCall("GlobalFree", "Ptr", h)
    return false
}

; Another app may have the clipboard open for a moment.
OpenClipboardSoon() {
    Loop 20 {
        if DllCall("OpenClipboard", "Ptr", A_ScriptHwnd)
            return true
        Sleep(10)
    }
    return false
}

; Save a Buffer (e.g. the "HTML Format" data) to a file, for glint.mjs to read.
WriteBuffer(path, buf) {
    f := FileOpen(path, "w")
    f.RawWrite(buf)
    f.Close()
}

; A file's raw bytes as a Buffer, or "" if it doesn't exist.
ReadBuffer(path) {
    try return FileRead(path, "RAW")
    return ""
}

; "Use fixed version": HTML to paste for the fixed text, so lists and chips come back. The check made
; it already (`checked`, with any /command chip), but @mention chips can only come from the message
; box's own HTML: for a text with an @, copy that now and let glint.mjs rebuild the fixed text.
FixedHtml(fixed, checked) {
    if !InStr(fixed, "@")
        return checked
    CopyDraft(&html)
    if !(html is Buffer)
        return checked
    id := A_TickCount
    inFile := A_Temp "\glint-" id ".natural.txt"
    outFile := A_Temp "\glint-" id ".natural.out"
    FileAppend(fixed, inFile, "UTF-8-RAW")
    WriteBuffer(inFile ".html", html)
    RunWait(Format('"{1}" "{2}" natural --in "{3}" --html "{4}" --out "{5}"', NODE, GLINT, inFile, inFile ".html", outFile), A_Temp, "Hide")
    rebuilt := ReadBuffer(outFile ".cfhtml")
    for path in [inFile, inFile ".html", outFile ".cfhtml"] {
        try FileDelete(path)
    }
    return (rebuilt is Buffer) ? rebuilt : checked
}

; The --html argument for glint.mjs when the HTML was saved to `path`.
HtmlArg(path) => FileExist(path) ? Format(' --html "{1}"', path) : ""
