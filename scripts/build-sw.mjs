// Post-build: stamp src/sw-template.js with the real precache list and a version
// derived from the built bytes, then write docs/sw.js.
//
// The version is a hash of the shipped files, NOT a timestamp: rebuilding with no
// source changes produces an identical worker, so players are never nagged to
// "update" to a byte-identical build.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCS = join(ROOT, 'docs');
const TEMPLATE = join(ROOT, 'src', 'sw-template.js');

// Everything a cold, offline start needs. Source maps and the worker itself are
// deliberately excluded — maps are dev-only weight, and caching sw.js would let
// a stale worker resurrect itself.
const EXCLUDE = /(\.map$|^sw\.js$|^\.nojekyll$)/;

const walk = async (dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
};

const files = (await walk(DOCS))
  .map((f) => relative(DOCS, f).split(sep).join('/'))
  .filter((f) => !EXCLUDE.test(f))
  .sort();

if (!files.includes('index.html')) {
  throw new Error('build-sw: docs/index.html missing — run vite build first');
}

// hash the bytes of every precached file so the version tracks real content
const hash = createHash('sha256');
for (const f of files) {
  hash.update(f);
  hash.update(await readFile(join(DOCS, f)));
}
const version = hash.digest('hex').slice(0, 12);

const precache = ['./', ...files.map((f) => `./${f}`)];

const template = await readFile(TEMPLATE, 'utf8');
// replaceAll, and assert exactly one site each: a stray placeholder in a comment
// would be rewritten too, and injecting a multi-line array into a // comment
// silently produces a worker that fails to evaluate (registration then throws).
for (const token of ['__VERSION__', '__PRECACHE__']) {
  const hits = template.split(token).length - 1;
  if (hits !== 1) throw new Error(`build-sw: ${token} appears ${hits}× in the template, expected exactly 1`);
}
const sw = template
  .replaceAll('__VERSION__', version)
  .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));

// a worker that does not parse is worse than no worker: registration throws and
// the app silently loses offline support, so fail the build instead
new Function(sw.replace(/\bself\b/g, 'globalThis'));   // throws on a syntax error
await writeFile(join(DOCS, 'sw.js'), sw);

const bytes = (await Promise.all(files.map(async (f) => (await stat(join(DOCS, f))).size)))
  .reduce((a, b) => a + b, 0);
console.log(`sw.js  version ${version}  ${files.length} files precached  ${(bytes / 1024).toFixed(0)} KB`);
