import path from "path";

export const CONTEXT_CACHE_PATH =
  process.env.HA_CONTEXT_CACHE_PATH ||
  path.join(process.cwd(), "cache", "ha_context.json");
export const BLACKLIST_PATH = path.join(
  process.cwd(),
  "config",
  "ha_blacklist.txt",
);
export const ALIASES_PATH = path.join(
  process.cwd(),
  "config",
  "aliases.json",
);
export const LOG_DIR = path.join(process.cwd(), "logs");
export const LOG_PATH = path.join(LOG_DIR, "bridge.log");

export const DEFAULT_SUMMARY_DOMAINS = [
  "light",
  "switch",
  "climate",
  "sensor",
  "fan",
  "cover",
  "scene",
  "media_player",
  "lock",
];

export const DOMAIN_KEYWORDS = [
  {
    domain: "light",
    keywords: [
      "light",
      "lamp",
      "bulb",
      "lights",
      "illum",
      "spotlight",
      "chandelier",
    ],
  },
  { domain: "switch", keywords: ["switch", "plug", "outlet", "socket"] },
  {
    domain: "climate",
    keywords: [
      "climate",
      "thermostat",
      "ac",
      "aircon",
      "temperature",
      "heat",
      "cool",
      "hvac",
    ],
  },
  {
    domain: "sensor",
    keywords: [
      "sensor",
      "temperature",
      "humidity",
      "motion",
      "contact",
      "door sensor",
      "window sensor",
    ],
  },
  { domain: "fan", keywords: ["fan", "ceiling fan", "vent"] },
  {
    domain: "cover",
    keywords: [
      "blind",
      "blinds",
      "shade",
      "curtain",
      "garage",
      "cover",
      "shutter",
    ],
  },
  { domain: "scene", keywords: ["scene", "preset", "mode"] },
  {
    domain: "media_player",
    keywords: [
      "tv",
      "television",
      "speaker",
      "music",
      "media",
      "roku",
      "chromecast",
      "sonos",
    ],
  },
  { domain: "lock", keywords: ["lock", "door lock", "smart lock"] },
];

/** Short tokens that carry strong meaning in home-automation context. */
export const SHORT_TOKEN_WHITELIST = new Set([
  "ac",
  "tv",
  "ir",
  "fan",
  "led",
  "pir",
]);

/** Common English stop words that add noise to entity matching. */
export const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "get",
  "set",
  "its",
  "how",
  "did",
  "let",
  "say",
  "she",
  "too",
  "use",
  "way",
  "who",
  "may",
  "any",
  "new",
  "now",
  "old",
  "see",
  "also",
  "back",
  "been",
  "call",
  "come",
  "each",
  "find",
  "from",
  "give",
  "have",
  "here",
  "just",
  "know",
  "like",
  "look",
  "make",
  "many",
  "more",
  "most",
  "much",
  "must",
  "name",
  "only",
  "over",
  "show",
  "some",
  "take",
  "tell",
  "than",
  "that",
  "them",
  "then",
  "they",
  "this",
  "time",
  "turn",
  "very",
  "want",
  "well",
  "went",
  "what",
  "when",
  "will",
  "with",
  "would",
  "about",
  "after",
  "could",
  "every",
  "first",
  "found",
  "great",
  "where",
  "which",
  "their",
  "there",
  "these",
  "thing",
  "think",
  "those",
  "being",
  "other",
  "should",
  "please",
  "switch",
]);

/**
 * Tokenize text for entity matching.
 * Keeps tokens >= 3 chars, plus whitelisted short tokens (ac, tv, etc.).
 * Shared between haContext (for IDF) and resolver (for scoring).
 */
export function tokenizeForMatch(text = "") {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token &&
        (token.length >= 3 || SHORT_TOKEN_WHITELIST.has(token)),
    );
}
