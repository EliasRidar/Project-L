Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "powershell -NoProfile -WindowStyle Hidden -Command ""Set-Location -LiteralPath '" & base & "'; node server.js"""
WshShell.Run cmd, 0, False

WshShell.Run "powershell -NoProfile -Command ""Start-Process 'http://localhost:3000'""", 0, False
