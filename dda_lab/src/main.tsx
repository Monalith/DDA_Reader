import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

import { useLab } from './state/store';
// debugging hook: inspect the store from the browser console
(window as unknown as { __lab: typeof useLab }).__lab = useLab;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
