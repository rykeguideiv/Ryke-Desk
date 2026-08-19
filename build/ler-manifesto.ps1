# Extrai o manifesto embutido (RT_MANIFEST, tipo 24) de um executavel do
# Windows e imprime o nivel de execucao pedido.
#
# Existe porque procurar a string "requireAdministrator" no binario inteiro da
# falso positivo: o package.json vai dentro do asar e menciona justamente essa
# palavra. So o recurso RT_MANIFEST responde de verdade.
#
#   powershell -ExecutionPolicy Bypass -File build\ler-manifesto.ps1 "caminho.exe"

param([Parameter(Mandatory = $true)][string]$Exe)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Win32 -Name Res -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr FindResource(IntPtr hModule, IntPtr lpName, IntPtr lpType);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr LoadResource(IntPtr hModule, IntPtr hResInfo);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr LockResource(IntPtr hResData);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool FreeLibrary(IntPtr hModule);
'@

$LOAD_LIBRARY_AS_DATAFILE = 0x2
$RT_MANIFEST = [IntPtr]24
$CREATEPROCESS_MANIFEST_RESOURCE_ID = [IntPtr]1

$h = [Win32.Res]::LoadLibraryEx($Exe, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($h -eq [IntPtr]::Zero) { throw "nao consegui abrir $Exe" }

try {
    $info = [Win32.Res]::FindResource($h, $CREATEPROCESS_MANIFEST_RESOURCE_ID, $RT_MANIFEST)
    if ($info -eq [IntPtr]::Zero) {
        Write-Output 'SEM_MANIFESTO'
        exit 1
    }
    $tamanho = [Win32.Res]::SizeofResource($h, $info)
    $dados = [Win32.Res]::LockResource([Win32.Res]::LoadResource($h, $info))
    $bytes = New-Object byte[] $tamanho
    [System.Runtime.InteropServices.Marshal]::Copy($dados, $bytes, 0, $tamanho)
    $xml = [System.Text.Encoding]::UTF8.GetString($bytes)

    if ($xml -match 'level\s*=\s*"([^"]+)"') {
        Write-Output "NIVEL=$($Matches[1])"
    } else {
        Write-Output 'NIVEL=asInvoker (nao declarado)'
    }
    if ($xml -match 'uiAccess\s*=\s*"([^"]+)"') { Write-Output "uiAccess=$($Matches[1])" }
} finally {
    [void][Win32.Res]::FreeLibrary($h)
}
