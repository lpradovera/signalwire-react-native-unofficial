import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

// Note what is absent: no polyfills import, no platform adapter. In a browser
// the SDK uses native globals, which is the whole point of @signalwire/react
// being platform-agnostic.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
