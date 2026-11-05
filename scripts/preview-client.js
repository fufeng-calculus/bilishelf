import { initDashboard } from './dashboard.js';

const url = 'https://www.bilibili.com/video/BV1rp4y1e745/';
const entries = [
  { title: '峰间晨光', bvid: 'BV1rp4y1e745', cid: '1', part: 1, duration: 130 },
  { title: '云海与峡谷', bvid: 'BV1rp4y1e745', cid: '2', part: 2, duration: 246 },
  { title: '山野入夜', bvid: 'BV1rp4y1e745', cid: '3', part: 3, duration: 174 },
];
const pause = (time) => new Promise((resolve) => setTimeout(resolve, time));

initDashboard({
  prepare: async () => true,
  requestAccess: async () => true,
  readTab: async () => url,
  async readSource() {
    await pause(300);
    return { title: '高山光影 · 预览示例', kind: 'collection', entries };
  },
  async readFormats(entry) {
    await pause(220);
    const hdrSize = entry.part === 3 ? [1920, 1080] : [3840, 2160];
    return {
      video: [
        { quality: 120, label: '4K SDR', range: 'sdr', width: 3840, height: 2160, codec: 'hvc1' },
        { quality: 125, label: 'HDR', range: 'hdr', width: hdrSize[0], height: hdrSize[1], codec: 'hvc1' },
        { quality: 80, label: '1080P', range: 'sdr', width: 1920, height: 1080, codec: 'avc1' },
      ],
      audio: [],
    };
  },
  async startFile({ signal, onProgress }) {
    const total = 420 * 1024 * 1024;
    for (let percentage = 0; percentage <= 100; percentage += 5) {
      await pause(170);
      signal.throwIfAborted();
      onProgress({ stage: 'downloading', received: total * percentage / 100, total });
    }
    onProgress({ stage: 'saving', received: total, total });
    await pause(650);
    signal.throwIfAborted();
    return { simulated: true };
  },
});

document.querySelector('.source-note').textContent =
  '预览使用示例视频和模拟进度。可试用解析、批量选择、画质检查和取消。';
