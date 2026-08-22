// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
// Host-neutral static output: no adapter, no deployment-provider integration.
// The build emits a plain static site into ./dist that any static file host
// can serve. See README.md ("Hosting") and docs/architecture.md.
export default defineConfig({
  output: 'static',
});
