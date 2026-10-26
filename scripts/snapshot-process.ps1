param([Parameter(Mandatory=$true)][int]$TargetProcessId, [Parameter(Mandatory=$true)][string]$ExpectedPath,
      [ValidateRange(1,6)][int]$Samples=3, [ValidateRange(250,10000)][int]$IntervalMs=1000)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$first = Get-Process -Id $TargetProcessId -ErrorAction Stop
if (-not [string]::Equals($first.Path, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Process executable does not match selected project file' }
$birth = $first.StartTime.ToUniversalTime().Ticks
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$snapshots = @()
for ($sampleIndex=0; $sampleIndex -lt $Samples; $sampleIndex++) {
    $current = Get-Process -Id $TargetProcessId -ErrorAction Stop
    if ($current.StartTime.ToUniversalTime().Ticks -ne $birth -or -not [string]::Equals($current.Path, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Process identity changed' }
    $table = @(& (Join-Path $env:SystemRoot 'System32/netstat.exe') -ano)
    if ($LASTEXITCODE -ne 0) { throw 'Connection table unavailable' }
    $connections = @($table | Where-Object { $_ -match ('^\s*(TCP|UDP)\s+.+\s' + $TargetProcessId + '\s*$') } | ForEach-Object { [string]$_.Trim() })
    $snapshots += [ordered]@{
        observedAt=[DateTimeOffset]::UtcNow.ToString('o'); cpuSeconds=[double]$current.CPU
        workingSetBytes=[long]$current.WorkingSet64; privateBytes=[long]$current.PrivateMemorySize64
        handles=[int]$current.HandleCount; threads=[int]$current.Threads.Count; connections=$connections
    }
    if ($sampleIndex -lt ($Samples-1)) { Start-Sleep -Milliseconds $IntervalMs }
}
$last = Get-Process -Id $TargetProcessId -ErrorAction Stop
if ($last.StartTime.ToUniversalTime().Ticks -ne $birth) { throw 'Process identity changed' }
[ordered]@{
    pid=$TargetProcessId; executable=[string]$first.Path; processStartedAt=$first.StartTime.ToUniversalTime().ToString('o')
    startedAt=$startedAt; endedAt=[DateTimeOffset]::UtcNow.ToString('o'); snapshots=$snapshots
    method='process_snapshot'; networkScope='connection_snapshot'; isolationVerified=$false
    limitations=@('Connection table samples only; transient activity between samples can be missed', 'No packet capture, historical traffic proof, network isolation or target function verification')
} | ConvertTo-Json -Depth 7 -Compress
