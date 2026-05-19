import { createEffect, onCleanup } from 'solid-js';
import { createStore, produce, unwrap } from 'solid-js/store';
import { store } from './core';
import { IPC } from '../../electron/ipc/channels';
import type { HungAgentStatus, HungAgentUpdatePayload } from '../ipc/types';

export interface HungAgentState {
  status: HungAgentStatus;
  lastDataAt: number;
  silentMs: number;
  checkedAt: string;
}

// Fine-grained per-key reactivity so a single agent's badge only re-renders
// the card it belongs to, not every consumer of the map.
const [hungAgents, setHungAgentsStore] = createStore<Record<string, HungAgentState>>({});

export function getHungAgentState(agentId: string): HungAgentState | undefined {
  return hungAgents[agentId];
}

function setHungAgent(agentId: string, next: HungAgentState): void {
  setHungAgentsStore(agentId, next);
}

function removeHungAgent(agentId: string): void {
  if (!(agentId in unwrap(hungAgents))) return;
  setHungAgentsStore(
    produce((s) => {
      delete s[agentId];
    }),
  );
}

/** Wire the renderer to the main-process classifier. Subscribes to the
 *  HungAgentUpdate push, drops bookkeeping for agents the main store no
 *  longer knows about (the existing exit handler removes them from
 *  store.agents), and exposes the per-agent badge state. */
export function startHungAgentSubscription(): () => void {
  const offUpdate = window.electron.ipcRenderer.on(IPC.HungAgentUpdate, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const msg = data as Partial<HungAgentUpdatePayload>;
    if (typeof msg.agentId !== 'string') return;
    if (msg.status !== 'active' && msg.status !== 'idle' && msg.status !== 'hung') return;
    if (typeof msg.lastDataAt !== 'number') return;
    if (typeof msg.silentMs !== 'number') return;
    setHungAgent(msg.agentId, {
      status: msg.status,
      lastDataAt: msg.lastDataAt,
      silentMs: msg.silentMs,
      checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString(),
    });
  });

  // Drop badge state when the agent leaves the store (exit, kill, task
  // delete). The main classifier also clears on PTY exit, but a user
  // killing an agent expects the badge to disappear immediately rather
  // than wait for the next tick.
  createEffect(() => {
    const known = new Set(Object.keys(store.agents));
    for (const id of Object.keys(unwrap(hungAgents))) {
      if (!known.has(id)) removeHungAgent(id);
    }
  });

  const cleanup = (): void => {
    offUpdate();
  };

  onCleanup(cleanup);
  return cleanup;
}
