import { resolve } from 'node:path';
import { createPublisher } from '../server/publisher.mjs';

const root = resolve(process.env.BLOG_ROOT ?? process.cwd());
await createPublisher({ root, distDir: resolve(root, process.env.BLOG_DIST_DIR ?? 'dist') })();
console.log('Build verified and published successfully.');
