Option Explicit

Dim shell, command
Set shell = CreateObject("WScript.Shell")

command = "powershell.exe -NoProfile -WindowStyle Hidden -Command ""$p = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { Stop-Process -Id $p -Force }"""
shell.Run command, 0, True
MsgBox "企业报表分析 Agent 已停止。", 64, "Enterprise Report Agent"
