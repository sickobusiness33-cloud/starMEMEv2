import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/live.css';
import './styles/views.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('HootRadar: #root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
