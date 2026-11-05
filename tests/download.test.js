import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadMedia } from '../src/lib/download.js';
import { copyProgressiveMp4, muxDash } from '../src/lib/mp4.js';

function integers(...values) {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => result.writeUInt32BE(value, i * 4));
  return result;
}

function box(type, ...parts) {
  return Buffer.concat([integers(8 + parts.reduce((sum, part) => sum + part.length, 0)), Buffer.from(type), ...parts]);
}

function readBoxes(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    result.push({ type, offset, payload: bytes.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return result;
}

function find(bytes, type) {
  return readBoxes(bytes).find((item) => item.type === type).payload;
}

function track(kind, codec, scale, samples, { absolute = false, progressive = false } = {}) {
  const sampleEntry = box(codec, box('colr', Buffer.from('unchanged color metadata')));
  const stsd = box('stsd', integers(0, 1), sampleEntry);
  const media = box('mdia',
    box('mdhd', integers(0, 0, 0, scale, 0)),
    box('hdlr', integers(0, 0), Buffer.from(kind)),
    box('minf', box('stbl', stsd)));
  const movie = box('moov',
    box('mvhd', integers(0, 0, 0, 1000, 0, 2)),
    box('trak', box('tkhd', integers(0, 0, 0, 1, 0, 0)), media),
    ...(progressive ? [] : [box('mvex', box('trex', integers(0, 1, 1, 0, 0, 0)))]));
  const parts = [box('ftyp', Buffer.from('isom'), integers(0)), movie];
  if (progressive) return Buffer.concat([...parts, box('mdat', Buffer.from('media'))]);

  for (const [i, [time, payload]] of samples.entries()) {
    const offset = parts.reduce((size, part) => size + part.length, 0);
    const tfhd = absolute ? integers(1, 1, 0, offset) : integers(0x020000, 1);
    parts.push(box('moof', box('mfhd', integers(0, i + 1)),
      box('traf', box('tfhd', tfhd), box('tfdt', integers(0, time)))));
    parts.push(box('mdat', Buffer.from(payload)));
  }
  return Buffer.concat(parts);
}

function fragmentedStream(bytes) {
  let offset = 0;
  return new ReadableStream({
    pull(sink) {
      if (offset === bytes.length) sink.close();
      else {
        const chunk = bytes.subarray(offset, offset + 17);
        offset += chunk.length;
        sink.enqueue(chunk);
      }
    },
  });
}

test('DASH mux keeps payloads and codec metadata, interleaves and relocates both tracks', async () => {
  const video = track('vide', 'hvc1', 1000, [[0, 'v0'], [1000, 'v1']], { absolute: true });
  const audio = track('soun', 'mp4a', 48000, [[0, 'a0'], [24000, 'a1'], [96000, 'a2']]);
  const output = [];
  await muxDash({
    video: fragmentedStream(video),
    audio: fragmentedStream(audio),
    write: (part) => output.push(part),
  });
  const merged = Buffer.concat(output);
  const tracks = readBoxes(find(merged, 'moov')).filter((item) => item.type === 'trak');
  assert.deepEqual(tracks.map((item) => find(item.payload, 'tkhd').readUInt32BE(12)), [1, 2]);
  assert.ok(tracks[0].payload.includes(Buffer.from('unchanged color metadata')));
  const fragments = readBoxes(merged).filter((item) => item.type === 'moof');
  assert.deepEqual(fragments.map((item) => find(item.payload, 'mfhd').readUInt32BE(4)), [1, 2, 3, 4, 5]);
  assert.deepEqual(fragments.map((item) => find(find(item.payload, 'traf'), 'tfhd').readUInt32BE(4)),
    [1, 2, 2, 1, 2]);
  for (const fragment of [fragments[0], fragments[3]]) {
    assert.equal(find(find(fragment.payload, 'traf'), 'tfhd').readBigUInt64BE(8), BigInt(fragment.offset));
  }
  assert.deepEqual(readBoxes(merged).filter((item) => item.type === 'mdat').map((item) => item.payload.toString()),
    ['v0', 'a0', 'a1', 'v1', 'a2']);
});

test('DASH mux rejects incomplete or encrypted media', async () => {
  const samples = [[0, 'media']];
  const incomplete = track('vide', 'avc1', 1000, samples).subarray(0, -1);
  const encrypted = track('vide', 'encv', 1000, samples);
  await assert.rejects(muxDash({ video: fragmentedStream(incomplete), write: () => {} }), /文件不完整/);
  await assert.rejects(muxDash({ video: fragmentedStream(encrypted), write: () => {} }), /加密/);
});

test('progressive MP4 keeps its original bytes and rejects FLV', async () => {
  const mp4 = track('vide', 'avc1', 1000, [], { progressive: true });
  const output = [];
  await copyProgressiveMp4({ video: fragmentedStream(mp4), write: (part) => output.push(part) });
  assert.deepEqual(Buffer.concat(output), mp4);
  await assert.rejects(copyProgressiveMp4({
    video: fragmentedStream(Buffer.from('FLV\x01\x05\x00\x00\x00\x09')),
    write: () => assert.fail('unsupported media must not reach the file writer'),
  }), /MP4/);
});

test('download falls back to a working CDN, joins partial ranges and releases its temporary file', async (t) => {
  const mp4 = track('vide', 'avc1', 1000, [], { progressive: true });
  const bad = 'https://bad.bilivideo.cn/test.m4s';
  const good = 'https://good.bilivideo.com/test.m4s';
  const headers = [];
  const cutoff = 21;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    headers.push([url, request.headers.Range, request.credentials]);
    if (url === bad) return new Response('', { status: 403 });
    assert.equal(url, good);
    const start = request.headers.Range === 'bytes=0-' ? 0 : cutoff;
    const end = start ? mp4.length : cutoff;
    return new Response(mp4.subarray(start, end), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${mp4.length}` },
    });
  });

  const stored = [];
  let removed = false;
  const scratch = {
    getFileHandle: async () => ({
      createWritable: async () => ({ write: async (part) => stored.push(part), close: async () => {} }),
      getFile: async () => new File(stored, 'temporary.mp4'),
    }),
    removeEntry: async () => { removed = true; },
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { storage: {
      getDirectory: async () => ({ getDirectoryHandle: async () => scratch }),
    } },
  });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, 'navigator', prior);
    else delete globalThis.navigator;
  });
  const api = { downloads: {
    download: async ({ url, filename }) => {
      assert.equal(filename, 'test.mp4');
      const response = await realFetch(url);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4);
      return 1;
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
    search: async () => [{ state: 'complete' }],
  } };
  const stages = [];
  const id = await downloadMedia({
    video: ['https://example.com/media.mp4', bad, good],
    filename: 'test.mp4',
    progressive: true,
    onProgress: (progress) => stages.push(progress),
    api,
  });
  assert.equal(id, 1);
  assert.equal(removed, true);
  assert.deepEqual(headers, [
    [bad, 'bytes=0-', 'omit'],
    [good, 'bytes=0-', 'omit'],
    [bad, `bytes=${cutoff}-`, 'omit'],
    [good, `bytes=${cutoff}-`, 'omit'],
  ]);
  assert.deepEqual(stages.at(-1), { stage: 'saving', received: mp4.length, total: mp4.length });
});
