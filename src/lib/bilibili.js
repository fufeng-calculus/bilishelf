import { API_ORIGIN, MEDIA_DOMAINS } from './sites.js';

const SITE = 'https://www.bilibili.com';
const BVID = /^BV[0-9A-Za-z]{10}$/;
const MAX_LIST_PAGES = 200;

const WBI_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
];
const MD5_SHIFTS = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
const MD5_CONSTANTS = Array.from({ length: 64 }, (_, i) => Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))));
const QUALITY_LABELS = {
  6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P 60fps',
  80: '1080P', 112: '1080P 高码率', 116: '1080P 60fps',
  120: '4K SDR', 125: 'HDR10', 126: '杜比视界', 127: '8K SDR', 129: 'HDR Vivid',
};

function md5(value) {
  const bytes = new TextEncoder().encode(value);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const input = new DataView(padded.buffer);
  input.setUint32(padded.length - 8, bytes.length * 8, true);
  input.setUint32(padded.length - 4, Math.floor(bytes.length / 2 ** 29), true);

  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i += 1) {
      let bits, word;
      if (i < 16) {
        bits = (b & c) | (~b & d);
        word = i;
      } else if (i < 32) {
        bits = (d & b) | (~d & c);
        word = (5 * i + 1) % 16;
      } else if (i < 48) {
        bits = b ^ c ^ d;
        word = (3 * i + 5) % 16;
      } else {
        bits = c ^ (b | ~d);
        word = (7 * i) % 16;
      }
      const sum = (a + bits + MD5_CONSTANTS[i] + input.getUint32(offset + 4 * word, true)) | 0;
      const shift = MD5_SHIFTS[Math.floor(i / 16)][i % 4];
      [a, b, c, d] = [d, (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0, b, c];
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
  }
  const result = new DataView(new ArrayBuffer(16));
  state.forEach((word, i) => result.setUint32(4 * i, word, true));
  return Array.from(new Uint8Array(result.buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// WBI hashes the sorted, form-encoded parameters plus the shuffled key from /nav.
function signedParams(params, key) {
  const query = new URLSearchParams();
  Object.entries({ ...params, wts: Math.floor(Date.now() / 1000) }).forEach(([name, value]) => {
    query.set(name, String(value).replace(/[!'()*]/g, ''));
  });
  query.sort();
  query.set('w_rid', md5(query.toString() + key));
  return query;
}

class BilibiliError extends Error {
  constructor(code, detail) {
    const messages = {
      [-101]: '请先在浏览器中登录哔哩哔哩。',
      [-403]: '当前账号没有访问权限，或哔哩哔哩限制了请求。',
      [-404]: '视频或列表不存在，或已被移除。',
      [-412]: '哔哩哔哩暂时限制了请求，请稍后再试。',
      [-352]: '哔哩哔哩要求验证，请打开原页面完成验证后重试。',
      [62002]: '视频暂不可见，请检查原页面。',
    };
    super(messages[code] || `哔哩哔哩请求失败（${code}）${detail && detail !== '0' ? ` · ${detail}` : ''}`);
    this.code = code;
  }
}

async function request(path, params, signal, acceptLoggedOut = false) {
  const url = new URL(path, API_ORIGIN);
  url.search = new URLSearchParams(params).toString();
  let response;
  try {
    response = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'error', signal });
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    throw new Error('无法连接哔哩哔哩，请检查网络后重试。', { cause: error });
  }
  if (!response.ok) throw new BilibiliError(-response.status);
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    throw new Error('哔哩哔哩返回了无法读取的响应。', { cause: error });
  }
  if (payload?.code !== 0 && !(acceptLoggedOut && payload?.code === -101)) {
    throw new BilibiliError(payload?.code ?? '响应异常', payload?.message);
  }
  return payload.data;
}

let wbiCache;
async function getWbiKey(signal) {
  if (wbiCache && wbiCache.expires > Date.now()) return wbiCache.key;
  const nav = await request('/x/web-interface/nav', {}, signal, true);
  const filenames = [nav?.wbi_img?.img_url, nav?.wbi_img?.sub_url].map((url) => {
    return typeof url === 'string' ? url.match(/\/([0-9a-f]{32})\.[a-z0-9]+(?:\?|$)/i)?.[1] : null;
  });
  if (filenames.some((name) => !name)) throw new Error('暂时无法取得哔哩哔哩的播放签名。');
  const pair = filenames.join('');
  const key = WBI_ORDER.map((index) => pair[index]).join('');
  wbiCache = { key, expires: Date.now() + 5 * 60 * 1000 };
  return key;
}

function digits(value) {
  const id = String(value ?? '');
  return /^[1-9]\d{0,17}$/.test(id) ? id : null;
}

function videoId(value) {
  const id = String(value ?? '');
  return BVID.test(id) ? id : null;
}

function titleText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function flag(value) {
  return value === true || value === 1 || value === '1';
}

function webUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function belongsTo(hostname, domains) {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function isMediaUrl(value) {
  const url = webUrl(value);
  return Boolean(url && url.protocol === 'https:' && belongsTo(url.hostname, MEDIA_DOMAINS));
}

function coverUrl(value) {
  const url = webUrl(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.port
      || !belongsTo(url.hostname, ['hdslb.com', 'biliimg.com'])) return '';
  url.protocol = 'https:';
  return url.href;
}

function entryFromVideo(arc, { bvid, aid, cid, part = 1, title, partTitle, duration } = {}) {
  bvid = videoId(bvid ?? arc.bvid ?? arc.bv_id);
  aid = digits(aid ?? arc.aid);
  if (!bvid && !aid) return null;
  const suffix = part > 1 ? `?p=${part}` : '';
  const id = bvid ?? `av${aid}`;
  return {
    bvid, aid, cid: digits(cid), part,
    title: titleText(title) || titleText(arc.title) || id,
    partTitle: titleText(partTitle),
    duration: Number(duration ?? arc.duration) || 0,
    cover: coverUrl(arc.pic || arc.cover),
    url: `${SITE}/video/${id}/${suffix}`,
  };
}

function videoPages(data) {
  const pages = Array.isArray(data.pages) && data.pages.length ? data.pages : [{ cid: data.cid, page: 1 }];
  return pages.map((page, index) => entryFromVideo(data, {
    cid: page.cid, part: Number(digits(page.page) ?? index + 1),
    partTitle: pages.length > 1 ? page.part : '',
    duration: page.duration,
  })).filter((entry) => entry?.cid);
}

function playlistItems(item) {
  if (item.pages?.length) {
    return videoPages({ ...item, bvid: item.bvid ?? item.bv_id, aid: item.aid ?? item.id });
  }
  return entryFromVideo(item, { aid: item.aid ?? item.id });
}

function uniqueEntries(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const key = `${item.bvid ?? item.aid}:${item.cid ?? item.part}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function videoDetails(id, signal) {
  const data = await request('/x/web-interface/view', id, signal);
  if (!data || !videoId(data.bvid)) throw new Error('未找到可用的视频资料。');
  return data;
}

function viewSource(data, part) {
  const pages = videoPages(data);
  const season = data.ugc_season;
  const episodes = (season?.sections ?? []).flatMap((section) => section.episodes ?? []);
  const collection = episodes.length > 1;
  let entries = pages;
  if (collection) {
    entries = uniqueEntries(episodes.flatMap((episode) => {
      if (episode.bvid === data.bvid || (episode.aid && episode.aid === data.aid)) return pages;
      const item = { ...episode.arc, bvid: episode.bvid, aid: episode.aid, title: episode.title || episode.arc?.title };
      if (episode.pages?.length) return videoPages({ ...item, pages: episode.pages });
      return entryFromVideo(item, {
        cid: episode.cid ?? episode.page?.cid, part: Number(digits(episode.page?.page) ?? 1),
        duration: episode.page?.duration,
      });
    }));
    if (!entries.some((entry) => entry.bvid === data.bvid)) entries.unshift(...pages);
  }
  return {
    title: titleText(collection ? season.title : data.title) || data.bvid,
    kind: collection ? 'collection' : pages.length > 1 ? 'multipart' : 'video',
    entries,
    cover: coverUrl((collection && season.cover) || data.pic),
    currentIndex: Math.max(0, entries.findIndex((entry) => entry.bvid === data.bvid && entry.part === part)),
  };
}

async function numberedList(path, params, { kind, pageSize, itemsKey, pageKey, sizeKey, signal }) {
  const items = [];
  let title = '';
  let cover = '';
  let hasMore = true;
  let page = 1;
  while (hasMore && page <= MAX_LIST_PAGES) {
    const data = await request(path, { ...params, [pageKey]: page, [sizeKey]: pageSize }, signal);
    const batch = data?.[itemsKey] ?? [];
    const metadata = data?.meta ?? data?.info;
    title ||= titleText(metadata?.name ?? metadata?.title);
    cover ||= coverUrl(metadata?.cover);
    items.push(...batch);
    const total = data?.page?.total ?? metadata?.media_count;
    const size = Number(data?.page?.page_size ?? data?.page?.size) || pageSize;
    hasMore = batch.length > 0 && (data?.has_more ?? page * size < Number(total ?? 0));
    page += 1;
  }
  const entries = uniqueEntries(items.filter((item) => {
    return kind !== 'favorites' || (Number(item.type) === 2 && !(Number(item.attr) & 2));
  }).flatMap(playlistItems));
  return { title, cover, kind, entries, truncated: Boolean(hasMore) };
}

async function collectionSource(kind, mid, id, signal) {
  const options = { kind, pageSize: 30, itemsKey: 'archives', signal };
  if (kind === 'collection') {
    return numberedList('/x/polymer/web-space/seasons_archives_list', { mid, season_id: id }, {
      ...options, pageKey: 'page_num', sizeKey: 'page_size',
    });
  }
  const source = await numberedList('/x/series/archives', { mid, series_id: id }, {
    ...options, pageKey: 'pn', sizeKey: 'ps',
  });
  try {
    const { meta } = await request('/x/series/series', { series_id: id }, signal);
    source.title = titleText(meta?.name) || source.title;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return source;
}

async function favoritesSource(id, signal) {
  return numberedList('/x/v3/fav/resource/list', { media_id: id, platform: 'web' }, {
    kind: 'favorites', pageSize: 20, itemsKey: 'medias', pageKey: 'pn', sizeKey: 'ps', signal,
  });
}

async function watchLaterSource(signal) {
  const data = await request('/x/v2/history/toview/web', {}, signal);
  return { title: '稍后再看', kind: 'watchlater', entries: uniqueEntries((data?.list ?? []).flatMap(playlistItems)) };
}

function sourceUrl(value) {
  const input = String(value ?? '').trim();
  const rawId = input.match(/^(BV[0-9A-Za-z]{10}|av[1-9]\d{0,17})$/)?.[1];
  const schemeless = /^(?:(?:www|m|space)\.)?bilibili\.com\/|^b23\.tv\//i.test(input);
  const url = webUrl(rawId ? `${SITE}/video/${rawId}/` : schemeless ? `https://${input}` : input);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.port) {
    throw new Error('请输入哔哩哔哩视频或播放列表的完整链接。');
  }
  return url;
}

async function expandShortUrl(url, signal) {
  const shortCode = url.pathname.match(/^\/([0-9A-Za-z_-]{1,32})\/?$/)?.[1];
  if (!shortCode) return url;
  if (videoId(shortCode) || /^av[1-9]\d{0,17}$/.test(shortCode)) {
    return new URL(`/video/${shortCode}/${url.search}`, SITE);
  }

  // The extension's connect-src policy restricts every hop to known Bilibili origins.
  let response;
  try {
    response = await fetch(`https://b23.tv/${shortCode}`, {
      method: 'HEAD', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    });
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    throw new Error('无法展开 B 站短链接，请打开短链接后复制完整地址。', { cause: error });
  }
  const destination = webUrl(response.url);
  if (!destination || destination.protocol !== 'https:' || destination.port
      || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'space.bilibili.com'].includes(destination.hostname)) {
    throw new Error('无法展开 B 站短链接，请打开短链接后复制完整地址。');
  }
  return destination;
}

function parseSource(url) {
  const path = url.pathname.replace(/\/+$/, '');
  const params = url.searchParams;
  const watchEntry = url.hash.match(/^#\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,17})(?:\/p(\d+))?\/?$/);
  const current = {
    bvid: videoId(params.get('bvid') ?? watchEntry?.[1]),
    aid: digits(params.get('oid') ?? watchEntry?.[1]?.slice(2)),
    part: Number(digits(params.get('p') ?? watchEntry?.[2]) ?? 1),
  };
  if (url.hostname === 'space.bilibili.com') {
    const modern = path.match(/^\/(\d+)\/lists\/(\d+)$/);
    const legacy = path.match(/^\/(\d+)\/channel\/(collectiondetail|seriesdetail)$/);
    if (modern) return { kind: params.get('type') === 'series' ? 'series' : 'collection', mid: modern[1], id: modern[2], current };
    if (legacy && digits(params.get('sid'))) {
      return { kind: legacy[2] === 'seriesdetail' ? 'series' : 'collection', mid: legacy[1], id: params.get('sid'), current };
    }
    if (/^\/\d+\/favlist$/.test(path) && digits(params.get('fid'))) {
      if (params.get('ftype') === 'collect') return { kind: 'collection', mid: '0', id: params.get('fid'), current };
      return { kind: 'favorites', id: params.get('fid'), current };
    }
  }
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
    const video = path.match(/^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,17})$/)?.[1];
    if (video) return { kind: 'video', id: video, current };
    if (/^\/(?:list|medialist\/play|medialist\/detail)\/ml[1-9]\d*$/.test(path)) {
      return { kind: 'favorites', id: path.split('/').at(-1).slice(2), current };
    }
    if (/^\/(?:list\/|medialist\/play\/)?watchlater$/.test(path)) return { kind: 'watchlater', current };
    const mid = path.match(/^\/(?:list|medialist\/play)\/(\d+)$/)?.[1];
    const season = digits(params.get('season_id'));
    const businessId = digits(params.get('business_id'));
    if (mid && (season || (params.get('business') === 'space_collection' && businessId))) {
      return { kind: 'collection', mid, id: season ?? businessId, current };
    }
    const series = digits(params.get('sid')) ?? (params.get('business') === 'space_series' ? businessId : null);
    if (mid && series) return { kind: 'series', mid, id: series, current };
  }
  throw new Error('暂未识别此链接。可使用投稿视频、分 P、合集、系列、收藏夹和稍后再看页面。');
}

export async function getMediaSource(value, { signal } = {}) {
  const url = sourceUrl(value);
  const { kind, mid, id, current } = parseSource(url.hostname === 'b23.tv' ? await expandShortUrl(url, signal) : url);
  if (kind === 'video') {
    const data = await videoDetails(videoId(id) ? { bvid: id } : { aid: id.slice(2) }, signal);
    return viewSource(data, current.part);
  }
  let source;
  if (kind === 'favorites') source = await favoritesSource(id, signal);
  else if (kind === 'watchlater') source = await watchLaterSource(signal);
  else source = await collectionSource(kind, mid, id, signal);
  source.title ||= { favorites: '收藏夹', collection: '合集', series: '系列' }[kind];
  const matchesVideo = (entry) => (current.bvid && entry.bvid === current.bvid) || (current.aid && entry.aid === current.aid);
  const matchingPart = source.entries.findIndex((entry) => matchesVideo(entry) && current.part === entry.part);
  source.currentIndex = matchingPart < 0 ? Math.max(0, source.entries.findIndex(matchesVideo)) : matchingPart;
  return source;
}

function streamUrls(stream) {
  const backups = stream.backupUrl ?? stream.backup_url;
  const urls = [stream.baseUrl, stream.base_url, stream.url, ...(Array.isArray(backups) ? backups : [])];
  return [...new Set(urls.filter(isMediaUrl).map((url) => webUrl(url).href))];
}

function rangeFor(quality) {
  if (quality === 126) return 'dolby';
  return quality === 125 || quality === 129 ? 'hdr' : 'sdr';
}

function frameRate(value) {
  const [numerator, denominator = 1] = String(value ?? '').split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function representation(stream) {
  const quality = Number(stream.id);
  const width = Number(stream.width) || 0;
  const height = Number(stream.height) || 0;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const resolution = longEdge >= 7680 || shortEdge >= 4320 ? '8K'
    : longEdge >= 3840 || shortEdge >= 2160 ? '4K'
      : shortEdge >= 1080 ? '1080P' : shortEdge ? `${shortEdge}P` : '';
  const range = rangeFor(quality);
  const codec = titleText(stream.codecs);
  const fps = frameRate(stream.frameRate ?? stream.frame_rate);
  const bandwidth = Number(stream.bandwidth) || 0;
  const label = range !== 'sdr'
    ? [resolution, QUALITY_LABELS[quality]].filter(Boolean).join(' ')
    : ['4K', '8K'].includes(resolution) ? `${resolution} SDR`
      : [120, 127].includes(quality) ? [resolution, 'SDR'].filter(Boolean).join(' ')
        : QUALITY_LABELS[quality] ?? (resolution || `Q${quality}`);
  return {
    id: `${quality}:${codec}:${width}x${height}:${fps}:${bandwidth}`,
    quality, label, codec, width, height, fps, range, resolution, bandwidth,
    urls: streamUrls(stream),
  };
}

function parsePlayData(play) {
  if (flag(play.is_preview) || flag(play.is_drm) || flag(play.drm)
      || ['preview', 'PLAY_PREVIEW'].includes(play.play_video_type)) {
    throw new Error('此视频只提供试看或受 DRM 保护。');
  }
  const video = (play.dash?.video ?? []).filter((stream) => !flag(stream.is_drm)).map(representation)
    .filter((stream) => stream.urls.length);
  const audio = (play.dash?.audio ?? []).filter((stream) => !flag(stream.is_drm)).map((stream) => ({
    id: String(stream.id), codec: titleText(stream.codecs),
    bandwidth: Number(stream.bandwidth) || 0, urls: streamUrls(stream),
  })).filter((stream) => stream.urls.length);
  const progressive = [];
  if (play.format === 'mp4' && play.durl?.length === 1 && !flag(play.durl[0].is_drm)) {
    const quality = Number(play.quality);
    const urls = streamUrls(play.durl[0]);
    if (urls.length) progressive.push({
      id: `mp4:${quality}`, quality, label: QUALITY_LABELS[quality] ?? `Q${quality}`,
      range: 'sdr', urls,
    });
  }
  const provided = new Set([...video, ...progressive].map((stream) => stream.quality));
  const unavailable = (play.support_formats ?? []).filter((format) => !provided.has(Number(format.quality)))
    .map((format) => ({
      quality: Number(format.quality),
      label: QUALITY_LABELS[format.quality] ?? titleText(format.new_description ?? format.display_desc),
    }));
  return { video, audio, progressive, unavailable };
}

export async function getMediaFormats(entry, { signal } = {}) {
  const bvid = videoId(entry?.bvid);
  const aid = digits(entry?.aid);
  if (!bvid && !aid) throw new Error('缺少有效的视频编号。');
  const data = await videoDetails(bvid ? { bvid } : { aid }, signal);
  if (flag(data.is_upower_preview) || (flag(data.is_upower_exclusive) && !flag(data.is_upower_play))) {
    throw new Error('当前账号只可试看此视频。');
  }
  const pages = videoPages(data);
  const cid = digits(entry.cid);
  const selected = cid ? pages.find((page) => page.cid === cid) : pages.find((page) => page.part === Number(entry.part ?? 1));
  if (!selected) throw new Error('该分 P 暂无可用的播放流。');
  const playParams = { bvid: data.bvid, cid: selected.cid, fnver: 0, fourk: 1 };
  const key = await getWbiKey(signal);
  const path = '/x/player/wbi/playurl';
  const play = await request(path, signedParams({ ...playParams, fnval: 4048 }, key), signal);
  const formats = parsePlayData(play ?? {});
  if (!formats.video.length && !formats.progressive.length) {
    const fallback = await request(path, signedParams({ ...playParams, fnval: 1 }, key), signal);
    const { progressive } = parsePlayData(fallback ?? {});
    if (!progressive.length) throw new Error('当前视频没有可用的下载流，请检查原页面的播放权限。');
    formats.progressive = progressive;
    const provided = new Set(progressive.map((format) => format.quality));
    formats.unavailable = formats.unavailable.filter((format) => !provided.has(format.quality));
  }
  return { ...formats, entry: selected };
}
