# Política de assinatura de código — Ryke Desk

Esta página existe porque o programa **SignPath Foundation** exige que todo
projeto de código aberto que ele assina publique, de forma acessível, quem
pode aprovar uma assinatura e como o processo funciona. Não é burocracia: é o
que garante que ninguém consiga fazer o SignPath assinar um binário em nome do
Ryke Desk sem passar por uma pessoa responsável.

## O que é assinado

Somente o instalador do Ryke Desk para Windows — `RykeDesk-Setup-<versão>.exe`
— construído pelo GitHub Actions **a partir deste repositório público**. Nenhum
binário construído em máquina de desenvolvedor é assinado. A chave de
assinatura fica no HSM do SignPath Foundation; ninguém da equipe a possui, a
copia ou a manipula.

## Papéis

Conforme exigido pelo SignPath Foundation, o projeto define três papéis. Numa
equipe pequena, uma mesma pessoa pode acumular papéis, mas **quem aprova nunca
é a automação** — a aprovação final de cada release é sempre humana.

| Papel        | Responsabilidade                                                        |
|--------------|-------------------------------------------------------------------------|
| **Autor**    | Escreve o código e abre a versão a ser lançada (a tag `v<versão>`).      |
| **Revisor**  | Confere que o binário veio deste repositório, sem alteração fora dele.   |
| **Aprovador**| Aprova manualmente cada pedido de assinatura no painel do SignPath.      |

Neste projeto, os três papéis são exercidos pela mesma pessoa — o que o
SignPath permite, desde que a aprovação de cada release continue sendo um ato
humano e explícito:

- **Autor:** [@rykeguideiv](https://github.com/rykeguideiv)
- **Revisor:** [@rykeguideiv](https://github.com/rykeguideiv)
- **Aprovador:** [@rykeguideiv](https://github.com/rykeguideiv)

## Como uma assinatura acontece

1. Um Autor cria a tag `v<versão>` (ex.: `v1.0.17`) e a envia ao GitHub.
2. O GitHub Actions constrói o instalador **não assinado** e o envia ao
   SignPath (ver [`.github/workflows/release.yml`](../.github/workflows/release.yml)).
3. O SignPath segura o pedido até um **Aprovador** liberá-lo manualmente no
   painel deles.
4. Liberado, o SignPath assina e devolve o `.exe`; o Actions o publica na
   Release do GitHub. É esse arquivo assinado que as pessoas baixam.

## Autenticação

Todos os integrantes com acesso a este repositório e ao SignPath usam
**autenticação de dois fatores (MFA)**, também por exigência do SignPath
Foundation. Sem isso, roubar uma senha bastaria para pedir uma assinatura.

## Privacidade

O Ryke Desk não coleta dados de quem o usa. A imagem da tela, o teclado, o
mouse e os arquivos vão **direto e cifrados** de um computador ao outro; os
pontos de encontro repassam apenas bytes que não conseguem ler. A assinatura de
código cobre a integridade do instalador — provar que o `.exe` é o que este
repositório produziu — e nada mais.
