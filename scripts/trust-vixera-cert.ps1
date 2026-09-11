# Trust the Vixera AI code-signing certificate on THIS Windows machine.
#
# Run in an elevated PowerShell (Run as administrator):
#   powershell -ExecutionPolicy Bypass -File trust-vixera-cert.ps1
#
# After this, a Vixera One installer signed with the matching key shows
# "Vixera AI" instead of "Unknown publisher" on this machine. It changes
# nothing on anyone else's PC — for that you need a CA-issued certificate
# (see docs/installers.md).
#
# Undo:
#   Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\TrustedPublisher |
#     Where-Object { $_.Subject -like '*Vixera AI*' } | Remove-Item

$ErrorActionPreference = 'Stop'
$cert = Join-Path $PSScriptRoot 'vixera-ai-codesign.crt'

if (-not (Test-Path $cert)) { throw "vixera-ai-codesign.crt not found next to this script" }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this in an elevated PowerShell (Run as administrator)"
}

# Root makes the chain valid; TrustedPublisher stops the prompt for software
# already signed by it.
foreach ($store in 'Root', 'TrustedPublisher') {
    Import-Certificate -FilePath $cert -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
    Write-Host "imported into LocalMachine\$store"
}

$thumb = (Get-PfxCertificate -FilePath $cert).Thumbprint
Write-Host ""
Write-Host "Vixera AI certificate trusted on this machine (thumbprint $thumb)."
Write-Host "Re-download or re-run the installer: the publisher now reads Vixera AI."
