import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const previewClient = new URL('./preview-client.js', import.meta.url);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const port = Number(process.env.BILISHELF_PREVIEW_PORT || 4173);

createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const page = path === '/' ? '/dashboard.html' : path;
    const file = resolve(root, `.${page}`);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !types[extname(file)]) {
      response.writeHead(404).end();
      return;
    }
    let body = await readFile(page === '/preview-client.js' ? previewClient : file);
    if (page === '/dashboard.html') {
      body = body.toString('utf8')
        .replace('src="dashboard.js"', 'src="preview-client.js"')
        .replace('<span class="brand-english" lang="en">BiliShelf</span>',
          '<span class="brand-english" lang="en">BiliShelf · 本地预览</span>');
    }
    response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`BiliShelf UI preview (sample media only): http://127.0.0.1:${port}/`);
});
