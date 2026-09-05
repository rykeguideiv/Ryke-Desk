/**
 * O ajudante, rodando de verdade — só que sem elevação.
 *
 * A elevação muda QUEM pode injetar, não COMO a ordem viaja. Para descobrir se
 * uma ordem se perde ou chega fora de ordem no cano, este processo serve
 * exatamente como o de produção: é o mesmo `rodarComoAjudante`.
 */
import { rodarComoAjudante } from '../../src/main/ajudante.ts';

rodarComoAjudante(process.argv[2]);
