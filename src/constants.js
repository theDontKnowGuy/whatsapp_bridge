import path from "path";

export const CONTEXT_CACHE_PATH =
  process.env.HA_CONTEXT_CACHE_PATH ||
  path.join(process.cwd(), "cache", "ha_context.json");
export const BLACKLIST_PATH = path.join(
  process.cwd(),
  "config",
  "ha_blacklist.txt",
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
