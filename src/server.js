import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";

import { logMessage, logTokens } from "./logger.js";
import {
  startHaContextLoop,
  waitForContextReady,
  dumpContextToLogs,
} from "./haContext.js";
import {
  getConversationHistory,
  appendConversationHistory,
  updateUserLastEntity,
  getLastEntityId,
} from "./memory.js";
import {
  detectStateQueryCommand,
  detectPronounCommand,
  detectBrightnessCommand,
  detectDirectAliasCommand,
  fallbackSimpleHandler,
  isDiagnosticCommand,
} from "./resolver.js";
import { planSmartAction, executePlan, hasPlanner } from "./planner.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "change-me";
const META_WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const HA_BASE_URL = process.env.HA_BASE_URL;
const HA_TOKEN = process.env.HA_TOKEN;
const HA_CONTEXT_REFRESH_MS = parseInt(
  process.env.HA_CONTEXT_REFRESH_MS || "300000",
  10,
);

startHaContextLoop({
  haBaseUrl: HA_BASE_URL,
  haToken: HA_TOKEN,
  refreshMs: HA_CONTEXT_REFRESH_MS,
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    (body.entry || []).forEach((entry) => {
      (entry.changes || []).forEach((change) => {
        const value = change.value || {};
        const messages = value.messages || [];
        messages.forEach((message) => {
          handleMessage(message).catch((err) => {
            logMessage("ERROR", `[Message] handler error: ${err.message}`);
          });
        });
      });
    });

    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.sendStatus(404);
});

async function handleMessage(message) {
  const from = message.from;
  const type = message.type;
  const correlationId = message.id || crypto.randomUUID();

  if (type !== "text") {
    logMessage(
      "WARN",
      `[Message ${correlationId}] Unsupported message type: ${type}`,
    );
    await sendWhatsAppMessage(
      from,
      "Sorry, I only understand text commands right now.",
    );
    return;
  }

  const text = (message.text?.body || "").trim();
  logMessage("INFO", `[Message ${correlationId}] ${from}: ${text}`);

  const history = getConversationHistory(from);
  const reply = await processTextCommand({
    text,
    sender: from,
    history,
    correlationId,
  });

  await sendWhatsAppMessage(from, reply);

  appendConversationHistory(from, "user", text);
  appendConversationHistory(from, "assistant", reply);
}

async function processTextCommand({ text, sender, history, correlationId }) {
  let tokensLogged = false;
  const ensureTokensLogged = (
    tokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  ) => {
    if (!tokensLogged) {
      logTokens(correlationId, sender, tokens);
      tokensLogged = true;
    }
  };

  if (!text) {
    ensureTokensLogged();
    return 'Send a command like "turn on kitchen light" or "status whiskey".';
  }

  if (!HA_BASE_URL || !HA_TOKEN) {
    logMessage("WARN", "[Config] Missing HA_BASE_URL or HA_TOKEN.");
    ensureTokensLogged();
    return "Home Assistant connection is not configured.";
  }

  if (isDiagnosticCommand(text)) {
    await waitForContextReady();
    dumpContextToLogs(`whatsapp-${sender || "unknown"}`);
    ensureTokensLogged();
    return "Context snapshot written to logs.";
  }

  const stateQuery = detectStateQueryCommand(text);
  if (stateQuery) {
    const result = await fetchEntityState(stateQuery.entity_id);
    ensureTokensLogged();
    if (result.success) {
      updateUserLastEntity(sender, stateQuery.entity_id);
      return result.message;
    }
    return result.message || "Failed to get status.";
  }

  const pronounAction = detectPronounCommand(text, sender, { getLastEntityId });
  if (pronounAction) {
    const result = await callHaService(
      pronounAction.service,
      pronounAction.entity_id,
      pronounAction.data,
    );
    ensureTokensLogged();
    if (result.success) {
      updateUserLastEntity(sender, pronounAction.entity_id);
      return pronounAction.successMessage || "Done.";
    }
    return result.message || "Command failed.";
  }

  const brightnessAction = detectBrightnessCommand(text, sender, {
    getLastEntityId,
  });
  if (brightnessAction) {
    const actionResults = [];
    for (const action of brightnessAction.actions) {
      const result = await callHaService(
        action.service,
        action.entity_id,
        action.data,
      );
      actionResults.push(result);
      if (result.success) {
        updateUserLastEntity(sender, action.entity_id);
      }
    }
    ensureTokensLogged();
    const failed = actionResults.find((item) => !item.success);
    if (failed) {
      return failed.message || "Command failed.";
    }
    return brightnessAction.successMessage || "Done.";
  }

  const directAction = detectDirectAliasCommand(text, sender);
  if (directAction) {
    const actionResults = [];
    for (const action of directAction.actions) {
      const result = await callHaService(
        action.service,
        action.entity_id,
        action.data,
      );
      actionResults.push(result);
      if (result.success) {
        updateUserLastEntity(sender, action.entity_id);
      }
    }
    ensureTokensLogged();
    const failed = actionResults.find((item) => !item.success);
    if (failed) {
      return failed.message || "Command failed.";
    }
    return directAction.successMessage || "Done.";
  }

  if (hasPlanner()) {
    try {
      const plan = await planSmartAction({
        text,
        sender,
        history,
        correlationId,
      });
      logTokens(correlationId, sender, plan?.__tokens || {});
      tokensLogged = true;
      const response = await executePlan(plan, correlationId, sender, {
        haBaseUrl: HA_BASE_URL,
        haToken: HA_TOKEN,
      });
      return response;
    } catch (err) {
      logMessage("ERROR", `[Planner ${correlationId}] Failed: ${err.message}`);
      ensureTokensLogged();
    }
  }

  ensureTokensLogged();
  return await fallbackSimpleHandler(text);
}

async function callHaService(service, entityId, data = {}) {
  if (!service || !entityId) {
    return { success: false, message: "Missing service or entity." };
  }

  const [domain, action] = service.split(".") || [];
  if (!domain || !action) {
    return { success: false, message: "Invalid service format." };
  }

  try {
    await axios.post(
      `${HA_BASE_URL}/api/services/${domain}/${action}`,
      {
        entity_id: entityId,
        ...(data || {}),
      },
      {
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );

    logMessage("INFO", `[Command] ${service} → ${entityId}`);
    return { success: true };
  } catch (err) {
    logMessage(
      "ERROR",
      `[Command] Failed ${service}: ${err.response?.data || err.message}`,
    );
    return {
      success: false,
      message: err.response?.data?.message || err.message,
    };
  }
}

async function fetchEntityState(entityId) {
  try {
    const res = await axios.get(`${HA_BASE_URL}/api/states/${entityId}`, {
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
      },
    });

    const state = res.data?.state;
    const friendly = res.data?.attributes?.friendly_name || entityId;
    logMessage("INFO", `[Query] ${entityId} is ${state}`);
    return { success: true, message: `${friendly} is ${state}` };
  } catch (err) {
    logMessage(
      "ERROR",
      `[Query] Failed ${entityId}: ${err.response?.data || err.message}`,
    );
    return {
      success: false,
      message: err.response?.data?.message || err.message,
    };
  }
}

async function sendWhatsAppMessage(to, body) {
  if (!META_WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    logMessage("WARN", "WhatsApp credentials missing. Skipping reply.");
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    logMessage(
      "ERROR",
      `[WhatsApp] Failed to send message: ${err.response?.data || err.message}`,
    );
  }
}

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  logMessage("INFO", `WhatsApp webhook listening on port ${PORT}`);
});
