import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './ui/toast';
import { LedgerProvider } from './state/store';
import './ui/tokens.css';
import './ui/app.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ToastProvider>
      <LedgerProvider>
        <App />
      </LedgerProvider>
    </ToastProvider>
  </StrictMode>,
);
