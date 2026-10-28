# probe-tunnel.ps1 - layered health probe for the papilot public tunnel.
#
# Answers "why is pp.xinglintools.top a 530?" in one run, in the same
# bottom-up order an engineer would use:
#
#   L1  local backend      http://127.0.0.1:8000/api/health
#   L2  tunnel process     cloudflared.exe with --metrics ...:20250
#   L3  edge readiness     http://127.0.0.1:20250/ready  readyConnections > 0
#   L4  host -> edge       TCP + TLS handshake to <region>.v2.argotunnel.com:7844
#   L5  public endpoint    https://pp.xinglintools.top/api/health
#   L6  egress sanity      is a TUN/proxy stealing the 0.0.0.0/1 route?
#
# L4 is the layer that distinguishes the two classic 530 causes:
#   * edge unreachable + TCP connect returns in <5ms  -> a local TUN/proxy
#     answered the handshake itself and the upstream leg is broken.
#   * edge reachable but L3 still 0                   -> tunnel credentials
#     or cloudflared-side trouble, look at runtime\cloudflared\logs.
#
# Exit code: 0 = public endpoint healthy, 1 = something in L1..L5 failed.
# PS 5.1 compatible. ASCII only (may run from a scheduled task).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diag\probe-tunnel.ps1
#   powershell ... -File scripts\diag\probe-tunnel.ps1 -Json     # machine readable

param(
    [string]$EdgeHost = 'region1.v2.argotunnel.com',
    [int]$EdgePort = 7844,
    [int]$TimeoutSec = 8,
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cfDir      = Join-Path $projectDir 'runtime\cloudflared'
$metricsUrl = 'http://127.0.0.1:20250/ready'
$localUrl   = 'http://127.0.0.1:8000/api/health'
$publicUrl  = 'https://pp.xinglintools.top/api/health'
$metricsPort = 20250

$checks = New-Object System.Collections.ArrayList

function Add-Check {
    param([string]$Layer, [string]$Name, [string]$Status, [string]$Detail)
    [void]$checks.Add([pscustomobject]@{
        layer  = $Layer
        name   = $Name
        status = $Status   # PASS / FAIL / WARN / SKIP
        detail = $Detail
    })
}

function Invoke-JsonProbe {
    param([string]$Url, [int]$TimeoutSec = 5)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return [pscustomobject]@{ ok = $true; code = [int]$r.StatusCode; body = $r.Content; error = '' }
    } catch {
        $code = 0
        try { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } } catch {}
        return [pscustomobject]@{ ok = $false; code = $code; body = ''; error = $_.Exception.Message }
    }
}

# --- L4 primitive: real TCP + TLS handshake against a Cloudflare edge IP ---
function Test-EdgeTls {
    param([string]$Target, [int]$Port, [int]$TimeoutMs = 6000)
    $res = [pscustomobject]@{
        target = "${Target}:${Port}"; tcpOk = $false; tlsOk = $false
        tcpMs = -1; tlsMs = -1; error = ''
    }
    $tcp = $null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($Target, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw 'tcp connect timeout' }
        $tcp.EndConnect($iar)
        $res.tcpOk = $true
        $res.tcpMs = [int]$sw.ElapsedMilliseconds

        $cb = [System.Net.Security.RemoteCertificateValidationCallback] {
            param($s, $cert, $chain, $errors) return $true
        }
        $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $cb)
        $ssl.AuthenticateAsClient($Target)
        $res.tlsOk = $true
        $res.tlsMs = [int]$sw.ElapsedMilliseconds
        try { $ssl.Dispose() } catch {}
    } catch {
        $res.error = $_.Exception.Message
    } finally {
        if ($tcp) { try { $tcp.Close() } catch {} }
        $sw.Stop()
    }
    return $res
}

# ---------------------------------------------------------------- L1 backend
$h = Invoke-JsonProbe -Url $localUrl -TimeoutSec 5
if ($h.ok) {
    $ver = ''
    try { $ver = ($h.body | ConvertFrom-Json).version } catch {}
    Add-Check 'L1' 'local backend :8000' 'PASS' "HTTP 200 version=$ver"
} else {
    Add-Check 'L1' 'local backend :8000' 'FAIL' "unreachable (code=$($h.code)) $($h.error)"
}

# --------------------------------------------------------------- L2 process
$procs = @()
try {
    $all = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop
    $procs = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf("$metricsPort") -ge 0 })
} catch {}
if ($procs.Count -gt 0) {
    $ids = ($procs | ForEach-Object { $_.ProcessId }) -join ','
    Add-Check 'L2' 'tunnel process' 'PASS' "$($procs.Count) process(es) pid=$ids"
} else {
    Add-Check 'L2' 'tunnel process' 'FAIL' 'no cloudflared.exe holding metrics port 20250'
}

# ---------------------------------------------------------------- L3 ready
$r = Invoke-JsonProbe -Url $metricsUrl -TimeoutSec 4
$ready = -1
if ($r.ok -or $r.code -eq 503) {
    try { $ready = [int](($r.body | ConvertFrom-Json).readyConnections) } catch { $ready = -1 }
}
if ($ready -gt 0) {
    Add-Check 'L3' 'edge readiness' 'PASS' "readyConnections=$ready"
} elseif ($ready -eq 0) {
    Add-Check 'L3' 'edge readiness' 'FAIL' 'readyConnections=0 (process up but no edge connection)'
} else {
    Add-Check 'L3' 'edge readiness' 'FAIL' "metrics endpoint not answering on 127.0.0.1:$metricsPort"
}

# ------------------------------------------------------------ L4 host -> edge
$edgeResults = New-Object System.Collections.ArrayList
$resolved = @()
try {
    $resolved = @([System.Net.Dns]::GetHostAddresses($EdgeHost) |
        Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
        ForEach-Object { $_.IPAddressToString })
} catch {}
$targets = @()
if ($resolved.Count -gt 0) { $targets = @($resolved[0..([Math]::Min(1, $resolved.Count - 1))]) }
$targets += '198.41.192.167'
$targets = @($targets | Select-Object -Unique)

$anyTls = $false
$fastTcp = $false
foreach ($t in $targets) {
    $e = Test-EdgeTls -Target $t -Port $EdgePort -TimeoutMs ($TimeoutSec * 1000)
    [void]$edgeResults.Add($e)
    if ($e.tlsOk) { $anyTls = $true }
    if ($e.tcpOk -and $e.tcpMs -ge 0 -and $e.tcpMs -lt 5) { $fastTcp = $true }
}
$edgeSummary = ($edgeResults | ForEach-Object {
    $state = if ($_.tlsOk) { 'tls-ok' } elseif ($_.tcpOk) { 'tcp-only' } else { 'dead' }
    "$($_.target) $state tcp=$($_.tcpMs)ms tls=$($_.tlsMs)ms"
}) -join ' | '

if ($anyTls) {
    Add-Check 'L4' 'host -> edge 7844' 'PASS' $edgeSummary
} else {
    $hint = ''
    if ($fastTcp) { $hint = ' (TCP answered in <5ms => local TUN/proxy is terminating the connection)' }
    Add-Check 'L4' 'host -> edge 7844' 'FAIL' ($edgeSummary + $hint)
}

# ----------------------------------------------------------- L5 public edge
$p = Invoke-JsonProbe -Url $publicUrl -TimeoutSec 12
if ($p.ok) {
    Add-Check 'L5' 'public endpoint' 'PASS' "HTTP 200 $publicUrl"
} else {
    Add-Check 'L5' 'public endpoint' 'FAIL' "HTTP $($p.code) $publicUrl $($p.error)"
}

# ------------------------------------------------------------ L6 egress path
$tunIfaces = @()
try {
    $half = Get-NetRoute -ErrorAction SilentlyContinue |
        Where-Object { $_.DestinationPrefix -in @('0.0.0.0/1', '128.0.0.0/1') }
    $tunIfaces = @($half | ForEach-Object { $_.InterfaceAlias } | Select-Object -Unique)
} catch {}
$edgeRoute = ''
try {
    $fr = Find-NetRoute -RemoteIPAddress '198.41.192.167' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($fr) { $edgeRoute = $fr.InterfaceAlias }
} catch {}

if ($tunIfaces.Count -gt 0) {
    $msg = "TUN route present via: $($tunIfaces -join ',')"
    if ($edgeRoute) { $msg += "; 198.41.192.167 currently egresses via: $edgeRoute" }
    if ($edgeRoute -and $tunIfaces -notcontains $edgeRoute) {
        Add-Check 'L6' 'egress path' 'PASS' ($msg + ' (edge bypasses TUN)')
    } else {
        Add-Check 'L6' 'egress path' 'WARN' ($msg + ' (edge traffic is inside the tunnel)')
    }
} else {
    Add-Check 'L6' 'egress path' 'PASS' 'no TUN 0/1 routes; direct egress'
}

# ------------------------------------------------------------------- report
$failed = @($checks | Where-Object { $_.status -eq 'FAIL' })

if ($Json) {
    [pscustomobject]@{
        generatedAt = (Get-Date).ToString('s')
        healthy     = ($failed.Count -eq 0)
        checks      = $checks
        edge        = $edgeResults
    } | ConvertTo-Json -Depth 5
} else {
    Write-Output ''
    Write-Output 'Papilot tunnel probe'
    Write-Output ('=' * 62)
    foreach ($c in $checks) {
        Write-Output ("{0,-4} {1,-20} {2,-5} {3}" -f $c.layer, $c.name, $c.status, $c.detail)
    }
    Write-Output ('=' * 62)
    if ($failed.Count -eq 0) {
        Write-Output 'RESULT: healthy - public tunnel is serving traffic.'
    } else {
        Write-Output ("RESULT: {0} failing layer(s)." -f $failed.Count)
        $l4 = @($checks | Where-Object { $_.layer -eq 'L4' -and $_.status -eq 'FAIL' })
        if ($l4.Count -gt 0) {
            Write-Output ''
            Write-Output 'L4 failed: the host cannot complete a TLS handshake with the Cloudflare edge.'
            Write-Output '  If TCP connected in <5ms, a local TUN/proxy (e.g. Clash TUN) is intercepting'
            Write-Output '  198.41.128.0/17 and routing it to a node that cannot carry argotunnel traffic.'
            Write-Output '  Bypass it (admin shell):'
            Write-Output '    route add 198.41.128.0 mask 255.255.128.0 <physical-gateway> metric 1 -p'
            Write-Output '  then: powershell -File scripts\tunnel\tunnel.ps1 restart'
        }
        $l3 = @($checks | Where-Object { $_.layer -eq 'L3' -and $_.status -eq 'FAIL' })
        if ($l3.Count -gt 0 -and $l4.Count -eq 0) {
            Write-Output ''
            Write-Output 'L3 failed but the edge is reachable: the tunnel itself is the problem.'
            Write-Output '  Check runtime\cloudflared\token.txt validity and the tail of'
            Write-Output '  runtime\cloudflared\logs\cf-run-papilot.log'
        }
    }
}
if ($failed.Count -eq 0) { exit 0 } else { exit 1 }
