import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './pwa';
import '@fontsource-variable/inter';
import '@fontsource/barlow-condensed/latin-700.css';
import './styles.css';
import './components/site.css';
import './feel';
import './feel.css';

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
