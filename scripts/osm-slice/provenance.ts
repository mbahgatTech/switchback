import { createRequire } from 'node:module';
import { assembleTrails, MIN_TRAIL_LENGTH_M } from '../../packages/ingest/src/assemble';
import { RAW_FIXTURE_DIR } from '../../packages/ingest/test/support/raw-fixture';

const require = createRequire(import.meta.url);
console.log('pg              ->', require.resolve('pg'));
console.log('@switchback/geo ->', require.resolve('@switchback/geo'));
console.log('assembleTrails  ->', typeof assembleTrails, 'MIN_TRAIL_LENGTH_M=', MIN_TRAIL_LENGTH_M);
console.log('RAW_FIXTURE_DIR ->', RAW_FIXTURE_DIR);
