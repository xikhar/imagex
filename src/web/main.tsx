import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './ui/App.js';
import { installImagexSessionFetch } from './client/sessionFetch.js';

document.documentElement.classList.add('dark');
installImagexSessionFetch();

// Disable browser context menu globally (app uses its own context menus)
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

createRoot(document.getElementById('root')!).render(<App />);
