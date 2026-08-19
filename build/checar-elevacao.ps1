# Diz se um processo esta rodando elevado, consultando o token dele.
#
# Metodos indiretos (tentar ler MainModule, por exemplo) dao resposta ambigua;
# TokenElevation e a fonte da verdade do proprio Windows.
#
#   powershell -ExecutionPolicy Bypass -File build\checar-elevacao.ps1 "Ryke Desk"

param([Parameter(Mandatory = $true)][string]$NomeProcesso)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Win32 -Name Tok -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
[DllImport("advapi32.dll", SetLastError=true)]
public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
[DllImport("advapi32.dll", SetLastError=true)]
public static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass,
    out uint TokenInformation, uint TokenInformationLength, out uint ReturnLength);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr hObject);
'@

$PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
$TOKEN_QUERY = 0x0008
$TokenElevation = 20

$processos = @(Get-Process -Name $NomeProcesso -ErrorAction SilentlyContinue)
if ($processos.Count -eq 0) {
    Write-Output "NAO_ENCONTRADO"
    exit 1
}

foreach ($p in $processos) {
    $h = [Win32.Tok]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, $p.Id)
    if ($h -eq [IntPtr]::Zero) {
        Write-Output "PID $($p.Id): sem permissao para consultar (indicio de elevado)"
        continue
    }
    $token = [IntPtr]::Zero
    if ([Win32.Tok]::OpenProcessToken($h, $TOKEN_QUERY, [ref]$token)) {
        $elevado = 0
        $tam = 0
        if ([Win32.Tok]::GetTokenInformation($token, $TokenElevation, [ref]$elevado, 4, [ref]$tam)) {
            Write-Output "PID $($p.Id): $(if ($elevado -ne 0) { 'ELEVADO' } else { 'comum' })"
        } else {
            Write-Output "PID $($p.Id): falha ao ler o token"
        }
        [void][Win32.Tok]::CloseHandle($token)
    } else {
        Write-Output "PID $($p.Id): token inacessivel (indicio de elevado)"
    }
    [void][Win32.Tok]::CloseHandle($h)
}
