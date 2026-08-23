/**
 * Pilot 12.5 — figcaption rendering regression test.
 *
 * Regression: on the static (first-load) peak detail page, the preferred-view
 * figcaption rendered the literal text `<em>preferred</em>` because the
 * template interpolated a *string* into the markup
 * (`{viewKey === silhouette.preferred ? ' · <em>preferred</em>' : ''}`).
 * Astro escapes string expressions, so the built HTML contained
 * `&lt;em&gt;preferred&lt;/em&gt;` and visitors saw raw tag text on first load
 * (the JS view-switch path used innerHTML, so it was unaffected).
 *
 * Fix: the static figcaption now uses Astro expression-container fragments
 * (`{<> … </>}`) so a real <em> element is emitted instead of escaped text.
 *
 * This test pins the *template* (the source of the static render): it fails
 * if the interpolation ever regresses to a string expression containing
 * markup. It also pins the JS progressive-enhancement path, which builds the
 * figcaption with string concatenation + innerHTML and must keep emitting a
 * real <em> element.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, 'pages', 'peaks', '[id].astro');
const page = await readFile(pagePath, 'utf8');

test('static figcaption never interpolates markup as a string expression', () => {
  // The bug: a string literal containing '<em>' interpolated inside the
  // figcaption (Astro escapes it to &lt;em&gt; in the built HTML).
  assert.ok(
    !page.includes("'<em>"),
    'figcaption markup must not be interpolated as a string (it would be escaped in the built HTML)',
  );
  // The preferred-view marker must still be present and written as markup,
  // not as a string expression.
  assert.ok(
    page.includes('<em>preferred</em>'),
    'expected a real <em>preferred</em> element somewhere in the page template',
  );
});

test('static figcaption preferred marker is inside an expression-container fragment', () => {
  // Extract the <figcaption ...>...</figcaption> block(s) from the static
  // (non-JS) portion of the template — i.e. everything before the <script> tag.
  const template = page.slice(0, page.indexOf('<script'));
  const captions = [...template.matchAll(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/g)].map((m) => m[0]);
  assert.ok(captions.length >= 1, 'expected at least one figcaption in the static template');
  for (const c of captions) {
    if (c.includes('preferred')) {
      // A real <em> element, not escaped entities.
      assert.ok(c.includes('<em>preferred</em>'), `figcaption must emit a real <em> element: ${c}`);
      assert.ok(!c.includes('&lt;em&gt;'), `figcaption must not contain escaped entities: ${c}`);
    }
  }
});

test('JS view-switch path keeps emitting a real <em>preferred</em> element', () => {
  // The progressive-enhancement path builds the figcaption via string
  // concatenation and assigns it to panel.innerHTML. It must keep producing
  // an unescaped <em> element (innerHTML does not escape).
  const script = page.slice(page.indexOf('<script'));
  assert.ok(
    script.includes("' · <em>preferred</em>'") ||
      script.includes('" · <em>preferred</em>"'),
    'expected the JS view-switch path to keep building the preferred marker as markup',
  );
});
