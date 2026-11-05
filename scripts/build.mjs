import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ORIGIN, HOST_PERMISSIONS, MEDIA_DOMAINS, PAGE_HOSTS } from '../src/lib/sites.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src');
const output = join(root, 'dist');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const icons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));
const connectionOrigins = [
  API_ORIGIN, ...PAGE_HOSTS.map((host) => `https://${host}`),
  ...MEDIA_DOMAINS.map((domain) => `https://*.${domain}:*`),
];

const manifest = {
  manifest_version: 3,
  name: '哔哩下载台 · BiliShelf',
  version,
  description: '批量保存 B 站视频、分 P 与合集。按原画质下载可播放的 SDR/HDR 视频，在本机合并音视频为 MP4。',
  icons,
  action: { default_title: '打开哔哩下载台', default_icon: icons },
  permissions: ['activeTab', 'downloads', 'declarativeNetRequestWithHostAccess'],
  host_permissions: HOST_PERMISSIONS,
  content_security_policy: {
    extension_pages: [
      "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
      "frame-ancestors 'none'", `connect-src 'self' ${connectionOrigins.join(' ')}`,
      "img-src 'self' https://*.hdslb.com https://*.biliimg.com",
    ].join('; '),
  },
};

const targets = {
  chrome: {
    minimum_chrome_version: '120',
    background: { service_worker: 'background.js', type: 'module' },
  },
  firefox: {
    background: { page: 'background.html' },
    browser_specific_settings: {
      gecko: {
        id: 'bilishelf@hong.addons',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['browsingActivity', 'websiteContent'] },
      },
    },
  },
};

async function listFiles(dir, parent = '') {
  const files = [];
  for (const entry of (await readdir(dir)).sort()) {
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    const relative = join(parent, entry);
    if ((await stat(path)).isDirectory()) files.push(...await listFiles(path, relative));
    else files.push(relative);
  }
  return files;
}

await mkdir(output, { recursive: true });
const stamp = new Date('2025-01-01T00:00:00Z');
for (const [browser, fields] of Object.entries(targets)) {
  const dir = join(output, browser);
  const archive = join(output, `bilishelf-${browser}-${version}.zip`);
  await rm(dir, { recursive: true, force: true });
  await cp(source, dir, { recursive: true, filter: (path) => !path.endsWith('/.DS_Store') });
  if (browser === 'chrome') await rm(join(dir, 'background.html'), { force: true });
  await cp(join(root, 'LICENSE'), join(dir, 'LICENSE'));
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({ ...manifest, ...fields }, null, 2)}\n`);
  const files = await listFiles(dir);
  for (const file of files) await utimes(join(dir, file), stamp, stamp);
  await rm(archive, { force: true });
  execFileSync('zip', ['-q', '-X', archive, ...files], { cwd: dir, env: { ...process.env, TZ: 'UTC' } });
  console.log(`Built dist/${browser}/ and dist/bilishelf-${browser}-${version}.zip`);
}
