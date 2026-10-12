import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';
import { reportClientError } from './net/GameClient';

window.addEventListener('unhandledrejection', e => { console.error('[gilli] unhandled promise rejection', e.reason); reportClientError(e.reason, 'promise'); });
window.addEventListener('error', e => reportClientError(e.error ?? e.message, 'window'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
