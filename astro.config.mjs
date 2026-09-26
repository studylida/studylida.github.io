// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkKoreanEmphasis from './src/plugins/remark-korean-emphasis.mjs';
import remarkCallouts from './src/plugins/remark-callouts.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://studylida.github.io',
  integrations: [tailwind(), sitemap()],
  markdown: {
    remarkPlugins: [remarkMath, remarkKoreanEmphasis, remarkCallouts],
    rehypePlugins: [rehypeKatex],
  },
});