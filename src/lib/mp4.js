// Merge single-track ISO BMFF streams by relocating their fragments. Keep the
// sample descriptions and media payloads intact, including HDR metadata.
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const PADDING = new Set(["free", "skip", "wide"]);
const FRAGMENT_METADATA = new Set(["sidx", "ssix", "styp", "mfra", "prft", "emsg"]);
const typeAt = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const dataView = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function invalid(detail) {
  throw new Error(`媒体格式不受支持（${detail}）`);
}

function boxHeader(bytes, start = 0) {
  const view = dataView(bytes);
  const size32 = view.getUint32(start);
  const headerSize = size32 === 1 ? 16 : 8;
  const size = size32 === 1 ? Number(view.getBigUint64(start + 8)) : size32;
  if (!Number.isSafeInteger(size) || size < headerSize) invalid("MP4 区块长度无效");
  return {
    type: typeAt(bytes, start + 4),
    start,
    payload: start + headerSize,
    size,
    end: start + size,
  };
}

function boxes(bytes, start, end = bytes.length) {
  const result = [];
  while (start < end) {
    if (end - start < 8) invalid("MP4 元数据不完整");
    const box = boxHeader(bytes, start);
    if (box.end > end) invalid("MP4 区块超出范围");
    result.push(box);
    start = box.end;
  }
  return result;
}

function only(list, type) {
  const found = list.filter((box) => box.type === type);
  if (found.length !== 1) invalid(`需要一个 ${type} 区块`);
  return found[0];
}

function createBox(type, parts) {
  const bytes = new Uint8Array(8 + parts.reduce((size, part) => size + part.length, 0));
  dataView(bytes).setUint32(0, bytes.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function version(bytes, box) {
  const value = bytes[box.payload];
  if (value !== 0 && value !== 1) invalid(`${box.type} 版本无效`);
  return value;
}

class StreamReader {
  constructor(stream, signal) {
    this.reader = stream.getReader();
    this.signal = signal;
    this.chunk = new Uint8Array();
    this.position = 0;
  }

  async fill() {
    this.signal?.throwIfAborted();
    while (!this.chunk.length) {
      const { value, done } = await this.reader.read();
      this.signal?.throwIfAborted();
      if (done) return false;
      this.chunk = value;
    }
    return true;
  }

  async consume(length, write) {
    while (length > 0) {
      if (!await this.fill()) throw new Error("媒体下载中断，文件不完整");
      const size = Math.min(this.chunk.length, length);
      if (write) await write(this.chunk.subarray(0, size));
      this.chunk = this.chunk.subarray(size);
      this.position += size;
      length -= size;
    }
  }

  async read(length) {
    if (length > MAX_METADATA_BYTES) invalid("MP4 元数据过大");
    const bytes = new Uint8Array(length);
    let offset = 0;
    await this.consume(length, (part) => {
      bytes.set(part, offset);
      offset += part.length;
    });
    return bytes;
  }

  async header(allowOpenEnded = false) {
    if (!await this.fill()) return null;
    const offset = this.position;
    let raw = await this.read(8);
    const size = dataView(raw).getUint32(0);
    if (size === 0 && allowOpenEnded) return { type: typeAt(raw, 4), size: null, raw, offset };
    if (size === 1) {
      const large = new Uint8Array(16);
      large.set(raw);
      large.set(await this.read(8), 8);
      raw = large;
    }
    return { ...boxHeader(raw), raw, offset };
  }

  async readBox(header) {
    if (header.size > MAX_METADATA_BYTES) invalid("MP4 元数据过大");
    const bytes = new Uint8Array(header.size);
    bytes.set(header.raw);
    bytes.set(await this.read(header.size - header.raw.length), header.raw.length);
    return bytes;
  }

  async close() {
    await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
  }
}

function readMediaParts(moov, trackParts, handler) {
  const mdia = only(trackParts, "mdia");
  const mediaParts = boxes(moov, mdia.payload, mdia.end);
  const hdlr = only(mediaParts, "hdlr");
  if (handler && typeAt(moov, hdlr.payload + 8) !== handler) invalid("音视频轨道类型不匹配");
  const minf = only(mediaParts, "minf");
  const stbl = only(boxes(moov, minf.payload, minf.end), "stbl");
  const stsd = only(boxes(moov, stbl.payload, stbl.end), "stsd");
  const entries = boxes(moov, stsd.payload + 8, stsd.end);
  if (!entries.length || entries.some((entry) => ["encv", "enca", "enct", "encs"].includes(entry.type))) {
    invalid("加密或空白的轨道");
  }
  return mediaParts;
}

async function readTrack(reader, handler) {
  let ftyp;
  let moov;
  while (!moov) {
    const box = await reader.header();
    if (!box) invalid("缺少 MP4 初始化区块");
    if (box.type === "ftyp") ftyp = await reader.readBox(box);
    else if (box.type === "moov") moov = await reader.readBox(box);
    else if (PADDING.has(box.type) || box.type === "sidx") {
      await reader.consume(box.size - box.raw.length);
    } else invalid("预期为 DASH MP4");
  }
  if (!ftyp) invalid("缺少 ftyp 区块");

  const movie = boxHeader(moov);
  const parts = boxes(moov, movie.payload);
  if (parts.some((part) => part.type === "pssh")) invalid("加密的 MP4");
  const mvhd = only(parts, "mvhd");
  const trak = only(parts, "trak");
  const mvex = only(parts, "mvex");
  const extensions = boxes(moov, mvex.payload, mvex.end);
  const trex = only(extensions, "trex");
  const trackParts = boxes(moov, trak.payload, trak.end);
  const tkhd = only(trackParts, "tkhd");
  const trackIdOffset = tkhd.payload + (version(moov, tkhd) ? 20 : 12);
  const mdhd = only(readMediaParts(moov, trackParts, handler), "mdhd");

  const view = dataView(moov);
  const trackId = view.getUint32(trackIdOffset);
  const timescale = view.getUint32(mdhd.payload + (version(moov, mdhd) ? 20 : 12));
  const movieScale = view.getUint32(mvhd.payload + (version(moov, mvhd) ? 20 : 12));
  if (!trackId || trackId !== view.getUint32(trex.payload + 4) || !timescale || !movieScale) {
    invalid("轨道编号或时间基准无效");
  }
  return {
    reader, ftyp, moov, parts, extensions, mvhd, trak, tkhd, trackParts,
    trackId, trackIdOffset, timescale, movieScale,
  };
}

function rescaleTrack(track, movieScale) {
  if (track.movieScale === movieScale) return;
  const view = dataView(track.moov);
  const scale = (offset, wide) => {
    const value = wide ? view.getBigUint64(offset) : BigInt(view.getUint32(offset));
    const duration = (value * BigInt(movieScale) + BigInt(Math.floor(track.movieScale / 2))) /
      BigInt(track.movieScale);
    if (wide) view.setBigUint64(offset, duration);
    else {
      if (duration > 0xffffffffn) invalid("轨道时长超出范围");
      view.setUint32(offset, Number(duration));
    }
  };
  const wide = version(track.moov, track.tkhd) === 1;
  scale(track.tkhd.payload + (wide ? 28 : 20), wide);
  const edts = track.trackParts.find((part) => part.type === "edts");
  if (!edts) return;
  const elst = only(boxes(track.moov, edts.payload, edts.end), "elst");
  const wideEdit = version(track.moov, elst) === 1;
  const stride = wideEdit ? 20 : 12;
  const count = view.getUint32(elst.payload + 4);
  if (elst.payload + 8 + count * stride !== elst.end) invalid("轨道编辑时间表无效");
  for (let i = 0; i < count; i++) scale(elst.payload + 8 + i * stride, wideEdit);
}

function movieBox(video, audio) {
  if (!audio) return video.moov;
  rescaleTrack(audio, video.movieScale);

  const audioId = video.trackId === audio.trackId ? (video.trackId === 1 ? 2 : 1) : audio.trackId;
  const highestId = Math.max(video.trackId, audioId);
  if (highestId >= 0xffffffff) invalid("轨道编号超出范围");
  audio.outputId = audioId;

  const videoView = dataView(video.moov);
  const audioView = dataView(audio.moov);
  videoView.setUint32(video.mvhd.end - 4, highestId + 1);
  audioView.setUint32(audio.trackIdOffset, audioId);

  const audioExtensions = audio.extensions.filter(({ type }) => type === "trex" || type === "trep");
  for (const { payload } of audioExtensions) audioView.setUint32(payload + 4, audioId);

  const cut = (track, box) => track.moov.subarray(box.start, box.end);
  const mvex = createBox("mvex", [
    ...video.extensions.map((box) => cut(video, box)),
    ...audioExtensions.map((box) => cut(audio, box)),
  ]);
  const metadata = video.parts
    .filter(({ type }) => !["mvhd", "trak", "mvex"].includes(type))
    .map((box) => cut(video, box));
  return createBox("moov", [
    cut(video, video.mvhd), cut(video, video.trak), cut(audio, audio.trak), mvex, ...metadata,
  ]);
}

async function nextFragment(track) {
  const { reader } = track;
  let box = await reader.header();
  while (box && (PADDING.has(box.type) || FRAGMENT_METADATA.has(box.type))) {
    await reader.consume(box.size - box.raw.length);
    box = await reader.header();
  }
  if (!box) return null;
  if (box.type !== "moof") invalid("缺少 DASH 分片头");

  const moof = await reader.readBox(box);
  const view = dataView(moof);
  const fragmentParts = boxes(moof, box.payload);
  const mfhd = only(fragmentParts, "mfhd");
  const traf = only(fragmentParts, "traf");
  const trackParts = boxes(moof, traf.payload, traf.end);
  if (trackParts.some((part) => part.type === "senc")) invalid("加密的 DASH 分片");
  const tfhd = only(trackParts, "tfhd");
  const tfdt = only(trackParts, "tfdt");
  if (view.getUint32(tfhd.payload + 4) !== track.trackId) invalid("分片轨道编号不匹配");
  const decodeTime = version(moof, tfdt) ? view.getBigUint64(tfdt.payload + 4) :
    BigInt(view.getUint32(tfdt.payload + 4));
  const mdat = await reader.header();
  if (mdat?.type !== "mdat") invalid("缺少 DASH 分片数据");

  return {
    view, moof, mdat, mfhd, tfhd, decodeTime,
    sourceOffset: box.offset,
  };
}

async function writeFragment(track, fragment, write, outputOffset, sequence) {
  const { view, moof, mdat, mfhd, tfhd, sourceOffset } = fragment;
  view.setUint32(mfhd.payload + 4, sequence);
  view.setUint32(tfhd.payload + 4, track.outputId ?? track.trackId);
  if (view.getUint32(tfhd.payload) & 1) {
    // A tfhd with an explicit base-data-offset uses source-file coordinates.
    const field = tfhd.payload + 8;
    const relocated = view.getBigUint64(field) + BigInt(outputOffset - sourceOffset);
    if (relocated < 0n) invalid("分片数据偏移量无效");
    view.setBigUint64(field, relocated);
  }
  await write(moof);
  await write(mdat.raw);
  await track.reader.consume(mdat.size - mdat.raw.length, write);
  return outputOffset + moof.length + mdat.size;
}

export async function muxDash({ video, audio, write, signal }) {
  const readers = (audio ? [video, audio] : [video]).map((stream) => new StreamReader(stream, signal));
  try {
    const tracks = await Promise.all(readers.map((reader, index) => readTrack(reader, index ? "soun" : "vide")));
    const init = movieBox(...tracks);
    await write(tracks[0].ftyp);
    await write(init);
    let outputOffset = tracks[0].ftyp.length + init.length;
    const fragments = await Promise.all(tracks.map(nextFragment));
    if (fragments.some((fragment) => !fragment)) invalid("轨道缺少 DASH 分片");

    let sequence = 1;
    const videoScale = BigInt(tracks[0].timescale);
    const audioScale = BigInt(tracks[1]?.timescale ?? 1);
    while (fragments[0] || fragments[1]) {
      signal?.throwIfAborted();
      const [videoFragment, audioFragment] = fragments;
      const index = audioFragment &&
        (!videoFragment || audioFragment.decodeTime * videoScale < videoFragment.decodeTime * audioScale) ? 1 : 0;
      outputOffset = await writeFragment(tracks[index], fragments[index], write, outputOffset, sequence++);
      fragments[index] = await nextFragment(tracks[index]);
    }
  } finally {
    await Promise.all(readers.map((reader) => reader.close()));
  }
}

export async function copyProgressiveMp4({ video, write, signal }) {
  const reader = new StreamReader(video, signal);
  try {
    const fileType = await reader.header();
    if (fileType?.type !== "ftyp" || fileType.size < fileType.raw.length + 8) {
      invalid("预期为 MP4 视频");
    }
    await write(await reader.readBox(fileType));
    let hasMovie = false;
    let hasMedia = false;
    for (let box = await reader.header(true); box; box = await reader.header(true)) {
      if (box.type === "pssh") invalid("加密的 MP4");
      if (box.size === null && box.type !== "mdat") invalid("MP4 区块长度无效");
      if (box.type === "moov") {
        const moov = await reader.readBox(box);
        const parts = boxes(moov, box.payload);
        const tracks = parts.filter((part) => part.type === "trak");
        if (hasMovie || !tracks.length || parts.some((part) => part.type === "pssh")) {
          invalid("MP4 轨道无效或已加密");
        }
        for (const track of tracks) readMediaParts(moov, boxes(moov, track.payload, track.end));
        hasMovie = true;
        await write(moov);
        continue;
      }
      if (box.type === "mdat") hasMedia = true;
      await write(box.raw);
      if (box.size === null) {
        while (await reader.fill()) await reader.consume(reader.chunk.length, write);
      } else {
        await reader.consume(box.size - box.raw.length, write);
      }
    }
    if (!hasMovie || !hasMedia) invalid("MP4 文件缺少轨道或媒体数据");
  } finally {
    await reader.close();
  }
}
