import { getHaContext } from "./haContext.js";
import { DEFAULT_SUMMARY_DOMAINS, DOMAIN_KEYWORDS } from "./constants.js";
import { getLastEntityId } from "./memory.js";

const DEVICE_MAP = {
  whiskey: "light.whiskey",
  "kitchen light": "light.kitchen",
};

export function isDiagnosticCommand(text = "") {
  const normalized = text.trim().toLowerCase();
  return normalized === "#context" || normalized === "#dump context";
}

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

export function tokenizeForMatch(text = "") {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token);
}

export function findEntityCandidates(text = "", limit = 8, options = {}) {
  const haContext = getHaContext();
  if (!text || !haContext.searchIndex.length) {
    return [];
  }

  const preferredDomains = new Set(options.preferredDomains || []);
  const tokens = tokenizeForMatch(text).filter((token) => token.length >= 3);

  const scored = haContext.searchIndex
    .map((entity) => {
      const haystack = `${entity.normalized || ""} ${entity.entity_id}`;
      const score = tokens.reduce(
        (acc, token) => (haystack.includes(token) ? acc + 1 : acc),
        0,
      );
      const preferredBoost = preferredDomains.has(entity.domain) ? 0.5 : 0;
      return { ...entity, score: score + preferredBoost };
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

  if (!unique.length && tokens.length === 1) {
    const fallback = haContext.searchIndex
      .filter((entity) => entity.entity_id.includes(tokens[0]))
      .slice(0, limit)
      .map((entity) => ({ ...entity, score: 0.5 }));
    return fallback;
  }

  return unique;
}

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
      let entityId = selectEntityId(rawTarget, {
        preferredDomains: ["light"],
        limit: 5,
      });
      if (
        (!entityId || getEntityById(entityId)?.domain !== "light") &&
        pronouns.has(rawTarget)
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
        const fallback = findEntityCandidates(rawTarget, 5, {
          preferredDomains: ["light"],
        }).find((item) => item.domain === "light" && item.supportsBrightness);
        if (fallback) {
          targets.push(fallback);
        }
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
    if (normalized.startsWith(pattern.prefix)) {
      const targetRaw = trimmed.substring(pattern.prefix.length).trim();
      const entityId = selectEntityId(targetRaw, {
        preferredDomains: ["light", "switch", "fan", "cover"],
        limit: 5,
      });
      if (!entityId) {
        continue;
      }
      const entity = getEntityById(entityId);
      if (!entity) {
        continue;
      }
      return {
        service: `${entity.domain}.${pattern.service}`,
        entity_id: entity.entity_id,
        successMessage: `${entity.name} ${pattern.service === "turn_on" ? "turned on" : "turned off"}.`,
      };
    }
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

export function buildRelevantEntitiesSnippet(text = "") {
  const candidates = findEntityCandidates(text, 10);
  if (!candidates.length) {
    return "No direct candidate entities found.";
  }

  return candidates
    .map((entity) => {
      const area = entity.area ? ` (${entity.area})` : "";
      return `${entity.name}${area} → ${entity.entity_id} [${entity.domain}, state=${entity.state}]`;
    })
    .join("\n");
}

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

function controlDevice(target, action) {
  const entityId = DEVICE_MAP[target];
  if (!entityId) {
    return Promise.resolve(
      `I don't know the device "${target}". Update DEVICE_MAP.`,
    );
  }

  const [domain] = entityId.split(".");
  return Promise.resolve(
    `${target} ${action === "turn_on" ? "turned on" : "turned off"}.`,
  );
}

function fetchStatus(target) {
  const entityId = DEVICE_MAP[target];
  if (!entityId) {
    return Promise.resolve(
      `I don't know the device "${target}". Update DEVICE_MAP.`,
    );
  }

  return Promise.resolve(`${target} is currently unknown.`);
}

function clampPercent(value) {
  if (Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function resolveAlias(text = "") {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return null;
  return DEVICE_MAP[normalized];
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

function getEntityById(entityId) {
  return getHaContext().entities.find(
    (entity) => entity.entity_id === entityId,
  );
}
