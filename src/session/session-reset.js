export async function prepareForSessionReset(session) {
  session.queue = [];
  await session.abortCurrentRun();
  session.stopTyping();
  session.resetTransientTurnState();
}

export async function resetSession(session, { clearPersistedState = false } = {}) {
  await prepareForSessionReset(session);
  if (clearPersistedState) {
    await session.clearPersistedState();
  }
}
