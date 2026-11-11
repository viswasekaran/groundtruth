import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { dHash, hamming } from '../src/verify.js';
import { haversineMeters } from '../src/geo.js';

function makeJpeg(seed, w = 320, h = 240, quality = 90) {
  const data = Buffer.alloc(w * h * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // smooth random blobs so the image has structure
  const blobs = Array.from({ length: 6 }, () => ({ x: rnd(), y: rnd(), r: 0.1 + rnd() * 0.25, c: rnd() * 255 }));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 40;
      for (const b of blobs) if ((x / w - b.x) ** 2 + (y / h - b.y) ** 2 < b.r ** 2) v = b.c;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return jpeg.encode({ data, width: w, height: h }, quality).data;
}

test('identical images hash identically', () => {
  const a = makeJpeg(7);
  assert.equal(dHash(a).hash, dHash(Buffer.from(a)).hash);
});

test('re-encoded / resized copy is detected as a near-duplicate', () => {
  const a = dHash(makeJpeg(7, 320, 240, 90)).hash;
  const b = dHash(makeJpeg(7, 640, 480, 40)).hash; // same scene, different size and quality
  assert.ok(hamming(a, b) <= 6, `distance ${hamming(a, b)} should be small`);
});

test('different scenes are far apart', () => {
  const a = dHash(makeJpeg(7)).hash;
  const b = dHash(makeJpeg(99)).hash;
  assert.ok(hamming(a, b) > 10, `distance ${hamming(a, b)} should be large`);
});

test('haversine distance is sane', () => {
  // Ferry Building -> Coit Tower is roughly 1.2 km
  const d = haversineMeters(37.7955, -122.3937, 37.8024, -122.4058);
  assert.ok(d > 1100 && d < 1400, `got ${d}`);
});
