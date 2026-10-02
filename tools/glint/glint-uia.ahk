; Reading Claude's message box through Windows UI Automation (what screen readers use), for
; glint-panel.ahk and glint-window.ahk: Alt+Enter doesn't copy anything, so the clipboard is left alone.
;
; The message box is a TipTap (ProseMirror) editor in Chromium. Its UI Automation text has the list
; numbers ("1. ", "• ") and /command chips written out, one line per paragraph (empty lines are left
; out). Changing the message (Apply, Use fixed version) still goes through the clipboard: Chromium
; misplaces UI Automation selections after list numbers, so selecting words and typing over them
; isn't safe.

UiaClient() {
    static uia := ""
    if !IsObject(uia) {
        try uia := ComObject("{e22ad333-b25f-460c-83d0-0581107395c9}", "{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}")  ; CUIAutomation8
        catch
            uia := ComObject("{ff48dba4-60ef-4201-aa87-54103eef594e}", "{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}")  ; CUIAutomation
    }
    return uia
}

; The focused element if it's Claude's message box (a ProseMirror editor), else "".
UiaMessageBox() {
    try {
        ComCall(8, UiaClient(), "ptr*", &el := 0)  ; IUIAutomation::GetFocusedElement
        if !el
            return ""
        el := ComValue(13, el)  ; VT_UNKNOWN: released when no longer used
        return InStr(UiaClassName(el), "ProseMirror") ? el : ""
    }
    return ""
}

UiaClassName(el) {
    ComCall(30, el, "ptr*", &bstr := 0)  ; IUIAutomationElement::get_CurrentClassName
    return BstrText(bstr)
}

; The element's text, with `ok` set to whether it could be read.
UiaText(el, &ok := false) {
    static iid := GuidBuffer("{32eba289-3583-42c9-9c59-3b6d9a1e9b6a}")  ; IID_IUIAutomationTextPattern
    ok := false
    try {
        ComCall(14, el, "int", 10014, "ptr", iid, "ptr*", &tp := 0)  ; GetCurrentPatternAs(UIA_TextPatternId)
        if !tp
            return ""
        ComCall(7, ComValue(13, tp), "ptr*", &range := 0)  ; IUIAutomationTextPattern::get_DocumentRange
        ComCall(12, ComValue(13, range), "int", -1, "ptr*", &bstr := 0)  ; IUIAutomationTextRange::GetText(all)
        text := StrReplace(BstrText(bstr), "`r`n", "`n")
        ok := true
        return RTrim(text, "`n")  ; the editor's trailing line break
    }
    return ""
}

; Read Claude's message box: through UI Automation when it's focused, else by copying it (which
; also gets its HTML, see glint-clipboard.ahk). `html` is "" when nothing was copied.
ReadDraft(&html := "") {
    html := ""
    if (el := UiaMessageBox()) {
        text := UiaText(el, &ok)
        if ok
            return text
    }
    return CopyDraft(&html)
}

BstrText(bstr) {
    if !bstr
        return ""
    text := StrGet(bstr, "UTF-16")
    DllCall("OleAut32\SysFreeString", "Ptr", bstr)
    return text
}

GuidBuffer(text) {
    buf := Buffer(16)
    DllCall("ole32\CLSIDFromString", "WStr", text, "Ptr", buf, "HRESULT")
    return buf
}
