import assert from 'node:assert/strict';
import test from 'node:test';
import { describeVideo, selectVideo } from '../src/lib/quality.js';
import { sourceFromTab } from '../src/lib/sites.js';

const hdr1080 = { quality: 125, range: 'hdr', width: 1920, height: 1080 };
const hdr4k = { quality: 125, range: 'hdr', width: 2160, height: 3840 };
const sdr4k = { quality: 120, range: 'sdr', width: 3840, height: 1620 };
const dolby4k = { quality: 126, range: 'dolby', width: 3840, height: 2160 };

test('4K selection requires the requested dynamic range and actual HDR resolution', () => {
  const video = [hdr1080, sdr4k, dolby4k];
  assert.equal(selectVideo({ video }, '4k-hdr'), undefined);
  assert.equal(selectVideo({ video }, '4k-sdr'), sdr4k);
  assert.equal(selectVideo({ video: [...video, hdr4k] }, '4k-hdr'), hdr4k);
  assert.equal(describeVideo(hdr1080), '1080P HDR');
  assert.equal(describeVideo(hdr4k), '4K HDR');
});

test('toolbar forwards only supported hosts and source parameters', () => {
  assert.equal(sourceFromTab('https://www.bilibili.com/video/BV1nguG64EJt/?p=2&vd_source=private&spm_id_from=home'),
    'https://www.bilibili.com/video/BV1nguG64EJt/?p=2');
  assert.equal(sourceFromTab('https://space.bilibili.com/123/favlist?fid=456&ftype=collect'),
    'https://space.bilibili.com/123/favlist?fid=456&ftype=collect');
  assert.equal(sourceFromTab('https://www.bilibili.com.example.org/video/BV1nguG64EJt/'), '');
});
