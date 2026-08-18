// tsc does not copy non-.ts assets. The viewer ships one static HTML page that must
// land next to its compiled server module in dist/ so startReplayViewer can read it
// with a path relative to import.meta.url at runtime.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(repoRoot, 'src', 'viewer', 'static');
const destDir = join(repoRoot, 'dist', 'viewer', 'static');

await mkdir(destDir, { recursive: true });
for (const file of ['index.html', 'viewer.js']) {
  await copyFile(join(srcDir, file), join(destDir, file));
  console.log(`copied ${join(srcDir, file)} -> ${join(destDir, file)}`);
}
