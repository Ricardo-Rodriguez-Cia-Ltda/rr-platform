# Instala el arranque automatico de la API de precios y del tunel de Cloudflare.
# EJECUTAR EN POWERSHELL COMO ADMINISTRADOR:
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "ERROR: abre PowerShell como Administrador y vuelve a ejecutar." -ForegroundColor Red
  exit 1
}

$proj = Split-Path -Parent $PSScriptRoot
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
Write-Host "Proyecto: $proj"

# --- 1. Tunel de Cloudflare como servicio de Windows ---
# Detiene la instancia suelta que se haya dejado corriendo a mano.
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
if (Get-Service cloudflared -ErrorAction SilentlyContinue) {
  Write-Host "Servicio cloudflared ya existe, se reinstala para tomar el config.yml actual."
  & $cloudflared service uninstall
  Start-Sleep -Seconds 2
}
& $cloudflared service install
Start-Sleep -Seconds 3
Start-Service cloudflared -ErrorAction SilentlyContinue

# --- 2. Servidor de la API como tarea programada (al arrancar el equipo) ---
$action = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument "/c cd /d `"$proj`" && `"C:\Program Files\nodejs\npm.cmd`" run serve >> logs\serve.log 2>&1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName "CaptadorPrecios-API" -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description "API de precios de proveedores (servidor local)" -Force | Out-Null

# --- 3. Evitar suspension del equipo ---
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

# --- 4. Estado final ---
Write-Host "`n--- Estado ---" -ForegroundColor Cyan
Get-Service cloudflared | Select-Object Name, Status, StartType | Format-Table
Get-ScheduledTask -TaskName "CaptadorPrecios-API" | Select-Object TaskName, State | Format-Table
Write-Host "Listo. Reinicia el equipo para verificar que todo levanta solo." -ForegroundColor Green
