import axios from "axios";
import fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";

import {
  CONTEXT_CACHE_PATH,
  BLACKLIST_PATH,
  DEFAULT_SUMMARY_DOMAINS,
} from "./constants.js";
import { logMessage } from "./logger.js";

const haContext = {
  lastUpdated: null,
  entities: [],
  summary: "",
  grouped: {},
  searchIndex: [],
};

let contextReadyResolved = false;
let contextReadyResolver;
const contextReady = new Promise((resolve) => {
  contextReadyResolver = resolve;
});

function markContextReady() {
  if (!contextReadyResolved) {
    contextReadyResolved = true;
    contextReadyResolver?.();
  }
}

export function getHaContext() {
  return haContext;
}

export function waitForContextReady() {
  return contextReady;
}

export function buildDomainSummary(requestedDomains = []) {
  if (!haContext.entities.length) {
    return "No devices available.";
  }

  const domainsToDescribe = resolveDomainsForSummary(requestedDomains);
  const parts = [
    `Total entities: ${haContext.entities.length}`,
    `Context refreshed at: ${haContext.lastUpdated?.toISOString() || "unknown"}`,
    `Loaded domains: ${Object.keys(haContext.grouped).length}`,
  ];

  domainsToDescribe.forEach((domain) => {
    const list = haContext.grouped[domain] || [];
    parts.push(`${domain}: ${list.length}`);
  });

  return parts.join("\n");
}

export function dumpContextToLogs(reason = "manual") {
  const summary = buildDomainSummary();
  const sampleEntities = haContext.entities
    .slice(0, 50)
    .map((entity) => entity.entity_id);
  logMessage("INFO", `[ContextDump:${reason}] Summary => ${summary}`);
  logMessage(
    "INFO",
    `[ContextDump:${reason}] Entities sample => ${JSON.stringify(sampleEntities)}`,
  );
}

export function bootstrapContextFromCache() {
  return loadHaContextFromCache();
}

export function startHaContextLoop({ haBaseUrl, haToken, refreshMs }) {
  loadHaContextFromCache();
  refreshHaContext(haBaseUrl, haToken);
  setInterval(() => refreshHaContext(haBaseUrl, haToken), refreshMs).unref();
}

async function refreshHaContext(haBaseUrl, haToken) {
  if (!haBaseUrl || !haToken) {
    logMessage("WARN", "[Context] Missing HA_BASE_URL or HA_TOKEN.");
    return;
  }

  try {
    const res = await axios.get(`${haBaseUrl}/api/states`, {
      headers: {
        Authorization: `Bearer ${haToken}`,
      },
    });

    const entities = (res.data || []).map(mapEntityFromState);
    ensureBlacklistExists(entities);
    const blacklist = loadBlacklist();

    const filteredEntities = entities.filter(
      (entity) => !blacklist.has(entity.entity_id),
    );
    const filteredGrouped = groupEntities(filteredEntities);
    const filteredSearchIndex = filteredEntities.map((entity) => ({
      entity_id: entity.entity_id,
      domain: entity.domain,
      name: entity.name,
      area: entity.area,
      state: entity.state,
      normalized: entity.normalized,
      supportsBrightness: entity.supportsBrightness,
    }));

    const summaryParts = [
      `Total entities: ${filteredEntities.length}`,
      `Context refreshed at: ${new Date().toISOString()}`,
    ];

    DEFAULT_SUMMARY_DOMAINS.forEach((domain) => {
      const list = filteredGrouped[domain] || [];
      summaryParts.push(`${domain}: ${list.length}`);
    });

    haContext.entities = filteredEntities;
    haContext.lastUpdated = new Date();
    haContext.grouped = filteredGrouped;
    haContext.searchIndex = filteredSearchIndex;
    haContext.summary = summaryParts.join("\n");

    await persistContextSnapshot(filteredEntities, filteredSearchIndex);

    logMessage(
      "INFO",
      `[Context] Loaded ${filteredEntities.length} entities (blacklist: ${blacklist.size}).`,
    );
    markContextReady();
  } catch (err) {
    logMessage(
      "ERROR",
      `[Context] Failed to load Home Assistant entities: ${err.response?.data || err.message}`,
    );
  }
}

async function loadHaContextFromCache() {
  try {
    const raw = await fs.readFile(CONTEXT_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const entities = (parsed.entities || []).map((entity) => ({
      ...entity,
      supportsBrightness: entity.supportsBrightness ?? false,
    }));

    ensureBlacklistExists(entities);
    const blacklist = loadBlacklist();
    const filteredEntities = entities.filter(
      (entity) => !blacklist.has(entity.entity_id),
    );

    haContext.entities = filteredEntities;
    haContext.grouped = groupEntities(filteredEntities);
    haContext.searchIndex = (parsed.searchIndex || parsed.entities || [])
      .map((entity) => ({
        ...entity,
        supportsBrightness: entity.supportsBrightness ?? false,
      }))
      .filter((entity) => !blacklist.has(entity.entity_id));
    haContext.lastUpdated = parsed.generatedAt
      ? new Date(parsed.generatedAt)
      : new Date();
    haContext.summary = `Loaded ${haContext.entities.length} entities from cache (blacklist: ${blacklist.size})`;

    logMessage("INFO", haContext.summary);
    markContextReady();
  } catch (err) {
    logMessage("WARN", `[Context] Unable to load cache: ${err.message}`);
  }
}

async function persistContextSnapshot(entities, searchIndex) {
  try {
    await fs.mkdir(path.dirname(CONTEXT_CACHE_PATH), { recursive: true });
    await fs.writeFile(
      CONTEXT_CACHE_PATH,
      JSON.stringify(
        {
          generatedAt: haContext.lastUpdated.toISOString(),
          entities,
          searchIndex,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    logMessage("WARN", `[Context] Failed to persist snapshot: ${err.message}`);
  }
}

function mapEntityFromState(item) {
  const domain = item.entity_id.split(".")[0];
  const attributes = item.attributes || {};
  const supportedColorModes = attributes.supported_color_modes || [];
  const supportedFeatures = attributes.supported_features || 0;
  const supportsBrightness =
    domain === "light" &&
    (attributes.brightness !== undefined ||
      attributes.brightness_pct !== undefined ||
      (Array.isArray(supportedColorModes) &&
        supportedColorModes.some((mode) =>
          [
            "brightness",
            "hs",
            "xy",
            "rgb",
            "rgbw",
            "rgbww",
            "white",
            "color_temp",
          ].includes(String(mode).toLowerCase()),
        )) ||
      (typeof supportedFeatures === "number" && (supportedFeatures & 1) === 1));

  const normalized = [
    attributes.friendly_name,
    item.entity_id,
    attributes.area,
    attributes.room,
    domain,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return {
    entity_id: item.entity_id,
    domain,
    name: attributes.friendly_name || item.entity_id,
    area: attributes.area || attributes.room || null,
    state: item.state,
    attributes,
    supportsBrightness,
    normalized,
  };
}

function groupEntities(entities) {
  return entities.reduce((acc, entity) => {
    if (!acc[entity.domain]) acc[entity.domain] = [];
    acc[entity.domain].push(entity);
    return acc;
  }, {});
}

function ensureBlacklistExists(entities) {
  try {
    fsSync.mkdirSync(path.dirname(BLACKLIST_PATH), { recursive: true });
    if (!fsSync.existsSync(BLACKLIST_PATH)) {
      const content = entities.map((entity) => entity.entity_id).join("\n");
      fsSync.writeFileSync(BLACKLIST_PATH, content, "utf8");
      logMessage(
        "INFO",
        `[Context] Created blacklist with ${entities.length} entries at ${BLACKLIST_PATH}`,
      );
    }
  } catch (err) {
    logMessage(
      "WARN",
      `[Context] Failed to ensure blacklist file: ${err.message}`,
    );
  }
}

function loadBlacklist() {
  try {
    const raw = fsSync.readFileSync(BLACKLIST_PATH, "utf8");
    return new Set(
      raw
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch (err) {
    return new Set();
  }
}

function resolveDomainsForSummary(requested = []) {
  const prioritized = Array.from(new Set([...requested]));
  const domainsWithData = prioritized.filter(
    (domain) => (haContext.grouped[domain] || []).length,
  );

  const result = domainsWithData.slice(0, 5);

  if (result.length < 3) {
    for (const domain of DEFAULT_SUMMARY_DOMAINS) {
      if (
        !result.includes(domain) &&
        (haContext.grouped[domain] || []).length
      ) {
        result.push(domain);
      }
      if (result.length >= 5) break;
    }
  }

  if (!result.length) {
    result.push(DEFAULT_SUMMARY_DOMAINS[0]);
  }

  return result;
}
