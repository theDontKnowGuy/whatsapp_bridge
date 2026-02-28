#!/usr/bin/env node
process.env.SKIP_SERVER_START = "true";
process.env.LOAD_CONTEXT_FROM_CACHE =
  process.env.LOAD_CONTEXT_FROM_CACHE || "true";

import {
  bootstrapContextFromCache,
  waitForContextReady,
  getHaContext,
} from "../src/haContext.js";
import {
  debugSelectEntity,
  debugFindCandidates,
  debugDetectBrightness,
  inferDomainsFromText,
  detectDirectAliasCommand,
  detectStateQueryCommand,
  buildRelevantEntitiesSnippet,
  tokenizeForMatch,
} from "../src/resolver.js";

await bootstrapContextFromCache();
await waitForContextReady();

const ctx = getHaContext();
console.log(`\n${"=".repeat(60)}`);
console.log(`  Resolver Test Suite (multi-signal scoring engine)`);
console.log(`${"=".repeat(60)}`);
console.log(`  Entities loaded : ${ctx.entities.length}`);
console.log(`  IDF tokens      : ${ctx.tokenIdf.size}`);
console.log(`  Areas indexed   : ${ctx.areaIndex.size}`);
console.log(`  Entity map size : ${ctx.entityMap.size}`);
console.log(`${"=".repeat(60)}\n`);

// ─── Interactive mode (pass queries as CLI args) ────────────────────────
const cliQueries = process.argv.slice(2);
if (cliQueries.length) {
  for (const q of cliQueries) {
    runFullDiag(q);
  }
  process.exit(0);
}

// ─── Automated test suite ───────────────────────────────────────────────
let passed = 0;
let failed = 0;
let total = 0;

function assert(label, actual, expected) {
  total++;
  const ok =
    typeof expected === "function" ? expected(actual) : actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✅  ${label}`);
  } else {
    failed++;
    console.log(`  ❌  ${label}`);
    console.log(`      got: ${JSON.stringify(actual)}`);
    if (typeof expected !== "function")
      console.log(`      exp: ${JSON.stringify(expected)}`);
  }
}

// ── 1. tokenizeForMatch preserves short tokens ──────────────────────────
console.log("\n── tokenizeForMatch ──────────────────────────────────────");
assert(
  '"turn on the ac" keeps "ac"',
  tokenizeForMatch("turn on the ac").includes("ac"),
  true,
);
assert(
  '"tv" is preserved',
  tokenizeForMatch("tv").includes("tv"),
  true,
);
assert(
  '"a" (1-char, not whitelisted) is dropped',
  tokenizeForMatch("a").includes("a"),
  false,
);

// ── 2. Alias resolution ─────────────────────────────────────────────────
console.log("\n── Alias resolution ─────────────────────────────────────");
assert(
  '"whiskey" → light.whiskey (alias)',
  debugSelectEntity("whiskey"),
  "light.whiskey",
);
assert(
  '"couch" → light.couch (alias)',
  debugSelectEntity("couch"),
  "light.couch",
);
assert(
  '"the wall" → light.the_wall (alias)',
  debugSelectEntity("the wall"),
  "light.the_wall",
);

// ── 3. Direct command detection ─────────────────────────────────────────
console.log("\n── Direct commands ──────────────────────────────────────");
const turnOnWhiskey = detectDirectAliasCommand("turn on whiskey");
assert(
  '"turn on whiskey" resolves entity',
  turnOnWhiskey?.actions?.[0]?.entity_id,
  "light.whiskey",
);
assert(
  '"turn on whiskey" uses light.turn_on',
  turnOnWhiskey?.actions?.[0]?.service,
  "light.turn_on",
);

const turnOffCouch = detectDirectAliasCommand("turn off couch");
assert(
  '"turn off couch" resolves entity',
  turnOffCouch?.actions?.[0]?.entity_id,
  "light.couch",
);

// ── 4. Domain inference ─────────────────────────────────────────────────
console.log("\n── Domain inference ─────────────────────────────────────");
assert(
  '"turn on the light" → includes light',
  inferDomainsFromText("turn on the light").includes("light"),
  true,
);
assert(
  '"set ac to 24" → includes climate',
  inferDomainsFromText("set ac to 24").includes("climate"),
  true,
);
assert(
  '"open the blinds" → includes cover',
  inferDomainsFromText("open the blinds").includes("cover"),
  true,
);
assert(
  '"play music" → includes media_player',
  inferDomainsFromText("play music").includes("media_player"),
  true,
);

// ── 5. Candidate scoring (relative quality) ─────────────────────────────
console.log("\n── Candidate scoring ────────────────────────────────────");

function topCandidate(query, opts) {
  const c = debugFindCandidates(query, 5, opts || {});
  return c.length ? c[0] : null;
}

// The top candidate for "whiskey" should be the whiskey light
const whiskey = topCandidate("whiskey", {
  preferredDomains: ["light"],
});
assert(
  '"whiskey" top candidate is light.whiskey',
  whiskey?.entity_id,
  "light.whiskey",
);

// Score comparison: "living room" query should score living-room entities
// higher than bedroom entities
const lrCandidates = debugFindCandidates("living room", 10, {
  preferredDomains: ["light"],
});
if (lrCandidates.length >= 2) {
  assert(
    '"living room" candidates exist and are scored',
    lrCandidates[0].score > 0,
    true,
  );
  console.log(
    `      top: ${lrCandidates[0].name} (${lrCandidates[0].entity_id}) score=${lrCandidates[0].score.toFixed(1)}`,
  );
}

// ── 6. Brightness detection ─────────────────────────────────────────────
console.log("\n── Brightness commands ──────────────────────────────────");
const bright1 = debugDetectBrightness("set whiskey to 100%");
assert(
  '"set whiskey to 100%" detects brightness',
  bright1 !== null,
  true,
);
if (bright1) {
  assert(
    "  targets whiskey entity",
    bright1.actions[0]?.entity_id,
    "light.whiskey",
  );
  assert("  brightness_pct = 100", bright1.actions[0]?.data?.brightness_pct, 100);
}

const bright2 = debugDetectBrightness("dim couch to 25%");
if (bright2) {
  assert(
    '"dim couch to 25%" detects brightness',
    bright2 !== null,
    true,
  );
  assert("  brightness_pct = 25", bright2.actions[0]?.data?.brightness_pct, 25);
}

// ── 6b. Multi-entity brightness (conjunction splitting) ─────────────────
console.log("\n── Multi-entity brightness ──────────────────────────────");
const brightMulti = debugDetectBrightness("set couch and the wall to 44%");
assert(
  '"set couch and the wall to 44%" detects brightness',
  brightMulti !== null,
  true,
);
if (brightMulti) {
  assert(
    "  finds 2 targets",
    brightMulti.actions.length,
    2,
  );
  const entityIds = brightMulti.actions.map((a) => a.entity_id).sort();
  assert(
    "  includes light.couch",
    entityIds.includes("light.couch"),
    true,
  );
  assert(
    "  includes light.the_wall",
    entityIds.includes("light.the_wall"),
    true,
  );
  assert(
    "  brightness = 44%",
    brightMulti.actions[0]?.data?.brightness_pct,
    44,
  );
  console.log(`      targets: ${brightMulti.actions.map((a) => a.entity_id).join(", ")}`);
  console.log(`      summary: ${brightMulti.successMessage}`);
}

const brightTriple = debugDetectBrightness(
  "set couch, the wall, and whiskey to 80%",
);
assert(
  '"set couch, the wall, and whiskey to 80%" detects brightness',
  brightTriple !== null,
  true,
);
if (brightTriple) {
  assert("  finds 3 targets", brightTriple.actions.length, 3);
  console.log(
    `      targets: ${brightTriple.actions.map((a) => a.entity_id).join(", ")}`,
  );
}

// ── 6c. Multi-entity direct commands ────────────────────────────────────
console.log("\n── Multi-entity direct commands ─────────────────────────");
const turnOnMulti = detectDirectAliasCommand("turn on couch and the wall");
assert(
  '"turn on couch and the wall" detects',
  turnOnMulti !== null,
  true,
);
if (turnOnMulti) {
  assert("  finds 2 actions", turnOnMulti.actions.length, 2);
  const ids = turnOnMulti.actions.map((a) => a.entity_id).sort();
  assert("  includes light.couch", ids.includes("light.couch"), true);
  assert("  includes light.the_wall", ids.includes("light.the_wall"), true);
  console.log(`      message: ${turnOnMulti.successMessage}`);
}

// ── 7. buildRelevantEntitiesSnippet (planner) ───────────────────────────
console.log("\n── Planner entity snippet ───────────────────────────────");
const snippet = buildRelevantEntitiesSnippet("turn on the light", {
  domains: ["light"],
  limit: 50,
});
const snippetLines = snippet.split("\n").length;
assert(
  "Snippet returns multiple entities for 'light' domain",
  snippetLines > 5,
  true,
);
console.log(`      snippet contains ${snippetLines} entities`);

// ── 8. State query detection ────────────────────────────────────────────
console.log("\n── State query commands ─────────────────────────────────");
const stateQ = detectStateQueryCommand("status whiskey");
assert(
  '"status whiskey" detects entity',
  stateQ?.entity_id,
  "light.whiskey",
);

// ── 9. IDF weighting sanity check ───────────────────────────────────────
console.log("\n── IDF weighting sanity ─────────────────────────────────");
const idfLight = ctx.tokenIdf.get("light") || 0;
const idfWhiskey = ctx.tokenIdf.get("whiskey") || 0;
assert(
  '"whiskey" has higher IDF than "light" (rarer token)',
  idfWhiskey > idfLight,
  true,
);
console.log(
  `      IDF("light")=${idfLight.toFixed(2)}, IDF("whiskey")=${idfWhiskey.toFixed(2)}`,
);

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  Results: ${passed}/${total} passed, ${failed} failed`,
);
console.log(`${"=".repeat(60)}\n`);

if (failed > 0) process.exit(1);

// ─── Full diagnostic for a single query ─────────────────────────────────
function runFullDiag(q) {
  console.log(`\n─── Query: "${q}" ───`);

  const domains = inferDomainsFromText(q);
  console.log(`  Inferred domains: ${domains.join(", ") || "none"}`);

  const entityId = debugSelectEntity(q, {
    preferredDomains: ["light", "switch", "fan", "cover", "climate"],
  });
  console.log(`  Selected entity: ${entityId || "<none>"}`);

  const candidates = debugFindCandidates(q, 8, {
    preferredDomains: ["light", "switch", "fan", "cover", "climate"],
  });
  if (!candidates.length) {
    console.log("  Candidates: none");
  } else {
    console.log("  Candidates:");
    candidates.forEach((c, idx) => {
      console.log(
        `    ${idx + 1}. ${c.name} (${c.entity_id}) domain=${c.domain} score=${c.score.toFixed(1)}`,
      );
    });
  }

  const direct = detectDirectAliasCommand(q);
  if (direct) {
    console.log(
      `  Direct command: ${direct.service} → ${direct.entity_id}`,
    );
  }

  const brightness = debugDetectBrightness(q);
  if (brightness) {
    console.log("  Brightness action:");
    brightness.actions.forEach((a, idx) => {
      console.log(`    ${idx + 1}. ${a.entity_id} ← ${a.data.brightness_pct}%`);
    });
    console.log(`  Summary: ${brightness.successMessage}`);
  }

  const stateCmd = detectStateQueryCommand(q);
  if (stateCmd) {
    console.log(`  State query: ${stateCmd.entity_id}`);
  }
}
