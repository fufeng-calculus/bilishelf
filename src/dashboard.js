import { getMediaFormats, getMediaSource } from './lib/bilibili.js';
import { downloadMedia } from './lib/download.js';
import { describeVideo, qualityChoices, selectAudio, selectVideo } from './lib/quality.js';
import { HOST_PERMISSIONS, prepareRequests, sourceFromTab } from './lib/sites.js';

const jobStages = {
  queued: '等待中', resolving: '读取画质', downloading: '下载音视频', saving: '保存 MP4',
  complete: '已完成', failed: '下载失败', cancelling: '正在取消', cancelled: '已取消',
};
const terminalStages = new Set(['complete', 'failed', 'cancelled']);
const sourceKinds = {
  video: '单条视频', multipart: '分 P 视频', collection: '合集', series: '系列',
  favorites: '收藏夹', watchlater: '稍后再看', playlist: '播放列表',
};

function cleanName(value, limit = 145) {
  const cleaned = String(value || '视频')
    .replace(/[\\/:*?"<>|\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  const encoder = new TextEncoder();
  let name = '';
  let bytes = 0;
  for (const character of cleaned) {
    bytes += encoder.encode(character).length;
    if (bytes > limit) break;
    name += character;
  }
  return name.trim() || '视频';
}

function filenameFor(entry, video) {
  const title = entry.partTitle ? `${entry.title} - ${entry.partTitle}` : entry.title;
  const tag = cleanName(describeVideo(video), 28);
  const id = entry.bvid || `av${entry.aid}`;
  return `BiliShelf/${cleanName(title)} [${id} P${entry.part || 1}] [${tag}].mp4`;
}

function durationLabel(value) {
  const seconds = Math.floor(Number(value));
  if (!(seconds > 0)) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor(seconds % 3600 / 60)).padStart(2, '0');
  const rest = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

function byteLabel(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function safeCover(value) {
  try {
    const url = new URL(value);
    const imageHost = ['hdslb.com', 'biliimg.com'].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && imageHost
      ? url.href : '';
  } catch {
    return '';
  }
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function initDashboard({ api, readSource, readFormats, startFile, prepare, readTab, requestAccess }) {
  const $ = (selector) => document.querySelector(selector);
  const form = $('#source-form');
  const input = $('#source-url');
  const resolveButton = $('#resolve-button');
  const permissionButton = $('#permission-button');
  const sourceStatus = $('#source-status');
  const sourceView = $('#source-view');
  const selectAll = $('#entry-select-all');
  const entries = $('#entries');
  const qualitySelect = $('#quality-select');
  const qualityHelp = $('#quality-help');
  const queue = $('#queue');
  const start = $('#start-download');
  const clear = $('#queue-clear');
  const queueEmpty = $('#queue-empty');

  let source;
  let sourceRequest;
  let rows = [];
  const jobs = [];
  let pumping = false;

  function setSourceStatus(message, state = '') {
    sourceStatus.textContent = message;
    sourceStatus.dataset.state = state;
    sourceStatus.hidden = !message;
  }

  function showQualityChoices(formats) {
    const previous = qualitySelect.value;
    qualitySelect.replaceChildren();
    for (const choice of qualityChoices) {
      const option = new Option(choice.label, choice.value);
      if (formats && !selectVideo(formats, choice.value)) {
        option.disabled = true;
        option.textContent += ' · 当前视频不可用';
      }
      qualitySelect.append(option);
    }
    const existing = [...qualitySelect.options].find((option) => option.value === previous);
    if (existing && !existing.disabled) qualitySelect.value = previous;
    qualityHelp.textContent = formats
      ? '灰色选项表示 B 站未提供对应画质。HDR 以视频流实际分辨率为准。'
      : '批量下载按每条视频检查所选画质，遇到缺少的画质时会提示。';
  }

  function updateSelection() {
    const selected = rows.filter(({ check }) => check.checked).length;
    selectAll.checked = selected > 0 && selected === rows.length;
    selectAll.indeterminate = selected > 0 && selected < rows.length;
    selectAll.disabled = rows.length === 0;
    $('#selection-summary').textContent = `已选 ${selected} 项`;
    start.disabled = !selected || !qualitySelect.value || !!qualitySelect.selectedOptions[0]?.disabled;
  }

  function showSource(media) {
    source = media;
    sourceView.hidden = false;
    $('#source-title').textContent = media.title;
    $('#source-kind').textContent = sourceKinds[media.kind] || '播放列表';
    $('#source-description').textContent = media.truncated
      ? `本次显示前 ${media.entries.length} 项` : `共 ${media.entries.length} 项，可勾选后批量下载`;
    $('#entry-count').textContent = String(media.entries.length);
    const cover = $('#source-cover');
    const poster = safeCover(media.cover || media.entries[media.currentIndex || 0]?.cover);
    if (poster) cover.src = poster;
    else cover.removeAttribute('src');
    cover.hidden = !poster;
    if (media.entries.length) {
      const allRows = document.createDocumentFragment();
      rows = media.entries.map((entry, index) => {
        const fragment = $('#entry-template').content.cloneNode(true);
        const check = fragment.querySelector('.entry-check');
        const title = entry.partTitle || entry.title || entry.bvid;
        check.checked = media.entries.length === 1 || index === (media.currentIndex ?? 0);
        check.setAttribute('aria-label', `选择 ${title}`);
        check.addEventListener('change', updateSelection);
        fragment.querySelector('.entry-index').textContent = String(index + 1).padStart(2, '0');
        fragment.querySelector('.entry-title').textContent = title;
        fragment.querySelector('.entry-duration').textContent = durationLabel(entry.duration);
        const status = fragment.querySelector('.entry-status');
        status.textContent = '待检查画质';
        allRows.append(fragment);
        return { entry, check, status };
      });
      entries.replaceChildren(allRows);
    }
    showQualityChoices();
    updateSelection();
  }

  function resetSource({ clearInput = false } = {}) {
    sourceRequest?.abort();
    sourceRequest = undefined;
    resolveButton.disabled = false;
    sourceView.hidden = true;
    entries.replaceChildren();
    $('#source-cover').removeAttribute('src');
    rows = [];
    source = undefined;
    if (clearInput) input.value = '';
    setSourceStatus('');
    updateSelection();
  }

  async function resolveSource() {
    const value = input.value.trim();
    if (!value) {
      setSourceStatus('请先粘贴 B 站视频或列表链接。', 'error');
      input.focus();
      return;
    }
    resetSource();
    const controller = new AbortController();
    sourceRequest = controller;
    const { signal } = controller;
    resolveButton.disabled = true;
    setSourceStatus('正在解析 B 站链接…', 'loading');
    try {
      const ready = await prepare();
      signal.throwIfAborted();
      permissionButton.hidden = ready;
      if (!ready) {
        setSourceStatus('请授予 B 站站点权限后重新解析。', 'error');
        return;
      }
      const media = await readSource(value, { signal });
      signal.throwIfAborted();
      if (!media.entries.length) throw new Error('这个列表中没有可解析的视频。');
      showSource(media);
      setSourceStatus(media.truncated ? '列表较长，当前只显示已读取的项目。' : '');
      const row = rows[media.currentIndex] ?? rows[0];
      try {
        const firstFormats = await readFormats(row.entry, { signal });
        signal.throwIfAborted();
        const best = selectVideo(firstFormats, 'auto');
        row.status.textContent = best ? `可用至 ${describeVideo(best)}` : '没有可下载的音视频流';
        if (rows.length === 1) {
          showQualityChoices(firstFormats);
          if (!best) qualityHelp.textContent = 'B 站没有返回可保存为 MP4 的视频流。';
          else if (!selectVideo(firstFormats, '4k-sdr') && !selectVideo(firstFormats, '4k-hdr')) {
            qualityHelp.textContent = 'B 站未返回可用的 4K 流。可确认网页上的登录状态和播放器画质，再重新解析。';
          }
          updateSelection();
        }
      } catch (error) {
        if (signal.aborted) return;
        row.status.textContent = '入队后重试';
        setSourceStatus(errorMessage(error, '暂时无法读取视频画质。'), 'error');
      }
    } catch (error) {
      if (signal.aborted) return;
      setSourceStatus(errorMessage(error, '链接解析失败，请检查后重试。'), 'error');
    } finally {
      if (sourceRequest === controller) {
        sourceRequest = undefined;
        resolveButton.disabled = false;
      }
    }
  }

  function renderJob(job) {
    job.element.dataset.state = job.state;
    job.status.textContent = jobStages[job.state];
    job.detail.textContent = job.message || job.label;
    job.cancel.hidden = terminalStages.has(job.state);
    job.cancel.disabled = job.state === 'cancelling';
    if (job.state === 'complete') job.progress.value = 100;
    else if (job.state === 'queued') job.progress.value = 0;
    else if (!terminalStages.has(job.state) && job.total > 0) {
      job.progress.value = Math.min(99, 100 * job.received / job.total);
    } else if (!terminalStages.has(job.state)) job.progress.removeAttribute('value');
  }

  function renderQueue() {
    $('#queue-count').textContent = String(jobs.length);
    queueEmpty.hidden = jobs.length > 0;
    clear.hidden = !jobs.some((job) => terminalStages.has(job.state));
  }

  function cancelJob(job) {
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.message = '已从队列取消';
    } else if (!terminalStages.has(job.state)) {
      job.state = 'cancelling';
      job.controller.abort();
    }
    renderJob(job);
    renderQueue();
  }

  function addJob(row, preference) {
    const { entry } = row;
    const key = `${entry.bvid || entry.aid}/${entry.cid || entry.part || 1}/${preference}`;
    if (jobs.some((job) => job.key === key && !terminalStages.has(job.state))) return;
    const fragment = $('#queue-template').content.cloneNode(true);
    const job = {
      key, entry, preference, row, state: 'queued',
      label: qualityChoices.find((choice) => choice.value === preference).label,
      element: fragment.firstElementChild,
      status: fragment.querySelector('.job-status'),
      detail: fragment.querySelector('.job-detail'),
      progress: fragment.querySelector('.job-progress'),
      cancel: fragment.querySelector('.job-cancel'),
    };
    const title = entry.partTitle || entry.title || entry.bvid;
    fragment.querySelector('.job-title').textContent = title;
    job.progress.setAttribute('aria-label', `${title} 下载进度`);
    job.cancel.setAttribute('aria-label', `取消 ${title} 的下载`);
    job.cancel.addEventListener('click', () => cancelJob(job));
    jobs.push(job);
    renderJob(job);
    queue.append(fragment);
  }

  async function runJob(job) {
    job.controller = new AbortController();
    const { signal } = job.controller;
    job.state = 'resolving';
    renderJob(job);
    try {
      const ready = await prepare();
      signal.throwIfAborted();
      if (!ready) throw new Error('缺少 B 站站点权限，请先授权再试。');
      const formats = await readFormats(job.entry, { signal });
      signal.throwIfAborted();
      const video = selectVideo(formats, job.preference);
      if (!video) {
        const best = selectVideo(formats, 'auto');
        job.row.status.textContent = best ? `可用至 ${describeVideo(best)}` : '没有可用视频流';
        const available = best ? `当前最高可用画质为 ${describeVideo(best)}。` : '';
        throw new Error(`B 站未返回所选画质的视频流。${available}`);
      }
      const audio = video.progressive ? undefined : selectAudio(formats);
      const codec = video.codec?.split('.')[0]?.toUpperCase();
      job.label = [describeVideo(video), codec].filter(Boolean).join(' · ');
      job.row.status.textContent = job.label;
      job.state = 'downloading';
      renderJob(job);
      const result = await startFile({
        video: video.urls,
        audio: audio?.urls,
        progressive: video.progressive,
        filename: filenameFor(formats.entry ?? job.entry, video),
        signal,
        api,
        onProgress(progress) {
          if (signal.aborted) return;
          job.state = progress.stage === 'saving' ? 'saving' : 'downloading';
          job.received = progress.received;
          job.total = progress.total;
          const bytes = progress.received > 0 ? byteLabel(progress.received) : '';
          job.message = bytes ? `${job.label} · ${bytes}${progress.total ? ` / ${byteLabel(progress.total)}` : ''}` : '';
          renderJob(job);
        },
      });
      job.state = 'complete';
      job.message = `${job.label} · ${result?.simulated ? '模拟任务完成' : '已保存至浏览器下载目录'}`;
    } catch (error) {
      job.state = signal.aborted ? 'cancelled' : 'failed';
      job.message = signal.aborted ? '下载已取消' : errorMessage(error, '下载中断，请重新加入队列。');
    } finally {
      renderJob(job);
      renderQueue();
    }
  }

  async function pumpQueue() {
    if (pumping) return;
    pumping = true;
    window.addEventListener('beforeunload', protectQueue);
    try {
      let next = jobs.find((job) => job.state === 'queued');
      while (next) {
        await runJob(next);
        next = jobs.find((job) => job.state === 'queued');
      }
    } finally {
      pumping = false;
      window.removeEventListener('beforeunload', protectQueue);
    }
  }

  function protectQueue(event) {
    event.preventDefault();
    event.returnValue = true;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void resolveSource();
  });
  $('#source-reset').addEventListener('click', () => {
    resetSource({ clearInput: true });
    input.focus();
  });
  $('#use-tab').addEventListener('click', async () => {
    try {
      const url = await readTab();
      if (!url) {
        setSourceStatus('这个窗口里没有可识别的 B 站视频或列表标签页。', 'error');
        return;
      }
      resetSource();
      input.value = url;
      input.focus();
      setSourceStatus('已带入 B 站链接，点击「解析链接」继续。');
    } catch {
      setSourceStatus('无法读取当前标签页。你也可以手动粘贴链接。', 'error');
    }
  });
  permissionButton.addEventListener('click', async () => {
    try {
      if (!await requestAccess()) {
        setSourceStatus('你也可以在浏览器的扩展设置中授予 B 站站点权限。', 'error');
        return;
      }
      permissionButton.hidden = true;
      await resolveSource();
    } catch {
      setSourceStatus('请在浏览器的扩展设置中恢复 B 站站点权限，再重新解析。', 'error');
    }
  });
  selectAll.addEventListener('change', () => {
    for (const row of rows) row.check.checked = selectAll.checked;
    updateSelection();
  });
  qualitySelect.addEventListener('change', updateSelection);
  start.addEventListener('click', () => {
    if (!source || start.disabled) return;
    for (const row of rows) {
      if (row.check.checked) addJob(row, qualitySelect.value);
    }
    renderQueue();
    void pumpQueue();
  });
  clear.addEventListener('click', () => {
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      if (!terminalStages.has(jobs[index].state)) continue;
      jobs[index].element.remove();
      jobs.splice(index, 1);
    }
    renderQueue();
  });

  input.value = new URL(location.href).searchParams.get('url') || '';
  showQualityChoices();
  updateSelection();
  renderQueue();
}

const api = globalThis.browser ?? globalThis.chrome;
if (api?.runtime?.getManifest) {
  initDashboard({
    api,
    readSource: getMediaSource,
    readFormats: getMediaFormats,
    startFile: downloadMedia,
    async prepare() {
      if (!await api.permissions.contains({ origins: HOST_PERMISSIONS })) return false;
      await prepareRequests(api);
      return true;
    },
    async readTab() {
      const tabs = await api.tabs.query({ currentWindow: true });
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return tabs.map((tab) => sourceFromTab(tab.url || tab.pendingUrl)).find(Boolean);
    },
    requestAccess: () => api.permissions.request({ origins: HOST_PERMISSIONS }),
  });
}
