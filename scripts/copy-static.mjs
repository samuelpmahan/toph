// tsc does not copy non-.ts assets. The viewer ships one static HTML page that must
// land next to its compiled server module in dist/ so startReplayViewer can read it
// with a path relative to import.meta.url at runtime.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(repoRoot, 'src', 'viewer', 'static', 'index.html');
const destDir = join(repoRoot, 'dist', 'viewer', 'static');
const dest = join(destDir, 'index.html');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
console.log(`copied ${src} -> ${dest}`);
