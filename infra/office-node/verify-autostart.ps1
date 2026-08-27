# Simula un reinicio: detiene los procesos sueltos, arranca las tareas
# programadas y comprueba que la API publica responde. Requiere Administrador.
$ErrorActionPreference = 'Continue'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "ERROR: requiere Administrador."; exit 1
}

$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Write-Host "1) Deteniendo procesos sueltos (node y cloudflared)..."
Get-Process node, cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
  try { Stop-Process -Id $_.Id -Force } catch {}
}
Start-Sleep -Seconds 4

Write-Host "2) Arrancando las tareas programadas..."
Start-ScheduledTask -TaskName "CaptadorPrecios-API"
Start-ScheduledTask -TaskName "CaptadorPrecios-Tunnel"

Write-Host "3) Esperando a que levanten (hasta 3 min)..."
$clave = ((Get-Content "$proj\.env.local" | Where-Object { $_ -like 'API_SECRET_KEY=*' }) -replace '^API_SECRET_KEY=','').Trim()
$url = "https://api.pyxis-latam.cl/rr/captador-precios/facetas"
$ok = $false
for ($i = 0; $i -lt 36; $i++) {
  Start-Sleep -Seconds 5
  $codigo = & curl.exe -s -o NUL -w "%{http_code}" -m 15 -H "x-api-key: $clave" $url
  Write-Host "   intento $($i+1): HTTP $codigo"
  if ($codigo -eq '200') { $ok = $true; break }
}

Write-Host "`n--- Resultado ---"
Get-ScheduledTask -TaskName "CaptadorPrecios-*" | ForEach-Object {
  $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
  "{0,-24} estado={1,-8} ultimo_resultado={2}" -f $_.TaskName, $_.State, $info.LastTaskResult
}
if ($ok) {
  Write-Host "OK: la API publica responde arrancada desde las tareas programadas." -ForegroundColor Green
} else {
  Write-Host "FALLO: la API no respondio. Revisa logs\serve.log y logs\tunnel.log" -ForegroundColor Red
  Write-Host "--- serve.log:"; Get-Content "$proj\logs\serve.log" -Tail 15 -ErrorAction SilentlyContinue
  Write-Host "--- tunnel.log:"; Get-Content "$proj\logs\tunnel.log" -Tail 15 -ErrorAction SilentlyContinue
}
