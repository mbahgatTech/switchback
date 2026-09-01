import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

interface Recorded {
  response: { elements: Array<{ type: string; id: number }> };
}

const quadkey = process.argv[2] ?? '021231030';
const path = `packages/ingest/test/fixtures/raw/tile.${quadkey}.json.gz`;
const rec = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Recorded;
const els = rec.response.elements;

const order = els.map((e) => e.type);
const firstWay = order.indexOf('way');
const firstRel = order.indexOf('relation');
console.log('elements:', els.length, 'first way at', firstWay, 'first relation at', firstRel);

const types = [...new Set(order)];
for (const t of types) {
  const ids = els.filter((e) => e.type === t).map((e) => e.id);
  const ascending = ids.every((id, i) => i === 0 || ids[i - 1]! <= id);
  console.log(`${t}: n=${ids.length} ascendingById=${ascending} first=${ids[0]} last=${ids.at(-1)}`);
}
console.log('type blocks in order:', order.filter((t, i) => i === 0 || order[i - 1] !== t).join(' -> '));
