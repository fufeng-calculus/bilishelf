import { isMediaUrl } from "./bilibili.js";
import { copyProgressiveMp4, muxDash } from "./mp4.js";

const CONNECT_TIMEOUT = 12_000;
const READ_TIMEOUT = 25_000;
const MEDIA_REFERER = "https://www.bilibili.com/";
const integer = (value) => /^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value));

async function withTimeout(controller, delay, run) {
  const timer = setTimeout(() => controller.abort(new Error("视频 CDN 响应超时")), delay);
  try {
    return await run();
  } finally {
    clearTimeout(timer);
  }
}

function readRange(response, offset) {
  if (response.status === 200 && offset === 0) {
    const length = response.headers.get("Content-Length");
    const total = integer(length) ? Number(length) : null;
    return { end: total, total };
  }
  if (response.status !== 206) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
  if (!match || !match.slice(1).every(integer)) return null;
  const [start, last, total] = match.slice(1).map(Number);
  return start === offset && last >= start && last < total ? { end: last + 1, total } : null;
}

async function connect(urls, offset, expectedTotal, signal) {
  let reason = "没有可用的媒体链接";
  for (const url of urls) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response;
    try {
      response = await withTimeout(controller, CONNECT_TIMEOUT, () => fetch(url, {
        headers: { Range: `bytes=${offset}-` },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrer: MEDIA_REFERER,
        signal: requestSignal,
      }));
      const range = readRange(response, offset);
      if (range && response.body && (!response.url || isMediaUrl(response.url)) &&
          (expectedTotal === null || range.total === expectedTotal) && range.total !== 0) {
        return { ...range, controller, reader: response.body.getReader() };
      }
      reason = `HTTP ${response.status}`;
    } catch {
      signal?.throwIfAborted();
      reason = controller.signal.aborted ? "响应超时" : "网络连接失败";
    }
    controller.abort();
  }
  throw new Error(`无法连接视频 CDN（${reason}）`);
}

async function cdnStream(candidates, signal, onBytes) {
  const urls = [...new Set(candidates.filter((url) => isMediaUrl(url)))];
  let connection = await connect(urls, 0, null, signal);
  const { total } = connection;
  let received = 0;

  const close = () => {
    connection.controller.abort();
  };
  const stream = new ReadableStream({
    async pull(sink) {
      try {
        signal?.throwIfAborted();
        let chunk = await withTimeout(connection.controller, READ_TIMEOUT, () => connection.reader.read());
        if (chunk.done && connection.end === received && received < total) {
          connection.reader.releaseLock();
          connection = await connect(urls, received, total, signal);
          chunk = await withTimeout(connection.controller, READ_TIMEOUT, () => connection.reader.read());
        }
        if (chunk.done) {
          if (total !== null && received !== total) throw new Error("媒体下载中断，文件不完整");
          connection.reader.releaseLock();
          sink.close();
          return;
        }
        received += chunk.value.length;
        if (connection.end !== null && received > connection.end) {
          throw new Error("媒体响应与请求范围不一致");
        }
        onBytes(chunk.value.length);
        sink.enqueue(chunk.value);
      } catch (error) {
        close();
        sink.error(signal?.aborted ? signal.reason : error);
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });

  return { stream, total, close };
}

async function saveFile(file, filename, signal, { downloads }) {
  signal?.throwIfAborted();
  const url = URL.createObjectURL(file);
  try {
    const id = await downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    await new Promise((resolve, reject) => {
      function finish(state, error) {
        if (state !== "complete" && state !== "interrupted") return;
        downloads.onChanged.removeListener(onChange);
        signal?.removeEventListener("abort", cancel);
        if (state === "complete") resolve();
        else reject(signal?.aborted ? signal.reason : new Error(`浏览器未能保存文件（${error ?? "下载中断"}）`));
      }
      function onChange(delta) {
        if (delta.id === id) finish(delta.state?.current, delta.error?.current);
      }
      function cancel() {
        downloads.cancel(id).then(() => finish("interrupted"), () => {});
      }
      downloads.onChanged.addListener(onChange);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      // Small files can complete before download() resolves.
      downloads.search({ id }).then(([item]) => finish(item?.state, item?.error), () => {});
    });
    return id;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadMedia({
  video, audio, filename, signal, progressive = false, onProgress = () => {},
  api = globalThis.browser ?? globalThis.chrome,
}) {
  signal?.throwIfAborted();
  if (!globalThis.navigator?.storage?.getDirectory) {
    throw new Error("此浏览器环境无法写入下载所需的临时文件");
  }

  const root = await navigator.storage.getDirectory();
  const scratch = await root.getDirectoryHandle("bld-downloads", { create: true });
  const tempName = `${crypto.randomUUID()}.mp4`;
  const file = await scratch.getFileHandle(tempName, { create: true });
  let writable;
  let videoInput;
  let audioInput;
  let received = 0;
  let total = null;
  let lastProgress = -Infinity;
  const update = (stage) => onProgress({ stage, received, total });
  const onBytes = (size) => {
    received += size;
    const now = performance.now();
    if (now - lastProgress >= 100) {
      lastProgress = now;
      update("downloading");
    }
  };
  try {
    writable = await file.createWritable();
    update("downloading");
    videoInput = await cdnStream(video, signal, onBytes);
    if (!progressive && audio?.length) audioInput = await cdnStream(audio, signal, onBytes);
    if (videoInput.total !== null && (!audioInput || audioInput.total !== null)) {
      total = videoInput.total + (audioInput?.total ?? 0);
    }
    const assemble = progressive ? copyProgressiveMp4 : muxDash;
    await assemble({
      video: videoInput.stream,
      audio: audioInput?.stream,
      write: (bytes) => writable.write(bytes),
      signal,
    });
    signal?.throwIfAborted();
    update("saving");
    await writable.close();
    writable = null;
    return await saveFile(await file.getFile(), filename, signal, api);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.name === "QuotaExceededError") {
      throw new Error("临时存储空间不足，无法保存该视频", { cause: error });
    }
    throw error;
  } finally {
    videoInput?.close();
    audioInput?.close();
    await writable?.abort().catch(() => {});
    await scratch.removeEntry(tempName).catch(() => {});
  }
}
