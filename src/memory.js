const conversationMemory = new Map();
const userRuntimeState = new Map();

export function getConversationHistory(user) {
  return conversationMemory.get(user) || [];
}

export function appendConversationHistory(user, role, content) {
  if (!content) return;

  const history = conversationMemory.get(user) || [];
  history.push({ role, content, at: new Date().toISOString() });

  const maxEntries = 20; // 10 exchanges
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }

  conversationMemory.set(user, history);
}

export function formatHistory(history) {
  if (!history || !history.length) {
    return "No previous conversation.";
  }

  return history
    .slice(-20)
    .map(
      (item) =>
        `${item.role === "assistant" ? "Assistant" : "User"}: ${item.content}`,
    )
    .join("\n");
}

export function updateUserLastEntity(user, entityId) {
  if (!user || !entityId) return;
  const state = userRuntimeState.get(user) || {};
  state.lastEntityId = entityId;
  userRuntimeState.set(user, state);
}

export function getLastEntityId(user) {
  return userRuntimeState.get(user)?.lastEntityId;
}
