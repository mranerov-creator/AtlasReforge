import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.jsx';

// Global reset — minimal, no CSS framework dependency
const style = document.createElement('style');
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #f9fafb; color: #111827; }
  button { font-family: inherit; }
  input, select, textarea { font-family: inherit; }
  .deprecated-api-highlight { background: rgba(239,68,68,0.15); border-bottom: 2px wavy #ef4444; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root !== null) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
