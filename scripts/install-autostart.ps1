# Deja la API y el tunel arrancando solos al encender el equipo.
#
# EJECUTAR EN POWERSHELL COMO ADMINISTRADOR:
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#
# Ambos quedan como tareas programadas "al inicio" corriendo como SYSTEM, con
# reintento automatico. No usamos el servicio de Windows de cloudflared porque
# `cloudflared service install` lo registra sin argumentos y no levanta el tunel.

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "ERROR: abre PowerShell como Administrador y vuelve a ejecutar." -ForegroundColor Red
  exit 1
}

$proj = Split-Path -Parent $PSScriptRoot
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$configTunel = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
$npm = "C:\Program Files\nodejs\npm.cmd"

Write-Host "Proyecto:    $proj"
Write-Host "Config tunel: $configTunel"

foreach ($ruta in @($cloudflared, $configTunel, $npm)) {
  if (-not (Test-Path $ruta)) { throw "No existe: $ruta" }
}
if (-not (Test-Path (Join-Path $proj 'logs'))) {
  New-Item -ItemType Directory -Path (Join-Path $proj 'logs') | Out-Null
}

# --- 1. Quitar el servicio de cloudflared si quedo instalado ---
# Se registra sin argumentos, queda Stopped y compite con la tarea programada.
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "Quitando el servicio cloudflared (queda mal registrado)..."
  try { & $cloudflared service uninstall | Out-Null } catch {}
  Start-Sleep -Seconds 2
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# --- 2. Servidor de la API ---
$accionApi = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument "/c cd /d `"$proj`" && `"$npm`" run serve >> logs\serve.log 2>&1"
Register-ScheduledTask -TaskName "CaptadorPrecios-API" -Action $accionApi -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description "API de precios y busqueda de proveedores" -Force | Out-Null
Write-Host "Tarea CaptadorPrecios-API registrada."

# --- 3. Tunel de Cloudflare ---
# --config explicito: como SYSTEM, cloudflared no ve el perfil del usuario.
$accionTunel = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument "/c `"$cloudflared`" --config `"$configTunel`" tunnel run >> `"$proj\logs\tunnel.log`" 2>&1"
Register-ScheduledTask -TaskName "CaptadorPrecios-Tunnel" -Action $accionTunel -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description "Cloudflare Tunnel para api.pyxis-latam.cl" -Force | Out-Null
Write-Host "Tarea CaptadorPrecios-Tunnel registrada."

# --- 4. Evitar que el equipo se suspenda ---
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

# --- 5. Estado final ---
Write-Host "`n--- Estado ---" -ForegroundColor Cyan
Get-ScheduledTask -TaskName "CaptadorPrecios-*" | Select-Object TaskName, State | Format-Table -AutoSize
Write-Host "Listo. Reinicia el equipo para verificar que todo levanta solo." -ForegroundColor Green
Write-Host "Tras el reinicio, comprueba: curl.exe -H `"x-api-key: <clave>`" https://api.pyxis-latam.cl/rr/captador-precios/facetas"
