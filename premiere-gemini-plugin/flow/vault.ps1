param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    # Secrets arrive on stdin, never in process arguments, logs or temp files.
    $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Mode -eq 'protect') {
        $result = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
    } else {
        $result = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
    [Console]::Error.Write('Windows sessiya himoyasini ochib bo‘lmadi. Shu Windows akkauntida qayta ulang.')
    exit 1
}
