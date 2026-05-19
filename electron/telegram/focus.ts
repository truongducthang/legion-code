/**
 * Main-side cache of the renderer's focused agent id. Voice transcripts and
 * reply-chain fallbacks read this when no `<id>` is in the chat message.
 */

let focusedAgentId: string | null = null;

export function setFocusedAgent(agentId: string | null): void {
  focusedAgentId = agentId;
}

export function getFocusedAgent(): string | null {
  return focusedAgentId;
}
