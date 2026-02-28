#!/usr/bin/env node
process.env.SKIP_SERVER_START = 'true';
process.env.LOAD_CONTEXT_FROM_CACHE =
  process.env.LOAD_CONTEXT_FROM_CACHE || 'true';

import { bootstrapContextFromCache, waitForContextReady } from '../src/haContext.js';
import {
  debugSelectEntity,
  debugFindCandidates,
  debugDetectBrightness
} from '../src/resolver.js';

await bootstrapContextFromCache();
await waitForContextReady();

const queries = process.argv.slice(2);
const testQueries = queries.length
  ? queries
  : [
      'turn on whiskey',
      'turn off couch',
      'switch on living room spots',
      'turn off cinema bloom',
      'turn on kitchen light',
      'set whiskey to 100%',
      'dim couch to 25%',
      'status whiskey',
      'set all cinema lights to 20%'
    ];

for (const q of testQueries) {
  const entityId = debugSelectEntity(q, {
    preferredDomains: ['light', 'switch', 'fan', 'cover']
  });
  const candidates = debugFindCandidates(q, 5, {
    preferredDomains: ['light', 'switch', 'fan', 'cover']
  });
  console.log(`\nQuery: ${q}`);
  if (entityId) {
    console.log(`  Selected entity: ${entityId}`);
  } else {
    console.log('  Selected entity: <none>');
  }
  if (!candidates.length) {
    console.log('  Candidates: none');
  } else {
    console.log('  Candidates:');
    candidates.forEach((candidate, idx) => {
      console.log(
        `    ${idx + 1}. ${candidate.name} (${candidate.entity_id}) domain=${candidate.domain} score=${candidate.score}`
      );
    });
  }
  const brightness = debugDetectBrightness(q);
  if (brightness) {
    console.log('  Brightness action:');
    brightness.actions.forEach((action, idx) => {
      console.log(`    ${idx + 1}. ${action.entity_id} ← ${action.data.brightness_pct}%`);
    });
    console.log(`  Summary: ${brightness.successMessage}`);
  }
}
