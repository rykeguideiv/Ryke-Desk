# Repara um arquivo que sofreu round-trip errado de codificacao.
#
# Sintoma: acentos viraram pares de caracteres estranhos. Isso acontece quando
# bytes UTF-8 sao lidos como Latin-1 (cada byte vira um caractere) e depois
# regravados como UTF-8 - cada acento passa a ocupar o dobro.
#
# A correcao e o inverso exato: reduzir os caracteres a bytes pela tabela
# Latin-1 e reinterpretar esses bytes como UTF-8. Tambem remove o BOM.
#
# Este arquivo e deliberadamente ASCII puro: o PowerShell 5.1 le scripts .ps1
# como ANSI quando nao ha BOM, entao um literal acentuado aqui dentro
# quebraria o proprio reparador.
#
#   powershell -ExecutionPolicy Bypass -File build\reparar-encoding.ps1 "test\e2e.mjs"

param([Parameter(Mandatory = $true)][string]$Arquivo)

$ErrorActionPreference = 'Stop'

$utf8SemBom = [System.Text.UTF8Encoding]::new($false)
# Windows-1252, e NAO Latin-1 (28591): a corrupcao vem da pagina de codigo
# ANSI do Windows, que preenche a faixa 0x80-0x9F com travessao, aspas curvas
# e afins. Latin-1 nao tem esses caracteres e os perderia como "?".
$ansi = [System.Text.Encoding]::GetEncoding(1252)

$texto = [System.IO.File]::ReadAllText($Arquivo, $utf8SemBom)
$texto = $texto.TrimStart([char]0xFEFF)   # remove o BOM, se veio como caractere

# 0x00C3 e o "A-til" que abre quase toda sequencia mal decodificada (Ã),
# e 0x00E2 abre as aspas e travessoes (â). Sao a assinatura do problema.
$suspeito = ($texto.IndexOf([char]0x00C3) -ge 0) -or ($texto.IndexOf([char]0x00E2) -ge 0)

if ($suspeito) {
    $bytes = $ansi.GetBytes($texto)
    $corrigido = $utf8SemBom.GetString($bytes)
    [System.IO.File]::WriteAllText($Arquivo, $corrigido, $utf8SemBom)
    Write-Output "reparado: $Arquivo"
} else {
    [System.IO.File]::WriteAllText($Arquivo, $texto, $utf8SemBom)
    Write-Output "sem dupla codificacao; BOM removido: $Arquivo"
}
