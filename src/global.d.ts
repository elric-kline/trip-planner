// TypeScript has no built-in knowledge of CSS imports; Next.js's bundler
// handles them at build time. This ambient declaration just satisfies the
// type checker for `import "./globals.css"` style side-effect imports.
declare module "*.css";
