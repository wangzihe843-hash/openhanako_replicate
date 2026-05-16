import React from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './react/mobile/MobileApp';
import './react/mobile/MobileApp.css';

const root = document.getElementById('root');
if (!root) throw new Error('mobile root not found');

createRoot(root).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[mobile] service worker registration failed:', err);
    });
  });
}
