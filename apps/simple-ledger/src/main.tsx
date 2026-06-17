import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { LedgerProvider } from './state/store';
import { useServiceWorker } from '@snishi/foundation/pwa/useServiceWorker';
import '@snishi/foundation/ui/tokens.css';
import '@snishi/foundation/ui/foundation.css';
import '@snishi/foundation/ui/components.css';
import './ui/app-theme.css';
import './ui/app.css';

function PwaRegistrar() {
  useServiceWorker('./sw.js');
  return null;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ToastProvider>
      <LedgerProvider>
        <PwaRegistrar />
        <App />
      </LedgerProvider>
    </ToastProvider>
  </StrictMode>,
);
