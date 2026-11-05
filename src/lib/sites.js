export const API_ORIGIN = 'https://api.bilibili.com';
export const MEDIA_DOMAINS = ['bilivideo.com', 'bilivideo.cn'];
export const PAGE_HOSTS = ['www.bilibili.com', 'space.bilibili.com', 'm.bilibili.com', 'bilibili.com', 'b23.tv'];
const SOURCE_PARAMETERS = ['p', 'bvid', 'oid', 'type', 'ftype', 'business', 'business_id', 'sid', 'fid', 'season_id'];

export const HOST_PERMISSIONS = [
  ...PAGE_HOSTS.map((host) => `https://${host}/*`),
  `${API_ORIGIN}/*`,
  ...MEDIA_DOMAINS.map((domain) => `https://*.${domain}/*`),
];

export function sourceFromTab(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password ||
        !PAGE_HOSTS.includes(url.hostname)) return '';
    if (url.hostname === 'b23.tv') {
      if (!/^\/[\w-]+\/?$/.test(url.pathname)) return '';
    } else if (!/^\/(?:video\/|list\/|medialist\/(?:play|detail)\/|watchlater(?:\/|$)|\d+\/(?:favlist|lists|channel)(?:\/|$))/.test(url.pathname)) {
      return '';
    }

    url.protocol = 'https:';
    for (const key of [...url.searchParams.keys()]) {
      if (!SOURCE_PARAMETERS.includes(key)) url.searchParams.delete(key);
    }
    if (!/^#\/(?:av\d+|BV[\w]+)(?:\/p\d+)?\/?$/.test(url.hash)) url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export async function prepareRequests(api) {
  const id = 1;
  const initiator = new URL(api.runtime.getURL('/')).hostname;
  await api.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.bilibili.com/' }],
      },
      condition: {
        initiatorDomains: [initiator],
        requestDomains: [new URL(API_ORIGIN).hostname, ...MEDIA_DOMAINS],
        urlFilter: '|https://',
        resourceTypes: ['xmlhttprequest'],
        requestMethods: ['get', 'head'],
      },
    }],
  });
}
