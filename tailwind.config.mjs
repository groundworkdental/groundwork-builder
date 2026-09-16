/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      // Colours are NOT here. Tailwind v4 reads them from the @theme block in
      // src/styles/tokens.css, alongside the per-context grounds.
      // Defining them here as rgb(var(--x) / <alpha-value>) is v3 syntax:
      // under v4 it compiles to `/ 1` and every opacity modifier silently
      // becomes fully opaque.
      fontFamily: {
        // TODO: Replace with practice fonts (update Google Fonts link in BaseLayout.astro)
        serif: ['Playfair Display', 'Georgia', 'serif'],
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
      },
    },
  },
};
