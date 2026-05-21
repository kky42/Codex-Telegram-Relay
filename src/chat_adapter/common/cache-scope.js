import crypto from "node:crypto";
import path from "node:path";

import { ensureDir, writeJsonFileAtomic } from "../../utils.js";

function normalizeScopeValue(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function buildCacheScope({
  cacheRootDir,
  agentId,
  platform,
  bindingId,
  conversationId
}) {
  const scope = {
    agentId: normalizeScopeValue(agentId, "unknown-agent"),
    platform: normalizeScopeValue(platform, "unknown-platform"),
    bindingId: normalizeScopeValue(bindingId, "unknown-binding"),
    conversationId: normalizeScopeValue(conversationId, "unknown-conversation")
  };
  const scopeKey = `${scope.agentId}:${scope.platform}:${scope.bindingId}:${scope.conversationId}`;
  const scopeHash = crypto.createHash("sha256").update(scopeKey).digest("hex").slice(0, 8);

  return {
    ...scope,
    scopeKey,
    scopeHash,
    scopeDir: path.join(cacheRootDir, scopeHash)
  };
}

export async function ensureCacheScope(scope) {
  await ensureDir(scope.scopeDir);
  await writeJsonFileAtomic(path.join(scope.scopeDir, "scope.json"), {
    agentId: scope.agentId,
    platform: scope.platform,
    bindingId: scope.bindingId,
    conversationId: scope.conversationId,
    scopeKey: scope.scopeKey
  });
}
