import { sourceFromTab } from './lib/sites.js';

const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener(async (tab) => {
  const dashboard = new URL(api.runtime.getURL('dashboard.html'));
  const url = sourceFromTab(tab.url || tab.pendingUrl);
  if (url) dashboard.searchParams.set('url', url);
  await api.tabs.create({ url: dashboard.href, windowId: tab.windowId });
});
