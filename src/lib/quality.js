export const qualityChoices = [
  { value: 'auto', label: '最高可用画质' },
  { value: '4k-sdr', label: '4K SDR' },
  { value: '4k-hdr', label: '4K HDR' },
  { value: '1080-sdr', label: '1080P SDR' },
];

function resolution(video) {
  const { width, height } = video;
  if (width > 0 && height > 0) {
    const longer = Math.max(width, height);
    const shorter = Math.min(width, height);
    if (longer >= 7680 || shorter >= 4320) return 4320;
    if (longer >= 3840 || shorter >= 2160) return 2160;
    if (longer >= 1920 || shorter >= 1080) return 1080;
    if (longer >= 1280 || shorter >= 720) return 720;
    return shorter;
  }
  if (video.range !== 'sdr') return 0;
  return { 127: 4320, 120: 2160, 116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360 }[video.quality] ?? 0;
}

function codecPreference(video) {
  const codec = String(video.codec).toLowerCase();
  if (video.range === 'sdr' && resolution(video) <= 1080 && /avc|264/.test(codec)) return 3;
  if (/hev|hvc|265/.test(codec)) return 2;
  if (/av01|av1/.test(codec)) return 1;
  return 0;
}

export function selectVideo(formats, preference) {
  const progressive = (formats.progressive ?? []).map((video) => ({ ...video, progressive: true }));
  const videos = [...formats.video, ...progressive].filter((video) => {
    const size = resolution(video);
    switch (preference) {
      case 'auto': return true;
      case '4k-sdr': return size === 2160 && video.range === 'sdr';
      case '4k-hdr': return size === 2160 && video.range === 'hdr';
      case '1080-sdr': return size === 1080 && video.range === 'sdr';
      default: return false;
    }
  });
  videos.sort((a, b) => resolution(b) - resolution(a) ||
    Number(b.quality) - Number(a.quality) || Number(b.fps || 0) - Number(a.fps || 0) ||
    codecPreference(b) - codecPreference(a));
  return videos[0];
}

export function selectAudio(formats) {
  return [...formats.audio].sort((a, b) =>
    Number(/^mp4a/i.test(b.codec)) - Number(/^mp4a/i.test(a.codec)) ||
    Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
}

export function describeVideo(video) {
  if (!video) return '';
  const size = resolution(video);
  if (size === 2160 && ['sdr', 'hdr'].includes(video.range)) {
    return `4K ${video.range.toUpperCase()}`;
  }
  const label = video.label || '原画质';
  if (video.range === 'hdr' && size > 0) return `${size}P HDR`;
  return label;
}
