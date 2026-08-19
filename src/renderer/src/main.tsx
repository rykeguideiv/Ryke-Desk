import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

// Sem StrictMode de propósito: a dupla montagem de efeitos abriria duas
// conexões WebSocket com o servidor, e a segunda derrubaria a primeira.
createRoot(document.getElementById('root')!).render(<App />);
