import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AppProviders } from './lib';
import { PublicLibraryDocument } from './public-library/PublicLibraryDocument';
import { checkedPublicLibraryBootstrap } from './public-library/bootstrap';
import './styles.css';
import './public-library/public-library.css';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
const root = document.getElementById('root')!;
const bootstrap = document.getElementById('public-library-data');
if (bootstrap) {
  try {
    if (bootstrap.tagName !== 'SCRIPT' || bootstrap.getAttribute('type') !== 'application/json')
      throw new Error('Invalid library page.');
    const data = checkedPublicLibraryBootstrap(
      JSON.parse(bootstrap.textContent ?? ''),
      new URL(window.location.href),
    );
    ReactDOM.hydrateRoot(root, <PublicLibraryDocument data={data} />);
  } catch {
    ReactDOM.createRoot(root).render(
      <main className="public-library-main">
        <h1>The library page could not be loaded</h1>
        <p>Reload this page to try again.</p>
        <a
          className="button button-secondary"
          href={window.location.pathname + window.location.search}
        >
          Reload library page
        </a>
      </main>,
    );
  }
} else
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <BrowserRouter>
        <AppProviders>
          <App />
        </AppProviders>
      </BrowserRouter>
    </React.StrictMode>,
  );
