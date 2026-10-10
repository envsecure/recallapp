/// <reference types="vite/client" />

// Side-effect CSS imports are handled by Vite at build time; TypeScript needs
// this declaration to accept `import './App.css'`. It lives here rather than in
// a .tsx file because a module augmentation inside a module is an error.
declare module '*.css';