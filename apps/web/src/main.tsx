import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PageBoundary } from './components/ErrorBoundary';
import { watchForErrors } from './reportError';
import { registerServiceWorker } from './pwa';
import { watchForNewBuild } from './freshness';
import '@fontsource-variable/inter';
import '@fontsource/barlow-condensed/latin-700.css';
import './styles.css';
import './components/site.css';
import './feel.css';

watchForErrors();
registerServiceWorker();
watchForNewBuild();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PageBoundary>
      <App />
    </PageBoundary>
  </StrictMode>,
);
