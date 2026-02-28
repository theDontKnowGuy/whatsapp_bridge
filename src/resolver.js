import * as fsSync from "fs";
import { getHaContext, getEntityById } from "./haContext.js";
import {
  DEFAULT_SUMMARY_DOMAINS,
  DOMAIN_KEYWORDS,
  ALIASES_PATH,
  STOP_WORDS,
  tokenizeForMatch,
} from "./constants.js";
import { getLastEntityId } from "./memory.js";

// ---------------------------------------------------------------------------
// Alias management – loaded from config/aliases.json, hot-reloaded every 60 s
// ---------------------------------------------------------------------------
let aliasCache = null;
let aliasLastLoaded = 0;
const ALIAS_RELOAD_MS = 60_000;

function loadAliases() {
  const now = Date.now();
  if (aliasCache && now - aliasLastLoaded < ALIAS_RELOAD_MS) {
    return aliasCache;
  }
  try {
    const raw = fsSync.readFileSync(ALIASES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    aliasCache = new Map(
      Object.entries(parsed).map(([k, v]) => [k.toLowerCase().trim(), v]),
    );
    aliasLastLoaded = now;
  } catch {
    if (!aliasCache) aliasCache = new Map();
  }
  return aliasCache;
}

function resolveAlias(text = "") {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return null;
  const aliases = loadAliases();
  return aliases.get(normalized) || null;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
export function isDiagnosticCommand(text = "") {
  const normalized = text.trim().toLowerCase();
  return normalized === "#context" || normalized === "#dump context";
}

// ---------------------------------------------------------------------------
// Domain inference from free-text
// ---------------------------------------------------------------------------
export function inferDomainsFromText(text = "") {
  const lower = text.toLowerCase();
  const matches = new Set();
  DOMAIN_KEYWORDS.forEach(({ domain, keywords }) => {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      matches.add(domain);
    }
  });
  return Array.from(matches);
}

// Re-export so callers that imported from here keep working.
export { tokenizeForMatch } from "./constants.js";

// ---------------------------------------------------------------------------
// Multi-signal entity scorer
// ---------------------------------------------------------------------------

/**
 * Score how well an entity matches a set of query tokens.
 *
 * Signals (additive):
 *  1. Exact friendly-name match              +100
 *  2. Exact entity_id suffix match           +80
 *  3. Area token matches                     +5 × IDF each
 *  4. Friendly-name token matches            +3 × IDF each
 *  5. entity_id-only token matches           +1 × IDF each
 *  6. Contiguous token bonus                 +2 per consecutive match ≥ 2
 *  7. Domain preference                      +2
 *  8. Completeness (% of name tokens hit)    up to +5
 */
function scoreEntity(entity, tokens, options = {}) {
  const { preferredDomains, tokenIdf } = options;
  let score = 0;

  const friendlyName = (entity.name || "").toLowerCase();
  const entityIdSuffix = entity.entity_id
    .split(".")
    .slice(1)
    .join(".")
    .replace(/_/g, " ");
  const areaLower = (entity.area || "").toLowerCase();

  const queryJoined = tokens.join(" ");

  // 1. Exact friendly-name match
  if (friendlyName === queryJoined) {
    score += 100;
  }

  // 2. Exact entity_id suffix match (e.g. "kitchen" matches light.kitchen)
  if (entityIdSuffix === queryJoined.replace(/\s+/g, " ")) {
    score += 80;
  }

  // Pre-tokenize the entity's various fields
  const nameTokens = tokenizeForMatch(friendlyName);
  const idTokens = tokenizeForMatch(entity.entity_id);
  const areaTokens = tokenizeForMatch(areaLower);

  let consecutiveNameMatches = 0;
  let maxConsecutive = 0;
  let nameMatchCount = 0;

  for (const token of tokens) {
    const idf = tokenIdf?.get(token) || 1;
    const inName = nameTokens.includes(token);
    const inId = idTokens.includes(token);
    const inArea = areaTokens.includes(token);

    // 3. Area match
    if (inArea) {
      score += 5 * idf;
    }

    // 4. Friendly-name match
    if (inName) {
      score += 3 * idf;
      nameMatchCount++;
      consecutiveNameMatches++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveNameMatches);
    } else {
      consecutiveNameMatches = 0;
      // 5. entity_id-only match (don't double-count with name)
      if (inId) {
        score += 1 * idf;
      }
    }
  }

  // 6. Contiguous-token bonus
  if (maxConsecutive >= 2) {
    score += maxConsecutive * 2;
  }

  // 7. Domain preference
  if (preferredDomains?.has(entity.domain)) {
    score += 2;
  }

  // 8. Completeness bonus – rewards "kitchen light" matching a 2-token name
  //    over a 5-token name where only 1 token matched
  if (nameTokens.length > 0 && nameMatchCount > 0) {
    score += (nameMatchCount / nameTokens.length) * 5;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Candidate search
// ---------------------------------------------------------------------------

export function findEntityCandidates(text = "", limit = 8, options = {}) {
  const haContext = getHaContext();
  if (!text || !haContext.searchIndex.length) {
    return [];
  }

  const preferredDomains = new Set(options.preferredDomains || []);
  const tokens = tokenizeForMatch(text).filter((t) => !STOP_WORDS.has(t));
  if (!tokens.length) return [];

  const tokenIdf = haContext.tokenIdf;

  const scored = haContext.searchIndex
    .map((entity) => {
      const s = scoreEntity(entity, tokens, { preferredDomains, tokenIdf });
      return { ...entity, score: s };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const unique = [];
  const seen = new Set();
  for (const item of scored) {
    if (seen.has(item.entity_id)) continue;
    unique.push(item);
    seen.add(item.entity_id);
    if (unique.length >= limit) break;
  }

  // Fallback for single-token queries with zero results
  if (!unique.length && tokens.length === 1) {
    const fallback = haContext.searchIndex
      .filter((entity) => entity.entity_id.includes(tokens[0]))
      .slice(0, limit)
      .map((entity) => ({ ...entity, score: 0.5 }));
    return fallback;
  }

  return unique;
}

// ---------------------------------------------------------------------------
// Entity selection (returns entity_id string or null)
// ---------------------------------------------------------------------------

export function selectEntityId(text = "", options = {}) {
  const alias = resolveAlias(text);
  if (alias) {
    return alias;
  }

  const candidates = findEntityCandidates(text, options.limit || 5, {
    preferredDomains: options.preferredDomains || [],
  });

  if (candidates.length) {
    const best = candidates[0];
    if ((best.score || 0) >= (options.minScore || 1)) {
      return best.entity_id;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Command detectors
// ---------------------------------------------------------------------------

export function detectStateQueryCommand(text = "") {
  const lowered = text.toLowerCase().trim();
  const patterns = [
    /^status\s+(.+)$/,
    /^(?:what'?s|what is)\s+(?:the\s+)?(?:status|state)\s+(?:of\s+)?(.+)$/,
    /^state\s+(.+)$/,
    /^check\s+(.+)$/,
  ];

  for (const pattern of patterns) {
    const match = lowered.match(pattern);
    if (match) {
      const target = match[match.length - 1].trim();
      const entityId = selectEntityId(target, {
        preferredDomains: [
          "light",
          "switch",
          "fan",
          "cover",
          "climate",
          "media_player",
          "sensor",
        ],
      });
      if (entityId) {
        return { entity_id: entityId, target };
      }
    }
  }

  return null;
}

export function detectPronounCommand(text = "", sender, deps = {}) {
  const lowered = text.toLowerCase().trim();
  const pronounPattern =
    /^(?:turn|switch)\s+(?:it|them|this|that)\s+(?:back\s+)?(on|off)$/;
  const match = lowered.match(pronounPattern);
  if (!match) {
    return null;
  }

  const lastEntityId = (deps.getLastEntityId || getLastEntityId)(sender);
  if (!lastEntityId) {
    return null;
  }

  const entity = getEntityById(lastEntityId);
  if (!entity) {
    return null;
  }

  const action = match[1] === "on" ? "turn_on" : "turn_off";
  return {
    service: `${entity.domain}.${action}`,
    entity_id: entity.entity_id,
    successMessage: `${entity.name} ${action === "turn_on" ? "turned on" : "turned off"}.`,
  };
}

export function detectBrightnessCommand(text = "", sender, deps = {}) {
  const lowered = text.toLowerCase().trim();
  const patterns = [
    /^(?:set|turn|switch)\s+(.+?)\s+to\s+(\d{1,3})(?:\s*%|\s*percent)?$/,
    /^(?:set\s+brightness\s+of)\s+(.+?)\s+to\s+(\d{1,3})(?:\s*%|\s*percent)?$/,
    /^(?:dim|brighten)\s+(.+?)\s+to\s+(\d{1,3})(?:\s*%|\s*percent)?$/,
  ];

  const pronouns = new Set(["it", "this", "that", "them"]);

  for (const pattern of patterns) {
    const match = lowered.match(pattern);
    if (!match) continue;

    const rawTarget = match[1].trim();
    const value = clampPercent(parseInt(match[2], 10));
    if (value === null) continue;

    const rawTokens = tokenizeForMatch(rawTarget);
    const filterTokens = rawTokens.filter(
      (token) => !["all", "light", "lights", "lamp", "lamps"].includes(token),
    );
    const isAllRequest = rawTokens.includes("all");
    const query = filterTokens.join(" ");

    const targets = [];

    if (isAllRequest) {
      const candidates = findEntityCandidates(query || rawTarget, 50, {
        preferredDomains: ["light"],
      });
      candidates
        .filter(
          (candidate) =>
            candidate.domain === "light" && candidate.supportsBrightness,
        )
        .filter((candidate) => {
          if (!filterTokens.length) return true;
          const normalized = candidate.normalized || "";
          const entityIdLower = candidate.entity_id.toLowerCase();
          return filterTokens.every(
            (token) =>
              normalized.includes(token) || entityIdLower.includes(token),
          );
        })
        .forEach((candidate) => targets.push(candidate));
    } else {
      // Split on conjunctions: "couch and the wall" → ["couch", "the wall"]
      const segments = splitConjunctionTargets(rawTarget);

      for (const segment of segments) {
        let entityId = selectEntityId(segment, {
          preferredDomains: ["light"],
          limit: 5,
        });
        if (
          (!entityId || getEntityById(entityId)?.domain !== "light") &&
          pronouns.has(segment)
        ) {
          const lastId = (deps.getLastEntityId || getLastEntityId)(sender);
          const lastEntity = lastId ? getEntityById(lastId) : null;
          if (lastEntity && lastEntity.domain === "light") {
            entityId = lastEntity.entity_id;
          }
        }

        if (entityId) {
          const entity = getEntityById(entityId);
          if (entity && entity.supportsBrightness) {
            targets.push(entity);
          }
        } else {
          const fallback = findEntityCandidates(segment, 5, {
            preferredDomains: ["light"],
          }).find(
            (item) => item.domain === "light" && item.supportsBrightness,
          );
          if (fallback) {
            targets.push(fallback);
          }
        }
      }

      // If we found some entities but not all, bail to planner for accuracy
      if (segments.length > 1 && targets.length < segments.length) {
        return null;
      }
    }

    const uniqueTargets = dedupeEntities(targets);
    const dimmableTargets = uniqueTargets.filter(
      (entity) => entity.supportsBrightness,
    );

    if (!dimmableTargets.length) {
      continue;
    }

    const actions = dimmableTargets.map((entity) => ({
      service: "light.turn_on",
      entity_id: entity.entity_id,
      data: { brightness_pct: value },
      name: entity.name,
    }));

    const summaryName = isAllRequest
      ? `${dimmableTargets.length} light${dimmableTargets.length > 1 ? "s" : ""}`
      : dimmableTargets.length > 1
        ? dimmableTargets.map((t) => t.name).join(", ")
        : dimmableTargets[0].name;

    return {
      actions,
      successMessage: `${summaryName} set to ${value}%`,
    };
  }

  return null;
}

export function detectDirectAliasCommand(text = "", sender) {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  const directPatterns = [
    { prefix: "turn on ", service: "turn_on" },
    { prefix: "turn off ", service: "turn_off" },
    { prefix: "switch on ", service: "turn_on" },
    { prefix: "switch off ", service: "turn_off" },
  ];

  for (const pattern of directPatterns) {
    if (!normalized.startsWith(pattern.prefix)) continue;

    const targetRaw = trimmed.substring(pattern.prefix.length).trim();
    const segments = splitConjunctionTargets(targetRaw);
    const actions = [];

    for (const segment of segments) {
      const entityId = selectEntityId(segment, {
        preferredDomains: ["light", "switch", "fan", "cover"],
        limit: 5,
      });
      if (!entityId) continue;
      const entity = getEntityById(entityId);
      if (!entity) continue;

      actions.push({
        service: `${entity.domain}.${pattern.service}`,
        entity_id: entity.entity_id,
        name: entity.name,
      });
    }

    // If we couldn't resolve ANY segment, bail to planner
    if (!actions.length) continue;

    // If we resolved some but not all, bail to planner for accuracy
    if (actions.length < segments.length) return null;

    const verb =
      pattern.service === "turn_on" ? "turned on" : "turned off";
    const names = actions.map((a) => a.name).join(", ");
    return {
      actions,
      successMessage: `${names} ${verb}.`,
    };
  }

  return null;
}

export function fallbackSimpleHandler(text) {
  const normalized = text.toLowerCase();

  if (normalized.startsWith("turn on ")) {
    const target = normalized.replace("turn on ", "").trim();
    return controlDevice(target, "turn_on");
  }

  if (normalized.startsWith("turn off ")) {
    const target = normalized.replace("turn off ", "").trim();
    return controlDevice(target, "turn_off");
  }

  if (normalized.startsWith("status ")) {
    const target = normalized.replace("status ", "").trim();
    return fetchStatus(target);
  }

  return Promise.resolve(
    'Send a command like "turn on living room light" or "status kitchen light".',
  );
}

// ---------------------------------------------------------------------------
// Planner helper – build a rich snippet of relevant entities
// ---------------------------------------------------------------------------

/**
 * Build a text snippet of candidate entities for the LLM planner.
 *
 * Improvements over the original:
 *  • Returns up to `limit` entities (default 30, was 10).
 *  • When `domains` are provided, includes ALL entities in those domains
 *    so the LLM can disambiguate rather than being limited to weak top-10.
 *  • De-duplicates and sorts by relevance score.
 */
export function buildRelevantEntitiesSnippet(text = "", options = {}) {
  const { domains = [], limit = 30 } = options;
  const haContext = getHaContext();

  // 1. Get top candidates from text-based search
  const candidates = findEntityCandidates(text, 15);
  const seen = new Set(candidates.map((c) => c.entity_id));

  // 2. Also pull in all entities from inferred domains (capped per domain)
  const domainEntities = [];
  const MAX_PER_DOMAIN = 40;
  for (const domain of domains) {
    const entities = haContext.grouped[domain] || [];
    let added = 0;
    for (const entity of entities) {
      if (!seen.has(entity.entity_id)) {
        domainEntities.push({ ...entity, score: 0 });
        seen.add(entity.entity_id);
        added++;
        if (added >= MAX_PER_DOMAIN) break;
      }
    }
  }

  const all = [...candidates, ...domainEntities].slice(0, limit);

  if (!all.length) {
    return "No direct candidate entities found.";
  }

  return all
    .map((entity) => {
      const area = entity.area ? ` (${entity.area})` : "";
      const sc =
        entity.score !== undefined && entity.score > 0
          ? ` score=${entity.score.toFixed(1)}`
          : "";
      return `${entity.name}${area} → ${entity.entity_id} [${entity.domain}, state=${entity.state}${sc}]`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Debug helpers (used by test script)
// ---------------------------------------------------------------------------

export function debugSelectEntity(text, options) {
  return selectEntityId(text, options);
}

export function debugFindCandidates(text, limit, options) {
  return findEntityCandidates(text, limit, options);
}

export function debugDetectBrightness(text) {
  return detectBrightnessCommand(text, "debug", {
    getLastEntityId: () => null,
  });
}

// ---------------------------------------------------------------------------
// Conjunction splitter – "couch and the wall" → ["couch", "the wall"]
// ---------------------------------------------------------------------------

/**
 * Split a target string on conjunctions: "and", "&", ","
 * Handles: "couch and the wall", "couch, the wall, and whiskey", "A & B"
 */
function splitConjunctionTargets(text) {
  return text
    .split(/(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function controlDevice(target, action) {
  const alias = resolveAlias(target);
  if (!alias) {
    const entityId = selectEntityId(target, {
      preferredDomains: ["light", "switch", "fan", "cover"],
    });
    if (!entityId) {
      return Promise.resolve(
        `I don't know the device "${target}". Try adding it to config/aliases.json.`,
      );
    }
    const entity = getEntityById(entityId);
    const name = entity?.name || entityId;
    return Promise.resolve(
      `${name} ${action === "turn_on" ? "turned on" : "turned off"}.`,
    );
  }

  const entity = getEntityById(alias);
  const name = entity?.name || alias;
  return Promise.resolve(
    `${name} ${action === "turn_on" ? "turned on" : "turned off"}.`,
  );
}

function fetchStatus(target) {
  const alias = resolveAlias(target);
  const entityId =
    alias ||
    selectEntityId(target, {
      preferredDomains: [
        "light",
        "switch",
        "fan",
        "cover",
        "climate",
        "sensor",
      ],
    });
  if (!entityId) {
    return Promise.resolve(
      `I don't know the device "${target}". Try adding it to config/aliases.json.`,
    );
  }

  const entity = getEntityById(entityId);
  const name = entity?.name || entityId;
  return Promise.resolve(`${name} is currently ${entity?.state || "unknown"}.`);
}

function clampPercent(value) {
  if (Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function dedupeEntities(entities) {
  const seen = new Set();
  const result = [];
  for (const entity of entities) {
    if (!entity || seen.has(entity.entity_id)) continue;
    seen.add(entity.entity_id);
    result.push(entity);
  }
  return result;
}
