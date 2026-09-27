import React from 'react';
import { createRoot } from 'react-dom/client';
import { PetApp } from './react/companion/PetApp';

const root = document.getElementById('pet-root');
if (root) {
  void window.i18n.load(navigator.language || 'zh-CN').then(() => {
    document.documentElement.lang = window.i18n.locale;
    createRoot(root).render(<React.StrictMode><PetApp /></React.StrictMode>);
  });
}
