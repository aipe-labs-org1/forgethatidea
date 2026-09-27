import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import '@forge/shared/tokens.css';
import './styles/global.css';
import { App } from './App.js';
import { LandingPage } from './components/LandingPage.js';
import { CheckoutReturn } from './components/CheckoutReturn.js';
import { AccountPage } from './components/AccountPage.js';

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/app', element: <App /> },
  { path: '/checkout/return', element: <CheckoutReturn /> },
  { path: '/account', element: <AccountPage /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
