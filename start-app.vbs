Option Explicit

Dim shell, fso, projectDir, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /c cd /d """ & projectDir & """ && set NO_OPEN=1 && node src\server.js"

shell.Run command, 0, False
WScript.Sleep 1200
shell.Run "http://127.0.0.1:3210/", 1, False
