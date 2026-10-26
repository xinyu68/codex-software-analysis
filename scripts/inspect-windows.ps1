param([Parameter(Mandatory=$true)][string]$TargetPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$item = Get-Item -LiteralPath $TargetPath -ErrorAction Stop
if ($item.PSIsContainer) { throw 'Select one file' }
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName)
$certificate = $null
try {
    $cert = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($item.FullName)
    $certificate = [ordered]@{subject=$cert.Subject; issuer=$cert.Issuer; thumbprint=$cert.GetCertHashString()}
} catch [Security.Cryptography.CryptographicException] {
    # Absence of an extractable embedded certificate does not inspect catalog signing
}
[ordered]@{
    status='completed'; fileVersion=[string]$version.FileVersion; productVersion=[string]$version.ProductVersion
    company=[string]$version.CompanyName; description=[string]$version.FileDescription
    embeddedCertificate=$certificate; trustVerification='not_performed'; catalogSigning='not_inspected'
    limitations=@('Version metadata and embedded certificate extraction only; no chain validation, revocation lookup, target execution or network request')
} | ConvertTo-Json -Depth 5 -Compress
