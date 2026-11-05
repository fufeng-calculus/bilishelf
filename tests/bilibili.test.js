import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getMediaFormats, getMediaSource, isMediaUrl } from '../src/lib/bilibili.js';

const BVID = 'BV1rp4y1e745';
const SECOND_BVID = 'BV1iy411i7ab';
const VIEW = '/x/web-interface/view';
const NAV = '/x/web-interface/nav';
const PLAY = '/x/player/wbi/playurl';
const MEDIA = 'https://upos-sz-mirror.bilivideo.com/sample.m4s';
const videoDetails = {
  bvid: BVID,
  aid: 969628065,
  title: '合集中的分 P 视频',
  pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
  pages: [
    { cid: 244954665, page: 1, part: '第一部分', duration: 10 },
    { cid: 244954666, page: 2, part: '第二部分', duration: 12 },
  ],
};

function payload(data, code = 0) {
  return Response.json({ code, data });
}

function mockBili(t, handler) {
  t.mock.method(globalThis, 'fetch', (value, options) => {
    const url = new URL(value);
    if (url.hostname === 'api.bilibili.com') {
      assert.equal(options.credentials, 'include');
      assert.equal(options.redirect, 'error');
    }
    return handler(url, options);
  });
}

test('Bili media allows secure exact-domain matches and CDN ports', () => {
  assert.equal(isMediaUrl(MEDIA), true);
  assert.equal(isMediaUrl('https://edge.mcdn.bilivideo.cn:8082/sample.m4s'), true);
  assert.equal(isMediaUrl('https://bilivideo.com.attacker.test/sample.m4s'), false);
  assert.equal(isMediaUrl('https://user:secret@bilivideo.com/sample.m4s'), false);
  assert.equal(isMediaUrl('http://bilivideo.com/sample.m4s'), false);
});

test('video parser selects the requested part and preserves main and part titles', async (t) => {
  mockBili(t, (url) => {
    assert.equal(url.pathname, VIEW);
    assert.equal(url.searchParams.get('bvid'), BVID);
    return payload(videoDetails);
  });
  const source = await getMediaSource(`bilibili.com/video/${BVID}/?p=2`);
  assert.equal(source.kind, 'multipart');
  assert.equal(source.currentIndex, 1);
  assert.deepEqual(source.entries[1], {
    bvid: BVID, aid: '969628065', cid: '244954666', part: 2, duration: 12,
    title: '合集中的分 P 视频', partTitle: '第二部分',
    cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
    url: `https://www.bilibili.com/video/${BVID}/?p=2`,
  });
  await assert.rejects(getMediaSource(`https://bilibili.com.attacker.test/video/${BVID}/`), /暂未识别/);
});

test('short link expansion omits credentials and rejects external destinations', async (t) => {
  mockBili(t, (url, options) => {
    if (url.hostname !== 'b23.tv') return payload(videoDetails);
    assert.equal(url.search, '');
    assert.equal(options.method, 'HEAD');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return { url: url.pathname === '/sample' ? `https://www.bilibili.com/video/${BVID}/?p=2` : 'https://attacker.test/' };
  });
  assert.equal((await getMediaSource('b23.tv/sample?share_from=example')).currentIndex, 1);
  await assert.rejects(getMediaSource('https://b23.tv/evil'), /无法展开/);
});

test('season collects available page lists for sibling videos and deduplicates episodes', async (t) => {
  const other = { bvid: SECOND_BVID, aid: 1956281837, title: '另一条视频', pages: [{ cid: 200, page: 1 }, { cid: 201, page: 2 }] };
  const original = { bvid: BVID, aid: 969628065, title: '原视频' };
  mockBili(t, () => payload({
    ...videoDetails,
    ugc_season: { title: '视频合集', sections: [{ episodes: [other, original, original] }] },
  }));
  const source = await getMediaSource(BVID);
  assert.equal(source.kind, 'collection');
  assert.equal(source.title, '视频合集');
  assert.deepEqual(source.entries.map(({ cid }) => cid), ['200', '201', '244954665', '244954666']);
  assert.equal(source.currentIndex, 2);
});

test('playlist paginates the collection and resolves the current video from URL', async (t) => {
  const seenPages = [];
  mockBili(t, (url) => {
    assert.equal(url.pathname, '/x/polymer/web-space/seasons_archives_list');
    assert.equal(url.searchParams.get('season_id'), '3662502');
    const page = Number(url.searchParams.get('page_num'));
    seenPages.push(page);
    return payload({
      meta: { name: '分页合集' },
      page: { total: 2, page_size: 1 },
      archives: [{ bvid: page === 1 ? BVID : SECOND_BVID, title: `第 ${page} 条` }],
    });
  });
  const source = await getMediaSource(`https://www.bilibili.com/list/2142762?season_id=3662502&bvid=${SECOND_BVID}`);
  assert.deepEqual(seenPages, [1, 2]);
  assert.equal(source.currentIndex, 1);
  assert.equal(source.truncated, false);
  assert.equal(source.entries[1].cid, null);
});

test('WBI signature and media variants use actual streams rather than the advertised catalogue', async (t) => {
  const img = '7cd084941338484aae1ad9425b84077c';
  const sub = '4932caff0ff746eab6f01bf08b70ac45';
  mockBili(t, (url) => {
    if (url.pathname === VIEW) return payload(videoDetails);
    if (url.pathname === NAV) {
      return payload({ wbi_img: {
        img_url: `https://i0.hdslb.com/bfs/wbi/${img}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${sub}.png`,
      } }, -101);
    }
    assert.equal(url.pathname, PLAY);
    const query = url.searchParams;
    assert.equal(query.get('fnval'), '4048');
    assert.equal(query.get('cid'), '244954665');
    assert.equal(query.get('fourk'), '1');
    assert.equal(query.has('try_look'), false);
    const signature = query.get('w_rid');
    query.delete('w_rid');
    const key = 'ea1db124af3c7062474693fa704f4ff8';
    assert.equal(signature, createHash('md5').update(query.toString() + key).digest('hex'));
    return payload({
      dash: {
        video: [
          { id: 120, width: 3840, height: 1920, codecs: 'avc1.640034', baseUrl: MEDIA },
          { id: 125, width: 1920, height: 1080, frameRate: '30000/1001', codecs: 'hev1.2.4.L156.90',
            base_url: MEDIA, backup_url: [MEDIA, 'https://bilivideo.com.attacker.test/sample.m4s'] },
          { id: 125, width: 3840, height: 1920, codecs: 'hev1.2.4.L156.90', baseUrl: MEDIA },
        ],
        audio: [{ id: 30280, codecs: 'mp4a.40.2', baseUrl: MEDIA }],
      },
      support_formats: [{ quality: 120 }, { quality: 125 }, { quality: 126 }],
    });
  });
  const { video, audio, unavailable } = await getMediaFormats({ bvid: BVID, part: 1 });
  assert.deepEqual(video.map(({ range, label, resolution }) => [range, label, resolution]), [
    ['sdr', '4K SDR', '4K'], ['hdr', '1080P HDR10', '1080P'], ['hdr', '4K HDR10', '4K'],
  ]);
  assert.deepEqual(video[1].urls, [MEDIA]);
  assert.equal(video[1].fps, 30000 / 1001);
  assert.equal(audio[0].codec, 'mp4a.40.2');
  assert.deepEqual(unavailable, [{ quality: 126, label: '杜比视界' }]);
});

test('preview-only results stop before any play request', async (t) => {
  mockBili(t, (url) => {
    assert.equal(url.pathname, VIEW);
    return payload({ ...videoDetails, is_upower_exclusive: true, is_upower_play: false });
  });
  await assert.rejects(getMediaFormats({ bvid: BVID, part: 1 }), /只可试看/);
});
