import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled variable fonts (served from the build, so the UI looks the same offline).
import '@fontsource-variable/inter';
import '@fontsource-variable/sora';
import '@fontsource-variable/jetbrains-mono';
import './styles/theme.css';
import './styles/components.css';
import './styles/layout.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
