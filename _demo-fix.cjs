const fs = require('fs');
const f = 'ryke-sistema/nativo/demo/demo.cpp';
let s = fs.readFileSync(f, 'utf8');
function troca(de, para, rotulo) {
  const p = s.split(de);
  if (p.length !== 2) throw new Error(`"${rotulo}": ${p.length - 1} ocorrencia(s)`);
  s = p.join(para);
  console.log('ok  ' + rotulo);
}

// ── O desenho nao pode limitar a medida da CAPTURA ──
troca(
  `// POR QUE GDI PARA DESENHAR
//
// StretchDIBits e lento perto do que a GPU faria, e de proposito: quem esta
// sendo medido e a CAPTURA, nao o desenho. Usar Direct2D aqui deixaria o
// programa mais bonito e a medida menos honesta, porque parte do custo ficaria
// escondida no caminho grafico.`,
  `// POR QUE O DESENHO E SEPARADO DA MEDIDA
//
// A primeira versao deste demo redesenhava a cada quadro capturado, e o
// numero no titulo caiu para ~32 q/s — enquanto a captura pura media 57,7.
// A diferenca nao era da captura: era o StretchDIBits escalando 1920x1080 no
// processador, sessenta vezes por segundo. O demo estava medindo o proprio
// desenho e chamando aquilo de taxa de captura.
//
// Agora o laco captura o mais rapido que da, mas so REDESENHA umas 30 vezes
// por segundo — o olho nao distingue mais que isso numa previa. O titulo mostra
// os dois numeros, porque esconder um deles seria dar a entender que a captura
// e mais lenta do que ela e.`,
  'comentario do desenho',
);

troca(
  `int g_contados = 0;
double g_taxa = 0.0;
ULONGLONG g_marca = 0;
int g_perdas = 0;`,
  `int g_contados = 0;
double g_taxa = 0.0;
int g_pintados = 0;
double g_taxaPintura = 0.0;
ULONGLONG g_marca = 0;
ULONGLONG g_ultimaPintura = 0;
int g_perdas = 0;`,
  'contadores separados',
);

// Titulo so com ASCII: SetWindowTextA com bytes UTF-8 sai como "â€"".
troca(
  `  snprintf(titulo, sizeof(titulo),
           "RykeCaptura nativa  —  %.1f quadros/s  —  %ux%u  —  %s%s", g_taxa, g_largura, g_altura,
           elevado ? "ELEVADO (administrador)" : "normal",
           g_perdas > 0 ? "  [recriou a captura]" : "");`,
  `  // Só ASCII: SetWindowTextA recebe bytes, e um traco longo em UTF-8 vira
  // "â€"" na barra de titulo.
  snprintf(titulo, sizeof(titulo),
           "RykeCaptura nativa | captura %.1f q/s | previa %.1f q/s | %ux%u | %s%s", g_taxa,
           g_taxaPintura, g_largura, g_altura, elevado ? "ELEVADO (administrador)" : "normal",
           g_perdas > 0 ? " | recriou a captura" : "");`,
  'titulo em ascii com as duas taxas',
);

troca(
  `        g_contados++;
        InvalidateRect(janela, nullptr, FALSE);`,
  `        g_contados++;
        // Redesenha no maximo ~30 vezes por segundo. Capturar e desenhar sao
        // custos separados, e amarrar um ao outro faria o desenho ditar a taxa.
        const ULONGLONG t = GetTickCount64();
        if (t - g_ultimaPintura >= 33) {
          g_ultimaPintura = t;
          g_pintados++;
          InvalidateRect(janela, nullptr, FALSE);
        }`,
  'pintura desacoplada',
);

troca(
  `      g_taxa = g_contados * 1000.0 / (double)(agora - g_marca);
      g_contados = 0;`,
  `      g_taxa = g_contados * 1000.0 / (double)(agora - g_marca);
      g_taxaPintura = g_pintados * 1000.0 / (double)(agora - g_marca);
      g_contados = 0;
      g_pintados = 0;`,
  'taxa de pintura',
);

fs.writeFileSync(f, s);
console.log('demo.cpp corrigido');
