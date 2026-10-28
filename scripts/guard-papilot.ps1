# guard-papilot.ps1
# Watchdog for the Papilot account backend + public tunnel on this host.
# Optional: register as scheduled task "PapilotGuard" (once per machine,
# no elevation needed - the services run in the user session).
#
#   pass 1: account server (127.0.0.1:8000, node account-server.js)
#           -> resurrect via scripts/start-account-server.ps1 (idempotent).
#              Honors server/data/stopped-account.flag (set by launcher
#              "stop" button / manual stop) - a flagged stop stays stopped.
#   pass 2: papilot tunnel (metrics 127.0.0.1:20250, pp.xinglintools.top
#           -> 127.0.0.1:8000) -> resurrect via the project-local toolkit
#           runtime/cloudflared/ (cloudflared.exe + token.txt).
#              Honors runtime/cloudflared/stopped.flag if present.
#
# Idempotent: each pass is a silent no-op while its endpoint answers.
# Tunnel health = HTTP /ready with readyConnections > 0 (a squatted metrics
# port can no longer mask a dead connector - port-open != healthy).
# A tunnel process younger than 90s is given time to finish connecting
# before any restart (avoids a kill/restart loop during slow edge connects).
# Log: server/data/guard.log (rotated at 2MB).
#
# 2026-10-16: rewritten for the portable layout - all dependencies now live
# in the project folder (runtime/), no more ~/.cloudflared or _brain vault
# references (the old chain broke as soon as the project moved to the
# external drive; public endpoint was down with a 530).
#
# PS 5.1 compatible. English output only (runs from a scheduled task).

$ErrorActionPreference = "Continue"
# 静默 Invoke-RestMethod 的进度条：计划任务日志里只留我们的 Write-Log 行
$ProgressPreference = "SilentlyContinue"

$scriptDir  = $PSScriptRoot
$projectDir = Split-Path -Parent $scriptDir
$serverDir  = Join-Path $projectDir "server"
$dataDir    = Join-Path $serverDir "data"
$logFile    = Join-Path $dataDir "guard.log"
$cfDir      = Join-Path $projectDir "runtime\cloudflared"
$cfExe      = Join-Path $cfDir "cloudflared.exe"
$cfToken    = Join-Path $cfDir "token.txt"
$cfStopFlag = Join-Path $cfDir "stopped.flag"

function Write-Log {
    param([string]$Msg)
    try {
        if (!(Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
        if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 2MB) {
            Remove-Item $logFile -Force -ErrorAction SilentlyContinue
        }
        Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg) -Encoding UTF8
    } catch {}
}

function Test-Port {
    param([int]$Port, [int]$TimeoutMs = 2000)
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { $c.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { if ($c) { try { $c.Close() } catch {} } }
}

# 1.8.5（审查 P1-9）：端口在听 != 能干活。服务端曾被同步写盘堵住事件循环，
# 此时 TCP 仍能握手、但所有请求悬空——只看 Test-Port 的守护会永远沉默，
# 而启动器面板显示「服务异常」，两边结论相反。这里改用 /api/health。
# 连续 2 次失败才重启，避免服务刚拉起、health 还没就绪时被误杀。
function Test-ServerHealthy {
    param([int]$TimeoutSec = 3, $Info = $null)
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec $TimeoutSec -ErrorAction Stop
        if ($null -eq $h -or -not $h.ok) { return $false }
        if ($Info -ne $null) { $Info.Value = $h }
        if ($h.degraded) {
            $stores = ($h.degradedStores | ForEach-Object { $_.store }) -join ','
            Write-Log ("account health: degraded (" + $stores + ") - alive, not restarting")
        }
        if ([int]$h.lagMs -gt 5000) {
            Write-Log ("account health: lagMs=" + [int]$h.lagMs + " (event loop blocked, alive)")
        }
        return $true
    } catch { return $false }
}

$healthFailFile = Join-Path $dataDir "guard-health-fails.txt"
function Get-HealthFails {
    try { return [int](Get-Content -Path $healthFailFile -ErrorAction Stop) } catch { return 0 }
}
function Set-HealthFails {
    param([int]$N)
    try { Set-Content -Path $healthFailFile -Value ([string]$N) -Encoding ASCII } catch {}
}

# 端口占着但 health 不通 → 用监听进程的 PID 强杀（health 拿不到 pid 时）
# 1.9.1（审查 P1-3）：杀之前必须确认目标进程命令行里真的有 account-server.js——
# 8000 被别的进程（IDE 预览、临时 dev server、其它 node 应用）占用时，按端口
# 无差别强杀会误伤用户工作。不匹配就只写日志不动手（留给人工排查）。
function Stop-PortOwner {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        foreach ($c in $conns) {
            if (-not $c.OwningProcess) { continue }
            $procId = $c.OwningProcess
            $cmdLine = ''
            try {
                $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId) -ErrorAction Stop
                if ($proc) { $cmdLine = [string]$proc.CommandLine }
            } catch { $cmdLine = '' }
            if ($cmdLine -and $cmdLine.IndexOf('account-server.js') -ge 0) {
                Write-Log ("killing pid " + $procId + " (account-server.js owns port " + $Port + " but health failed)")
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            } else {
                Write-Log ("port " + $Port + " owned by pid " + $procId + " but cmdline is not account-server.js (" + $cmdLine + ") - NOT killing, manual check needed")
            }
        }
        Start-Sleep -Seconds 2
    } catch { Write-Log ("Stop-PortOwner failed: " + $_.Exception.Message) }
}

function Test-TunnelReady {
    # readyConnections > 0 on the metrics endpoint; 3s cap so a hung
    # connector cannot stall the whole guard run.
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:20250/ready" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return ([int](($r.Content | ConvertFrom-Json).readyConnections) -gt 0)
    } catch { return $false }
}

function Get-AccountProcs {
    # 1.11.1：冷启动在 USB 移动硬盘上要 10+ 秒（require + 数据加载 + 启动快照），
    # 期间 8000 还没监听。旧逻辑 Test-Port 一失败就再 spawn 一个，两个实例抢端口。
    # 这里先看"是否已有 account-server 进程"，供 pass1 判断"正在启动"还是"真死了"。
    try {
        $list = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
        return ,@($list | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('account-server.js') -ge 0 })
    } catch { return ,@() }
}

function Get-TunnelProcs {
    try {
        $list = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop
        return ,@($list | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('20250') -ge 0 })
    } catch { return ,@() }
}

$edgeCidr = '198.41.128.0/17'   # Cloudflare argotunnel edge range

function Test-EdgeTls {
    # One TCP + TLS handshake against a Cloudflare edge IP.
    # Returns $true only when the TLS layer completes, i.e. the host can
    # actually talk to the tunnel edge. This separates two very different
    # failures that both surface as "readyConnections=0":
    #   * client-side trouble  -> edge reachable, restart the process
    #   * host cannot reach edge (TUN/proxy interception) -> restarting can
    #     never help, it would just churn one process per minute.
    param(
        [string]$Target = '198.41.192.167',
        [int]$Port = 7844,
        [int]$TimeoutMs = 6000
    )
    $tcp = $null
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($Target, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $tcp.EndConnect($iar)
        $cb = [System.Net.Security.RemoteCertificateValidationCallback] {
            param($s, $cert, $chain, $errors) return $true
        }
        $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $cb)
        $ssl.AuthenticateAsClient('region1.v2.argotunnel.com')
        try { $ssl.Dispose() } catch {}
        return $true
    } catch {
        return $false
    } finally {
        if ($tcp) { try { $tcp.Close() } catch {} }
    }
}

function Sync-EdgeBypassRoute {
    # A TUN proxy (Clash et al.) steals egress with 0.0.0.0/1 + 128.0.0.0/1
    # half-routes, which also capture the argotunnel edge on :7844 and hand
    # it to a proxy node that cannot carry that TLS session. Symptom in
    # cloudflared: endless "TLS handshake with edge error: EOF".
    # A /17 route via the *physical* gateway is more specific than /1, so edge
    # traffic leaves directly while everything else keeps using the proxy.
    # Idempotent. Needs elevation (scheduled task must run highest privilege).
    try {
        $half = @(Get-NetRoute -ErrorAction SilentlyContinue |
            Where-Object { $_.DestinationPrefix -in @('0.0.0.0/1', '128.0.0.0/1') })
        if ($half.Count -eq 0) { return }          # no TUN hijack, nothing to do
        $tunAliases = @($half | ForEach-Object { $_.InterfaceAlias } | Select-Object -Unique)

        $def = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
            Sort-Object RouteMetric | Select-Object -First 1
        if (-not $def) { return }
        if ($tunAliases -contains $def.InterfaceAlias) {
            Write-Log ("ALERT: pass3 default route is already on " + $def.InterfaceAlias + " - cannot derive a physical gateway, manual check")
            return
        }

        $cur = @(Get-NetRoute -DestinationPrefix $edgeCidr -ErrorAction SilentlyContinue)
        $viaTun = @($cur | Where-Object { $tunAliases -contains $_.InterfaceAlias })
        if ($cur.Count -gt 0 -and $viaTun.Count -eq 0) { return }   # already bypassing

        foreach ($r in $viaTun) {
            Remove-NetRoute -DestinationPrefix $edgeCidr -Confirm:$false -ErrorAction SilentlyContinue
        }
        New-NetRoute -DestinationPrefix $edgeCidr -InterfaceIndex $def.InterfaceIndex `
            -NextHop $def.NextHop -RouteMetric 1 -ErrorAction Stop | Out-Null
        Write-Log ("pass3: edge bypass route restored " + $edgeCidr + " -> " + $def.NextHop +
                   " via " + $def.InterfaceAlias + " (TUN on: " + ($tunAliases -join ',') + ")")
    } catch {
        Write-Log ("ALERT: pass3 route sync error: " + $_.Exception.Message)
    }
}

function Find-Node {
    # 1) project-local runtime (portable, first choice)
    $local = Join-Path $projectDir "runtime\node\node.exe"
    if (Test-Path $local) { return $local }
    # 2) managed runtimes - newest version（不写死用户名：随机器/账号变化）
    $base = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions"
    if (Test-Path $base) {
        $best = $null; $bestKey = -1
        Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $exe = Join-Path $_.FullName "node.exe"
            if (Test-Path $exe) {
                $parts = $_.Name.Split(".")
                if ($parts.Count -ge 3) {
                    $p2 = $parts[2].Split("-")
                    $k = [double]$parts[0] * 1000000 + [double]$parts[1] * 1000 + [double]$p2[0]
                    if ($k -gt $bestKey) { $bestKey = $k; $best = $exe }
                }
            }
        }
        if ($best) { return $best }
    }
    # 3) PATH
    return "node"
}

# ---------- pass 1: account server (8000) ----------
function Start-AccountServer {
    $nodeExe = Find-Node
    if (!(Test-Path $nodeExe) -and $nodeExe -ne "node") {
        Write-Log "FATAL: node.exe not found"
        return
    }
    # raw Process.Start on node.exe - no cmd.exe quoting games, no stdio
    # redirection needed (the server writes its own log file since v1.2)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = "account-server.js"
    $psi.WorkingDirectory = $serverDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [void][System.Diagnostics.Process]::Start($psi)
    # 1.11.1：原为固定 Start-Sleep 25s —— USB 盘冷启动实测可达 12 秒以上，
    # 固定等待既可能不够（误报 FATAL）又白占时间。改轮询，健康即返回，最多 60s。
    $up = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Test-ServerHealthy) { $up = $true; break }
    }
    if ($up) {
        Write-Log "account server back up (health ok)"
        Set-HealthFails 0
    } elseif (Test-Port 8000) {
        Write-Log "account server: port open but health still failing (will recheck)"
    } else {
        Write-Log "FATAL: account server did not come up (see server-console.log)"
    }
}

try {
    $stoppedFlag = Join-Path $dataDir "stopped-account.flag"
    if (Test-ServerHealthy) {
        if ((Get-HealthFails) -ne 0) { Set-HealthFails 0 }
        # healthy - silent no-op
    } elseif (Test-Path $stoppedFlag) {
        # intentionally stopped - leave it down (launcher Start clears the flag)
    } else {
        $portOpen = Test-Port 8000
        if (-not $portOpen) {
            # 1.11.1：进程在但端口还没开 = 正在启动（USB 冷启动 12s+），此时再 spawn
            # 一个只会两个实例抢 8000。只有"没有进程"或"进程已老且仍未监听"才重启。
            $procs = Get-AccountProcs
            $young = $false
            foreach ($p in $procs) {
                $st = $null
                try { $st = (Get-Process -Id $p.ProcessId -ErrorAction Stop).StartTime } catch { }
                if (-not $st) { $young = $true }
                elseif (((Get-Date) - $st).TotalSeconds -lt 90) { $young = $true }
            }
            if ($young) {
                Write-Log "account server is starting (process present, 8000 not open yet) - wait"
            } else {
                if ($procs.Count -gt 0) {
                    Write-Log "account server (8000) down, stale process found - killing and resurrecting..."
                    foreach ($p in $procs) {
                        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
                    }
                } else {
                    Write-Log "account server (8000) down, resurrecting..."
                }
                Set-HealthFails 0
                Start-AccountServer
            }
        } else {
            # 端口在听但 health 不通：可能是刚重启还没就绪，也可能是事件循环被堵死。
            # 连续 2 次（≈2 分钟）都失败才强杀重启，避免抖动。
            $fails = (Get-HealthFails) + 1
            Set-HealthFails $fails
            if ($fails -lt 2) {
                Write-Log ("account port open but /api/health failed (" + $fails + "/2) - recheck next run")
            } else {
                Write-Log ("account port open but /api/health failed " + $fails + " times - restarting")
                Stop-PortOwner 8000
                Start-AccountServer
            }
        }
    }
} catch { Write-Log ("pass1 error: " + $_.Exception.Message) }

# ---------- pass 2: papilot tunnel (metrics 20250) ----------
try {
    if (Test-TunnelReady) {
        # healthy - silent no-op
    } elseif (Test-Path $cfStopFlag) {
        # intentionally stopped (delete the flag to resume guarding)
    } else {
        $procs = Get-TunnelProcs
        $young = $false
        foreach ($p in $procs) {
            try {
                $started = (Get-Process -Id $p.ProcessId -ErrorAction Stop).StartTime
                if (((Get-Date) - $started).TotalSeconds -lt 90) { $young = $true }
            } catch {}
        }
        if ($young) {
            # edge connect window - silent, re-check next minute
        } elseif (-not (Test-EdgeTls)) {
            # Restarting into a wall is pointless and would only churn one
            # process per minute. Log and let pass 3 repair the egress path.
            Write-Log "ALERT: papilot tunnel (20250) not ready and edge :7844 unreachable (TLS handshake failed) - restart skipped, likely TUN/proxy interception"
        } else {
            if ($procs.Count -gt 0) {
                Write-Log "papilot tunnel (20250) not ready, replacing stale process..."
                foreach ($p in $procs) {
                    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
                }
                Start-Sleep -Seconds 2
            } else {
                Write-Log "papilot tunnel (20250) down, resurrecting..."
            }
            if ((Test-Path $cfExe) -and (Test-Path $cfToken)) {
                $psi = New-Object System.Diagnostics.ProcessStartInfo
                $psi.FileName = $cfExe
                $psi.Arguments = 'tunnel --protocol http2 --edge-ip-version 4 --metrics 127.0.0.1:20250 --no-autoupdate run --token-file token.txt'
                $psi.WorkingDirectory = $cfDir
                $psi.UseShellExecute = $false
                $psi.CreateNoWindow = $true
                [void][System.Diagnostics.Process]::Start($psi)
                Start-Sleep -Seconds 20
                if (Test-TunnelReady) { Write-Log "RECOVERED: papilot tunnel back up" }
                else { Write-Log "ALERT: tunnel process started but not edge-ready yet (see runtime\cloudflared\logs)" }
            } else {
                Write-Log "FATAL: cloudflared.exe or token.txt missing in runtime\cloudflared"
            }
        }
    }
} catch { Write-Log ("pass2 error: " + $_.Exception.Message) }

# ---------- pass 3: edge bypass route (TUN/proxy interference) ----------
# Runs last so a proxy restarting mid-run cannot silently re-hijack the edge
# range and break a healthy connector minutes later.
Sync-EdgeBypassRoute
