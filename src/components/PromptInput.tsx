import { createSignal, createEffect, on, Show, onMount, onCleanup, untrack } from 'solid-js';
import { fireAndForget, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  store,
  sendPrompt,
  registerFocusFn,
  unregisterFocusFn,
  registerAction,
  unregisterAction,
  getAgentOutputTail,
  stripAnsi,
  onAgentReady,
  offAgentReady,
  normalizeCurrentFrame,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
  isAutoTrustSettling,
  isAgentAskingQuestion,
  getTaskFocusedPanel,
  setTaskFocusedPanel,
  setTaskLastInputAt,
  isPanelFocused,
  setTaskControl,
  showNotification,
} from '../store/store';
import { clearStagedNotification, setStagedNotificationUserEdited } from '../store/tasks';
import { processAutoFireTick } from './autofire-tick';
import { shouldHandoffCoordinatorQuestion } from './prompt-control';
import type { StagedNotification } from '../store/types';
import { debug, warn as logWarn } from '../lib/log';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

export interface PromptInputHandle {
  getText: () => string;
  setText: (value: string) => void;
}

interface PromptInputProps {
  taskId: string;
  agentId: string;
  coordinatedBy?: string;
  coordinatorMode?: boolean;
  controlledBy?: 'human' | 'coordinator';
  stagedNotification?: StagedNotification;
  nowMs?: () => number;
  initialPrompt?: string;
  prefillPrompt?: string;
  onPrefillConsumed?: () => void;
  onSend?: (text: string) => void;
  ref?: (el: HTMLTextAreaElement) => void;
  handle?: (h: PromptInputHandle) => void;
}

// Quiescence: how often to snapshot and how long output must be stable.
const QUIESCENCE_POLL_MS = 500;
const QUIESCENCE_THRESHOLD_MS = 1_500;
// Never auto-send before this (agent still booting).
const AUTOSEND_MIN_WAIT_MS = 500;
// After detecting the agent's prompt (❯/›), wait this long and re-verify
// it's still visible before sending.  Catches transient prompt renders
// during initialization (e.g. Claude Code renders ❯ before fully loading).
const PROMPT_RECHECK_DELAY_MS = 1_500;
// How many consecutive stability checks must pass before auto-sending.
// Each check verifies ❯ is present AND output hasn't changed since the
// previous check.  Multiple checks catch agents that render ❯ early and
// then silently load (no PTY output) — a single check can't distinguish
// "silently loading" from "truly idle at prompt".
const PROMPT_STABILITY_CHECKS = 2;
// How many consecutive stability-check failures (prompt visible but still changing)
// before we relax the isStable requirement and send anyway.
const STABILITY_MAX_FAILURES = 3;
// Give up after this.
const AUTOSEND_MAX_WAIT_MS = 45_000;
// After sending, how long to poll terminal output to confirm the prompt appeared.
const PROMPT_VERIFY_TIMEOUT_MS = 5_000;
const PROMPT_VERIFY_POLL_MS = 250;
const PROMPT_MARKER_SCAN_CHARS = 500;

/** True when auto-send should be blocked by a question in the output.
 *  Trust-dialog questions are NOT blocking when auto-trust handles them. */
const isQuestionBlockingAutoSend = (tail: string): boolean =>
  looksLikeQuestion(tail) && !isTrustQuestionAutoHandled(tail);

export function PromptInput(props: PromptInputProps) {
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [autoSentInitialPrompt, setAutoSentInitialPrompt] = createSignal<string | null>(null);
  let cleanupAutoSend: (() => void) | undefined;

  // Debug: log whenever controlledBy changes (verbose-gated; forwards to /tmp/out via main process)
  createEffect(() => {
    const cb = props.controlledBy;
    const coordBy = props.coordinatedBy;
    if (cb !== undefined || coordBy !== undefined) {
      debug('ctrl', 'controlledBy changed', {
        controlledBy: cb,
        coordinatedBy: coordBy,
        taskId: props.taskId,
        shouldBeDisabled: cb === 'coordinator',
      });
      // Check actual DOM state after all render effects have run
      setTimeout(() => {
        if (textareaRef) {
          const domDisabled = textareaRef.disabled;
          // Match the actual disabled expression: coordinator-controlled OR question active
          const expected = cb === 'coordinator' || questionActive();
          if (domDisabled !== expected) {
            logWarn('ctrl', 'textarea disabled mismatch — DOM vs expected', {
              domDisabled,
              expected,
              controlledBy: cb,
              taskId: props.taskId,
            });
          } else {
            debug('ctrl', 'textarea disabled matches expected', {
              domDisabled,
              controlledBy: cb,
              taskId: props.taskId,
            });
          }
        }
      }, 0);
    }
  });

  createEffect(() => {
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const ip = props.initialPrompt?.trim();
    if (!ip) return;

    setText(ip);
    if (autoSentInitialPrompt() === ip) return;

    const agentId = props.agentId;
    const spawnedAt = Date.now();
    let quiescenceTimer: number | undefined;
    let pendingSendTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRawTail = '';
    let lastNormalized = '';
    // Start stableSince at 0, not Date.now().  Quiescence requires visible
    // content — agents that emit only escape sequences initially (e.g. Copilot
    // CLI entering alternate screen) must not trigger a send before anything
    // meaningful appears.  stableSince is set when the first non-empty
    // normalizeForComparison result is seen and stays updated from there.
    let stableSince = 0;
    let cancelled = false;
    // Counts consecutive stability-check failures where the prompt was visible
    // but the content was still changing (isStable=false).  After
    // STABILITY_MAX_FAILURES attempts we relax the requirement — the agent is
    // already showing its prompt so the content is good enough to send into.
    let stabilityCheckFailures = 0;

    function cleanup() {
      cancelled = true;
      offAgentReady(agentId);
      if (pendingSendTimer) {
        clearTimeout(pendingSendTimer);
        pendingSendTimer = undefined;
      }
      if (quiescenceTimer !== undefined) {
        clearInterval(quiescenceTimer);
        quiescenceTimer = undefined;
      }
    }
    cleanupAutoSend = cleanup;

    function isAgentDead() {
      return store.agents[agentId]?.status === 'exited';
    }

    function trySend() {
      if (cancelled) return;
      if (isAgentDead()) {
        cleanup();
        return;
      }
      // Don't tear down the auto-send mechanism if we can't send yet —
      // the quiescence timer needs to stay alive to retry after settling.
      if (isAutoTrustSettling(agentId)) return;
      cleanup();
      void handleSend('auto');
    }

    // --- FAST PATH: event from markAgentOutput ---
    // Fires when a known prompt pattern (❯, ›) is detected in PTY output.
    // The callback is one-shot (deleted after firing in markAgentOutput),
    // so we re-register when a question guard blocks to keep the fast path alive.
    function onReady() {
      if (cancelled) return;
      if (isQuestionBlockingAutoSend(getAgentOutputTail(agentId))) {
        onAgentReady(agentId, onReady);
        return;
      }
      // Don't start stability checks while auto-trust is actively handling a
      // trust/permission dialog — the ❯ in the TUI selection UI is not the
      // agent's main prompt yet.  Re-register; we'll be called again once the
      // agent fires tryFireAgentReadyCallback after the trust flow completes.
      if (isAutoTrustSettling(agentId)) {
        onAgentReady(agentId, onReady);
        return;
      }

      // Start a series of stability checks.  Some agents (e.g. Claude Code)
      // render ❯ before fully initializing — the marker persists while the
      // agent silently loads (no PTY output).  A single stability check
      // can't catch this, so we require PROMPT_STABILITY_CHECKS consecutive
      // checks to pass (output unchanged + ❯ still present in each).
      if (!pendingSendTimer) {
        startStabilityChecks();
      }
    }

    function startStabilityChecks() {
      stabilityCheckFailures = 0;
      let checksRemaining = PROMPT_STABILITY_CHECKS;
      const elapsed = Date.now() - spawnedAt;
      const recheckDelay =
        store.agents[agentId]?.def?.prompt_ready_delay_ms ?? PROMPT_RECHECK_DELAY_MS;
      const firstDelay = Math.max(recheckDelay, AUTOSEND_MIN_WAIT_MS - elapsed);

      function scheduleCheck(delay: number) {
        const snapshot = normalizeCurrentFrame(getAgentOutputTail(agentId));
        pendingSendTimer = setTimeout(() => {
          pendingSendTimer = undefined;
          if (cancelled) return;
          const tail = getAgentOutputTail(agentId);
          if (isQuestionBlockingAutoSend(tail)) {
            onAgentReady(agentId, onReady);
            return;
          }
          if (isAutoTrustSettling(agentId)) {
            onAgentReady(agentId, onReady);
            return;
          }
          const normalized = normalizeCurrentFrame(tail);
          const hasPrompt = /[❯›]/.test(stripAnsi(tail).slice(-PROMPT_MARKER_SCAN_CHARS));
          const isStable = normalized === snapshot;
          if (!hasPrompt || (!isStable && stabilityCheckFailures < STABILITY_MAX_FAILURES)) {
            if (hasPrompt && !isStable) stabilityCheckFailures++;
            onAgentReady(agentId, onReady);
            return;
          }
          // When isStable is false but we've exceeded failure limit, proceed anyway —
          // the prompt is visible and the agent is ready enough.
          checksRemaining--;
          if (checksRemaining <= 0) {
            trySend();
          } else {
            scheduleCheck(recheckDelay);
          }
        }, delay);
      }

      scheduleCheck(firstDelay);
    }

    onAgentReady(agentId, onReady);

    // --- SLOW PATH: quiescence fallback ---
    // Polls every 500ms.  When a prompt marker (❯/›) is visible, kicks off
    // the same stability checks as the fast path (needed when the agent is
    // idle and no new PTY data would trigger the fast-path callback).
    // For agents without recognizable prompt markers, falls through to pure
    // quiescence (1.5s of stable output).
    quiescenceTimer = window.setInterval(() => {
      if (cancelled) return;
      if (isAgentDead()) {
        cleanup();
        return;
      }
      const elapsed = Date.now() - spawnedAt;

      if (elapsed > AUTOSEND_MAX_WAIT_MS) {
        cleanup();
        return;
      }
      if (elapsed < AUTOSEND_MIN_WAIT_MS) return;
      // After auto-trust acceptance, wait for the agent to fully initialize.
      if (isAutoTrustSettling(agentId)) return;

      const tail = getAgentOutputTail(agentId);
      if (!tail) return;

      // If a prompt marker is visible, use the fast path's stability checks
      // instead of pure quiescence — they verify ❯ persists AND output is stable.
      // Kick off the checks directly rather than just re-registering a callback,
      // because the agent may be idle (no new PTY data to trigger the callback).
      // Guard: skip if the agent is known to be showing a question (e.g. a TUI
      // dialog with a ❯ selection cursor).  The stability check inside also guards,
      // but skipping here avoids scheduling unnecessary timers.
      if (/[❯›]/.test(stripAnsi(tail).slice(-PROMPT_MARKER_SCAN_CHARS))) {
        if (!pendingSendTimer && !questionActive()) startStabilityChecks();
        return;
      }

      // Skip expensive normalization if raw tail hasn't changed.
      if (tail === lastRawTail) {
        if (stableSince > 0 && Date.now() - stableSince >= QUIESCENCE_THRESHOLD_MS) {
          if (!isQuestionBlockingAutoSend(tail)) {
            trySend();
          } else {
            stableSince = Date.now();
          }
        }
        return;
      }
      lastRawTail = tail;

      const normalized = normalizeCurrentFrame(tail);

      // No visible content yet (e.g. only ANSI setup sequences) — don't start
      // the stability clock until something meaningful appears on screen.
      if (!normalized) return;

      if (normalized !== lastNormalized) {
        lastNormalized = normalized;
        stableSince = Date.now();
        return;
      }

      // First time we see non-empty normalized content, start the clock.
      if (stableSince === 0) {
        stableSince = Date.now();
        return;
      }

      if (Date.now() - stableSince < QUIESCENCE_THRESHOLD_MS) return;

      // Output stable long enough — check it's not a question.
      if (isQuestionBlockingAutoSend(tail)) {
        stableSince = Date.now();
        return;
      }

      trySend();
    }, QUIESCENCE_POLL_MS);
  });

  createEffect(() => {
    const pf = props.prefillPrompt?.trim();
    if (!pf) return;
    setText(pf);
    untrack(() => props.onPrefillConsumed?.());
  });

  // --- Staged coordinator notification auto-fire ---
  let autoFireInterval: number | undefined;
  // Tracks text we populated from a staged notification so we can distinguish
  // it from text the user actually typed when a replacement notification arrives.
  let lastStagedText = '';

  function executeAutoFire(staged: NonNullable<typeof props.stagedNotification>) {
    if (autoFireInterval !== undefined) {
      clearInterval(autoFireInterval);
      autoFireInterval = undefined;
    }
    const taskId = props.taskId;
    const agentId = props.agentId;
    void (async () => {
      try {
        await sendPrompt(taskId, agentId, staged.text);
        await invoke(IPC.MCP_CoordinatorNotificationAck, {
          coordinatorTaskId: taskId,
          batchId: staged.batchId,
        });
        clearStagedNotification(taskId);
        lastStagedText = '';
        setText('');
        logWarn('autofire', 'auto-fire succeeded', { taskId });
      } catch (e) {
        logWarn('autofire', 'auto-fire failed', { taskId, err: String(e) });
        console.error('[coordinator] Auto-fire failed:', e);
      }
    })();
  }
  let autoFirePromptMissCount = 0;

  createEffect(() => {
    const notification = props.stagedNotification;

    if (autoFireInterval !== undefined) {
      clearInterval(autoFireInterval);
      autoFireInterval = undefined;
    }

    if (!notification) return;
    if (notification.userEdited) {
      logWarn('autofire', 'notification staged but userEdited=true — skipping', {
        taskId: props.taskId,
        batchId: notification.batchId,
      });
      return;
    }

    // If the user has typed their own content (not from a previous staged
    // notification), don't overwrite it — treat this notification as user-edited.
    // If the textarea contains text we set from a previous notification that
    // never fired, replace it with the new notification instead.
    const currentText = untrack(() => text());
    if (currentText.trim() && currentText !== lastStagedText) {
      logWarn(
        'autofire',
        'textarea has user content on notification arrival — marking userEdited',
        {
          taskId: props.taskId,
        },
      );
      setStagedNotificationUserEdited(props.taskId);
      return;
    }

    logWarn('autofire', 'notification staged — starting interval', {
      taskId: props.taskId,
      batchId: notification.batchId,
      autoFireAt: new Date(notification.autoFireAt).toISOString(),
      waitMs: notification.autoFireAt - Date.now(),
    });
    lastStagedText = notification.text;
    autoFirePromptMissCount = 0;
    setText(notification.text);
    let lastIntervalTail = '';

    // eslint-disable-next-line solid/reactivity -- intentional untracked reads in interval
    autoFireInterval = window.setInterval(() => {
      // Use untrack — we intentionally read current values on each tick
      // without subscribing to changes (the outer createEffect handles re-runs).
      const staged = untrack(() => props.stagedNotification);
      if (!staged || staged.userEdited) {
        logWarn('autofire', 'interval: notification gone or userEdited — cancelling', {
          taskId: props.taskId,
          gone: !staged,
          userEdited: staged?.userEdited,
        });
        clearInterval(autoFireInterval);
        autoFireInterval = undefined;
        return;
      }
      const currentTail = stripAnsi(untrack(() => getAgentOutputTail(props.agentId)));
      // If the agent produced new output since the last tick it is actively working
      // (e.g. mid-tool-call). Reset the miss counter so a long tool call doesn't
      // accumulate misses and trigger the escalation path prematurely.
      if (currentTail !== lastIntervalTail) {
        autoFirePromptMissCount = 0;
        lastIntervalTail = currentTail;
      }
      const tick = processAutoFireTick({
        staged,
        now: Date.now(),
        controlledBy: untrack(() => store.tasks[props.taskId]?.controlledBy),
        questionActive: untrack(() => questionActive()),
        tail: currentTail,
        currentMissCount: autoFirePromptMissCount,
      });

      if (tick.outcome === 'too-soon') {
        debug('autofire', 'interval: waiting for autoFireAt', {
          taskId: props.taskId,
          remainingMs: staged.autoFireAt - Date.now(),
        });
        return;
      }
      if (tick.outcome === 'paused') {
        return;
      }
      if (tick.outcome === 'no-prompt') {
        autoFirePromptMissCount = tick.newMissCount;
        const tailSnippet = currentTail.slice(-PROMPT_MARKER_SCAN_CHARS);
        if (autoFirePromptMissCount === 1 || autoFirePromptMissCount % 5 === 0) {
          logWarn('autofire', 'prompt not detected after autoFireAt', {
            taskId: props.taskId,
            batchId: staged.batchId,
            missCount: autoFirePromptMissCount,
            hasPrompt: false,
            tailSnippet: tailSnippet.slice(-120).replace(/\n/g, '↵'),
          });
        }
        if (autoFirePromptMissCount >= 10) {
          const taskId = props.taskId;
          const missCount = autoFirePromptMissCount;
          logWarn('autofire', 'miss threshold reached — escalating to orphaned notification', {
            taskId,
            missCount,
          });
          clearInterval(autoFireInterval);
          autoFireInterval = undefined;
          clearStagedNotification(taskId);
          fireAndForget(IPC.MCP_CoordinatorNotificationDropAck, {
            coordinatorTaskId: taskId,
            batchId: staged.batchId,
          });
        }
        return;
      }
      // tick.outcome === 'fire'
      debug('autofire', 'interval: checking prompt marker', {
        taskId: props.taskId,
        batchId: staged.batchId,
        hasPrompt: true,
      });
      autoFirePromptMissCount = 0;
      logWarn('autofire', 'firing notification into coordinator PTY', { taskId: props.taskId });
      executeAutoFire(staged);
    }, 1_000);
  });

  onCleanup(() => {
    if (autoFireInterval !== undefined) {
      clearInterval(autoFireInterval);
      autoFireInterval = undefined;
    }
  });

  // When the user releases control, immediately attempt to fire any pending
  // staged notification rather than waiting up to 1s for the next interval tick.
  createEffect(
    on(
      // eslint-disable-next-line solid/reactivity
      [() => props.controlledBy, () => props.stagedNotification] as const,
      ([cb, staged], prev) => {
        const prevCb = prev?.[0];
        if (cb === 'coordinator' && prevCb === 'human' && staged && !staged.userEdited) {
          const tail = stripAnsi(untrack(() => getAgentOutputTail(props.agentId)));
          const tick = processAutoFireTick({
            staged,
            now: Date.now(),
            controlledBy: cb,
            questionActive: untrack(() => questionActive()),
            tail,
            currentMissCount: autoFirePromptMissCount,
          });
          if (tick.outcome === 'fire') {
            logWarn('autofire', 'immediate fire on control release', { taskId: props.taskId });
            executeAutoFire(staged);
          }
        }
      },
    ),
  );

  // --- Countdown display for auto-fire ---
  // Uses the parent-provided nowMs signal if available (avoids a duplicate interval).
  const autoFireCountdownText = () => {
    const notification = props.stagedNotification;
    if (!notification || notification.userEdited) return null;
    if (props.controlledBy === 'human') return 'Paused — release control to send';
    const now = props.nowMs ? props.nowMs() : Date.now();
    const remaining = Math.ceil((notification.autoFireAt - now) / 1_000);
    return remaining > 0 ? `Auto-sending in ${remaining}s…` : 'Sending when coordinator is ready…';
  };

  // When the agent shows a question/dialog, focus the terminal so the user
  // can interact with the TUI directly.
  const questionActive = () => isAgentAskingQuestion(props.agentId);
  createEffect(() => {
    if (questionActive() && getTaskFocusedPanel(props.taskId) === 'prompt') {
      setTaskFocusedPanel(props.taskId, 'ai-terminal');
    }
  });
  createEffect(
    on(
      // eslint-disable-next-line solid/reactivity
      [questionActive, () => props.controlledBy] as const,
      ([active, controlledBy], prev) => {
        const prevActive = prev?.[0] ?? false;
        // Trigger only when the question becomes newly active (false→true).
        // Do NOT re-take control when coordinator regains it while questionActive
        // is still true — that fires when the user explicitly clicks Release Control
        // but the tail buffer hasn't cleared yet, which immediately overrides them.
        const questionJustActivated = active && !prevActive;
        if (
          questionJustActivated &&
          shouldHandoffCoordinatorQuestion({ controlledBy, questionActive: active })
        ) {
          setTaskControl(props.taskId, 'human');
          setTaskFocusedPanel(props.taskId, 'ai-terminal');
          showNotification('Claude needs input. Answer in the terminal, then Release Control.');
        }
      },
    ),
  );

  let textareaRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    props.handle?.({ getText: text, setText });
    const focusKey = `${props.taskId}:prompt`;
    const actionKey = `${props.taskId}:send-prompt`;
    registerFocusFn(focusKey, () => textareaRef?.focus());
    registerAction(actionKey, () => handleSend());
    onCleanup(() => {
      unregisterFocusFn(focusKey);
      unregisterAction(actionKey);
    });
  });

  onCleanup(() => {
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;
    sendAbortController?.abort();
  });

  async function promptAppearedInOutput(
    agentId: string,
    prompt: string,
    preSendTail: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const snippet = stripAnsi(prompt).slice(0, 40);
    if (!snippet) return true;
    // If the snippet was already visible before send, skip verification
    // to avoid false positives.
    if (stripAnsi(preSendTail).includes(snippet)) return true;

    const deadline = Date.now() + PROMPT_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) return false;
      const tail = stripAnsi(getAgentOutputTail(agentId));
      if (tail.includes(snippet)) return true;
      await new Promise((r) => setTimeout(r, PROMPT_VERIFY_POLL_MS));
    }
    return false;
  }

  let sendAbortController: AbortController | undefined;

  async function handleSend(mode: 'manual' | 'auto' = 'manual') {
    if (sending()) return;
    if (mode === 'manual' && props.controlledBy === 'coordinator') return;
    // Block sends while the agent is showing a question/dialog.
    // For auto-sends, use a fresh tail-buffer check instead of the reactive
    // signal — the signal may be stale (updated by throttled analysis) while
    // the callers (onReady, quiescence timer) already verified with fresh data.
    if (mode === 'auto') {
      const tail = getAgentOutputTail(props.agentId);
      if (isQuestionBlockingAutoSend(tail)) {
        return;
      }
      if (isAutoTrustSettling(props.agentId)) {
        return;
      }
    } else {
      if (questionActive()) return;
      // Also block manual sends while auto-trust is actively handling a trust
      // dialog.  With autoTrustFolders enabled, questionActive is suppressed to
      // false for trust dialogs so the textarea stays enabled — but the user
      // must not accidentally send text into the dialog before auto-trust
      // accepts it (the \r from sendPrompt would confirm the TUI selection).
      if (isAutoTrustSettling(props.agentId)) return;
    }
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const val = text().trim();
    if (!val) {
      if (mode === 'auto') return;
      fireAndForget(IPC.WriteToAgent, { agentId: props.agentId, data: '\r' });
      setTaskLastInputAt(props.taskId);
      return;
    }

    sendAbortController?.abort();
    sendAbortController = new AbortController();
    const { signal } = sendAbortController;

    setSending(true);
    try {
      // Snapshot tail before send for verification comparison.
      const preSendTail = getAgentOutputTail(props.agentId);
      await sendPrompt(props.taskId, props.agentId, val);

      if (mode === 'auto') {
        // Wait for the prompt to appear in output before clearing the text field.
        await promptAppearedInOutput(props.agentId, val, preSendTail, signal);
      }

      if (signal.aborted) return;

      if (props.initialPrompt?.trim()) {
        setAutoSentInitialPrompt(props.initialPrompt.trim());
        if (props.coordinatedBy) {
          invoke(IPC.MCP_CoordinatedTaskPromptDelivered, { taskId: props.taskId }).catch(() => {});
        }
      }
      // If the user manually sent the staged notification text exactly, ack it
      const staged = props.stagedNotification;
      if (staged && !staged.userEdited && val === staged.text) {
        const ackTaskId = props.taskId;
        invoke(IPC.MCP_CoordinatorNotificationAck, {
          coordinatorTaskId: ackTaskId,
          batchId: staged.batchId,
        })
          .then(() => clearStagedNotification(ackTaskId))
          .catch(() => {});
      } else if (staged?.userEdited && staged.notificationIds.length > 0) {
        // User sent their own message while a coordinator notification was pending.
        // Reschedule the re-stage timer so the pending notifications reappear after
        // COORDINATOR_RESTAMP_DELAY_MS, independently of new sub-task completions.
        invoke(IPC.MCP_CoordinatorRestageAfterUserSend, {
          coordinatorTaskId: props.taskId,
        }).catch(() => {});
      }
      props.onSend?.(val);
      lastStagedText = '';
      setText('');
    } catch (e) {
      console.error('Failed to send prompt:', e);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      class="focusable-panel prompt-input-panel"
      data-panel-focused={isPanelFocused(props.taskId, 'prompt') ? 'true' : 'false'}
      style={{ display: 'flex', height: '100%', padding: '4px 6px', 'border-radius': '12px' }}
    >
      <div style={{ position: 'relative', flex: '1', display: 'flex' }}>
        <Show when={!!props.stagedNotification && !props.stagedNotification.userEdited}>
          <div
            style={{
              position: 'absolute',
              top: '4px',
              left: '8px',
              'font-size': '10px',
              color: theme.accent,
              background: `${theme.accent}22`,
              padding: '1px 6px',
              'border-radius': '3px',
              'pointer-events': 'none',
              'z-index': '1',
            }}
          >
            Staged for auto-send
          </div>
        </Show>
        <textarea
          class="prompt-textarea"
          ref={(el) => {
            textareaRef = el;
            props.ref?.(el);
          }}
          rows={3}
          value={text()}
          disabled={questionActive() || props.controlledBy === 'coordinator'}
          onInput={(e) => {
            if (props.controlledBy === 'coordinator') return;
            const val = e.currentTarget.value;
            setText(val);
            const staged = props.stagedNotification;
            if (staged && !staged.userEdited) {
              setStagedNotificationUserEdited(props.taskId);
            }
          }}
          onKeyDown={(e) => {
            if (props.controlledBy === 'coordinator') {
              e.preventDefault();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            props.controlledBy === 'coordinator'
              ? 'Auto mode — click "Take Control" to type'
              : questionActive()
                ? 'Agent is waiting for input in terminal…'
                : 'Send a prompt... (Enter to send, Shift+Enter for newline)'
          }
          style={{
            flex: '1',
            background: theme.bgInput,
            border:
              props.stagedNotification && !props.stagedNotification.userEdited
                ? `1px solid ${theme.accent}60`
                : `1px solid ${theme.border}`,
            'border-radius': '12px',
            padding:
              props.stagedNotification && !props.stagedNotification.userEdited
                ? '20px 36px 6px 10px'
                : '6px 36px 6px 10px',
            color: theme.fg,
            'font-size': sf(13),
            'font-family': "'JetBrains Mono', monospace",
            resize: 'none',
            outline: 'none',
            opacity: questionActive() || props.controlledBy === 'coordinator' ? '0.5' : '1',
          }}
        />
        <button
          class="prompt-send-btn"
          type="button"
          disabled={!text().trim() || questionActive() || props.controlledBy === 'coordinator'}
          onClick={() => handleSend()}
          style={{
            position: 'absolute',
            right: '6px',
            bottom: '6px',
            width: '24px',
            height: '24px',
            'border-radius': '50%',
            border: 'none',
            background: text().trim() ? theme.accent : theme.bgHover,
            color: text().trim() ? theme.accentText : theme.fgSubtle,
            cursor: text().trim() ? 'pointer' : 'default',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            padding: '0',
            transition: 'background 0.15s, color 0.15s',
          }}
          title="Send prompt"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 12V2M7 2L3 6M7 2l4 4"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <Show
          when={
            !!props.stagedNotification?.userEdited &&
            (props.stagedNotification?.hiddenCompletionCount ?? 0) > 0
          }
        >
          <div
            style={{
              position: 'absolute',
              bottom: '40px',
              right: '6px',
              'font-size': '11px',
              color: theme.fgSubtle,
              background: theme.bgHover,
              padding: '2px 6px',
              'border-radius': '4px',
            }}
          >
            + {props.stagedNotification?.hiddenCompletionCount} more task(s) completed
          </div>
        </Show>
      </div>
      <Show when={autoFireCountdownText() !== null}>
        <div
          style={{
            'font-size': '11px',
            color: theme.fgSubtle,
            padding: '2px 4px',
            'margin-top': '2px',
          }}
        >
          {autoFireCountdownText()}
        </div>
      </Show>
    </div>
  );
}
