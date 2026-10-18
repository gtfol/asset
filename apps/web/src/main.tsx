document.documentElement.dataset.theme = localStorage.getItem('asset-theme') ?? 'light';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
