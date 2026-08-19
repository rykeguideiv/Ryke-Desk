/**
 * Imagens da marca, importadas para o Vite empacotá-las como assets do próprio
 * app. Ficam na origem local (file://), então passam pela CSP `img-src 'self'`
 * sem precisar virar data URI gigante.
 */
import logoUrl from './logo.png';
import fundoUrl from './fundo.png';

export { logoUrl, fundoUrl };
