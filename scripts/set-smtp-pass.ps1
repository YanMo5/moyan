param()
$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
if (-not (Test-Path $envFile)) { throw ".env not found: $envFile" }

Write-Host 'QQ 邮箱 SMTP 授权码（输入时不会显示）' -ForegroundColor Cyan
$secure = Read-Host -AsSecureString 'SMTP_PASS'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if (-not $code) { throw '授权码为空，未修改 .env' }

$content = Get-Content $envFile -Raw
if ($content -notmatch '(?m)^SMTP_PASS=') {
    $content = $content.TrimEnd() + "`r`nSMTP_PASS=" + $code + "`r`n"
} else {
    $content = [regex]::Replace($content, '(?m)^SMTP_PASS=.*$', 'SMTP_PASS=' + $code)
}
Set-Content -Path $envFile -Value $content -Encoding UTF8
Write-Host '.env updated. Restart the server, then test the contact form.' -ForegroundColor Green
