import axios from "axios";
import crypto from "crypto";
import { OpenAI } from "openai";

import { logMessage } from "./logger.js";
import { buildDomainSummary } from "./haContext.js";
import {
  buildRelevantEntitiesSnippet,
  inferDomainsFromText,
} from "./resolver.js";
import { formatHistory, updateUserLastEntity } from "./memory.js";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TEMPERATURE = parseFloat(process.env.OPENAI_TEMPERATURE || "0.2");

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export function hasPlanner() {
  return Boolean(openaiClient);
}

const planSchema = {
  name: "home_assistant_plan",
  schema: {
    type: "object",
    properties: {
      reasoning: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: [
                "call_service",
                "get_state",
                "reply_only",
                "list_from_context",
              ],
            },
            service: { type: "string" },
            entity_id: { type: "string" },
            domain: { type: "string" },
            limit: { type: "integer" },
            filter: { type: "string" },
            data: { type: "object", additionalProperties: true },
            expected_result: { type: "string" },
            response_hint: { type: "string" },
          },
          required: ["id", "type"],
          additionalProperties: false,
        },
      },
      final_response: { type: "string" },
    },
    required: ["actions", "final_response"],
    additionalProperties: false,
  },
};

export async function planSmartAction({
  text,
  sender,
  history,
  correlationId,
}) {
  if (!openaiClient) {
    throw new Error("Planner unavailable");
  }

  const requestedDomains = inferDomainsFromText(text);
  const domainSummary = buildDomainSummary(requestedDomains);
  const candidateEntities = buildRelevantEntitiesSnippet(text, {
    domains: requestedDomains,
    limit: 50,
  });
  const historyPrompt = formatHistory(history);

  const messages = [
    {
      role: "system",
      content: `You plan Home Assistant commands for a WhatsApp smart-home bridge.
- Use only JSON matching the provided schema.
- You have two data sources:
  1) Known devices summary (entity_id, name, area, state)
  2) Home Assistant services/state endpoints (call_service, get_state)
- When the user asks to list or describe devices, add a list_from_context action using the known devices summary (no service call needed). list_from_context MUST include the domain field (e.g. "light").
- When controlling hardware, add call_service actions with accurate entity_ids and data.
- When the user asks about state or status, include a get_state action for the referenced entity (unless it was already fetched in this plan).
- Provide the most helpful final_response that references the executed actions or listed devices.
- If the user request is unclear, ask for clarification in final_response and return empty actions.`,
    },
    {
      role: "user",
      content: `Requested domains to focus on: ${requestedDomains.length ? requestedDomains.join(", ") : "default domains"}\n\nDomain counts:\n${domainSummary}\n\nDirect name matches for this request:\n${candidateEntities}\n\nConversation history:\n${historyPrompt}\n\nCurrent user (${sender}) says:\n${text}`,
    },
  ];

  const response = await openaiClient.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: OPENAI_TEMPERATURE,
    response_format: { type: "json_schema", json_schema: planSchema },
    messages,
  });

  const usage = response.usage || {};
  const content = response.choices?.[0]?.message?.content;
  const jsonPayload = Array.isArray(content)
    ? content
        .map((item) => item.text || item)
        .join("")
        .trim()
    : (content || "").trim();

  if (!jsonPayload) {
    throw new Error("Planner returned empty response.");
  }

  let plan;
  try {
    plan = JSON.parse(jsonPayload);
  } catch (err) {
    logMessage(
      "ERROR",
      `[Planner ${correlationId}] JSON parse error: ${jsonPayload}`,
    );
    throw err;
  }

  plan.__tokens = usage;
  logMessage("INFO", `[Planner ${correlationId}] Plan ${JSON.stringify(plan)}`);
  return plan;
}

export async function executePlan(plan, correlationId, sender, haConfig) {
  const { haBaseUrl, haToken } = haConfig;
  if (!haBaseUrl || !haToken) {
    throw new Error("Missing HA configuration");
  }

  const results = [];
  logMessage(
    "INFO",
    `[Plan ${correlationId}] Executing ${plan.actions.length} actions`,
  );

  for (const action of plan.actions) {
    const actionId = action.id || crypto.randomUUID();

    if (action.type === "reply_only") {
      results.push({
        id: actionId,
        type: action.type,
        success: true,
        message: action.response_hint || "Responded without changes.",
      });
      continue;
    }

    if (action.type === "call_service") {
      const result = await executeServiceAction({
        action,
        actionId,
        correlationId,
        haBaseUrl,
        haToken,
      });
      if (result.success) {
        updateUserLastEntity(sender, action.entity_id);
      }
      results.push(result);
      continue;
    }

    if (action.type === "get_state") {
      const result = await executeGetStateAction({
        action,
        actionId,
        correlationId,
        haBaseUrl,
        haToken,
      });
      if (result.success) {
        updateUserLastEntity(sender, action.entity_id);
      }
      results.push(result);
      continue;
    }

    if (action.type === "list_from_context") {
      results.push({
        id: actionId,
        type: action.type,
        success: true,
        message: action.response_hint || "Listed devices from context.",
      });
      continue;
    }

    results.push({
      id: actionId,
      type: action.type,
      success: false,
      message: "Unsupported action type.",
    });
  }

  const summary = summarizeResults(results);
  return [plan.final_response, summary].filter(Boolean).join("\n");
}

async function executeServiceAction({
  action,
  actionId,
  correlationId,
  haBaseUrl,
  haToken,
}) {
  if (!action.service || !action.entity_id) {
    return {
      id: actionId,
      type: "call_service",
      success: false,
      message: "Missing service or entity_id.",
    };
  }

  const [domain, service] = action.service.split(".") || [];
  if (!domain || !service) {
    return {
      id: actionId,
      type: "call_service",
      success: false,
      message: "Invalid service format.",
    };
  }

  try {
    await axios.post(
      `${haBaseUrl}/api/services/${domain}/${service}`,
      {
        entity_id: action.entity_id,
        ...(action.data || {}),
      },
      {
        headers: {
          Authorization: `Bearer ${haToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    logMessage(
      "INFO",
      `[Command ${correlationId}] ${action.service} → ${action.entity_id}`,
    );
    return {
      id: actionId,
      type: "call_service",
      success: true,
      message:
        action.expected_result ||
        `${action.service} executed for ${action.entity_id}`,
    };
  } catch (err) {
    logMessage(
      "ERROR",
      `[Command ${correlationId}] Failed ${action.service}: ${err.response?.data || err.message}`,
    );
    return {
      id: actionId,
      type: "call_service",
      success: false,
      message:
        err.response?.data?.message || err.message || "Service call failed.",
    };
  }
}

async function executeGetStateAction({
  action,
  actionId,
  correlationId,
  haBaseUrl,
  haToken,
}) {
  if (!action.entity_id) {
    return {
      id: actionId,
      type: "get_state",
      success: false,
      message: "Missing entity_id.",
    };
  }

  try {
    const res = await axios.get(`${haBaseUrl}/api/states/${action.entity_id}`, {
      headers: {
        Authorization: `Bearer ${haToken}`,
      },
    });

    const state = res.data?.state;
    const friendly = res.data?.attributes?.friendly_name || action.entity_id;

    logMessage(
      "INFO",
      `[Query ${correlationId}] ${action.entity_id} is ${state}`,
    );
    return {
      id: actionId,
      type: "get_state",
      success: true,
      message: `${friendly} is ${state}`,
      data: { state, attributes: res.data?.attributes },
    };
  } catch (err) {
    logMessage(
      "ERROR",
      `[Query ${correlationId}] Failed state for ${action.entity_id}: ${err.response?.data || err.message}`,
    );
    return {
      id: actionId,
      type: "get_state",
      success: false,
      message:
        err.response?.data?.message || err.message || "State fetch failed.",
    };
  }
}

function summarizeResults(results) {
  if (!results.length) {
    return "";
  }

  return results
    .map((result) => {
      const prefix = result.success ? "✅" : "⚠️";
      return `${prefix} ${result.message}`;
    })
    .join("\n");
}
