# Uma janela que se mexe sozinha, só para dar o que capturar durante a medida.
#
# Sem isto a prova mediria uma tela PARADA — e a Desktop Duplication, por
# desenho, não entrega quadro nenhum quando nada muda. O resultado seria
# "0 quadros/s" e a conclusão errada de que a captura não funciona.
param([int]$Segundos = 12)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Ryke — medindo captura'
$form.Size = New-Object System.Drawing.Size(520, 360)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::Black

$x = 0
$passo = 17
$cores = @([System.Drawing.Color]::Red, [System.Drawing.Color]::Lime, [System.Drawing.Color]::Cyan,
           [System.Drawing.Color]::Yellow, [System.Drawing.Color]::Magenta)

# Redesenha o mais rápido que der: é isso que produz quadros para capturar.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 8
$timer.Add_Tick({ $script:x = ($script:x + $passo) % 500; $form.Invalidate() })

$form.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    for ($i = 0; $i -lt 5; $i++) {
        $cor = $cores[($i + [int]($script:x / 40)) % 5]
        $pincel = New-Object System.Drawing.SolidBrush $cor
        $g.FillRectangle($pincel, ($script:x + $i * 60) % 460, 30 + $i * 55, 50, 45)
        $pincel.Dispose()
    }
})

$fim = New-Object System.Windows.Forms.Timer
$fim.Interval = $Segundos * 1000
$fim.Add_Tick({ $timer.Stop(); $fim.Stop(); $form.Close() })

$form.Add_Shown({ $timer.Start(); $fim.Start() })
[void]$form.ShowDialog()
