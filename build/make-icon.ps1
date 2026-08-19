# Gera build/icon.ico a partir de build/logo-original.png, sem dependencias
# externas. Usa System.Drawing para redimensionar e monta o cabecalho ICO
# a mao (um diretorio de PNGs embutidos, que e o formato que o Windows 10+
# aceita e comprime bem).
#
#   powershell -ExecutionPolicy Bypass -File build\make-icon.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$raiz = Split-Path $PSScriptRoot -Parent
$origem = Join-Path $PSScriptRoot 'logo-original.png'
$destIco = Join-Path $PSScriptRoot 'icon.ico'
$destPng = Join-Path $PSScriptRoot 'icon.png'

$tamanhos = @(16, 24, 32, 48, 64, 128, 256)
$logo = [System.Drawing.Image]::FromFile($origem)

function Resize-ToPng([System.Drawing.Image]$img, [int]$lado) {
    $bmp = New-Object System.Drawing.Bitmap $lado, $lado
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($img, 0, 0, $lado, $lado)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $ms.ToArray()
}

# PNGs em cada tamanho
$pngs = @{}
foreach ($t in $tamanhos) { $pngs[$t] = Resize-ToPng $logo $t }
$logo.Dispose()

# Salva o PNG 256 avulso (usado pelo instalador e atalhos)
[System.IO.File]::WriteAllBytes($destPng, $pngs[256])

# Monta o ICO: cabecalho (6) + N entradas (16 cada) + os PNGs
$contagem = $tamanhos.Count
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

$bw.Write([UInt16]0)          # reservado
$bw.Write([UInt16]1)          # tipo 1 = icone
$bw.Write([UInt16]$contagem)  # quantidade

$deslocamento = 6 + $contagem * 16
foreach ($t in $tamanhos) {
    $dados = $pngs[$t]
    $lado = if ($t -ge 256) { 0 } else { $t }   # 0 significa 256 no formato ICO
    $bw.Write([Byte]$lado)     # largura
    $bw.Write([Byte]$lado)     # altura
    $bw.Write([Byte]0)         # cores da paleta
    $bw.Write([Byte]0)         # reservado
    $bw.Write([UInt16]1)       # planos
    $bw.Write([UInt16]32)      # bits por pixel
    $bw.Write([UInt32]$dados.Length)
    $bw.Write([UInt32]$deslocamento)
    $deslocamento += $dados.Length
}
# Cast explicito: sem ele o PowerShell escolhe a sobrecarga Write(char) e
# grava um unico byte em vez do array inteiro.
foreach ($t in $tamanhos) { $bw.Write([byte[]]$pngs[$t], 0, $pngs[$t].Length) }

$bw.Flush()
[System.IO.File]::WriteAllBytes($destIco, $ms.ToArray())
$bw.Dispose()

Write-Output "icone gerado: $destIco ($((Get-Item $destIco).Length) bytes, $contagem tamanhos)"
