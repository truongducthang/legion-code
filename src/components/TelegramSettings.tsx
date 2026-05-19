import { For, Show, createSignal, createEffect, createUniqueId, onCleanup } from 'solid-js';
import { store } from '../store/core';
import {
  refreshTelegramStatus,
  applyTelegramConfig,
  setTelegramEnabled,
  setTelegramPushPolicy,
  setTelegramToken,
  setTelegramRedactPatterns,
  setTelegramExtraQuestionPatterns,
  setTelegramAutoTunnel,
  setTelegramPublicBaseUrl,
  setTelegramCloudflaredPath,
  setTelegramVoiceRuntime,
  setTelegramWhisperCppPath,
  setTelegramOpenAiKey,
  probeCloudflared,
  addAllowedChat,
  removeAllowedChat,
  startTelegramBot,
  stopTelegramBot,
  type TelegramStatusResponse,
  type CloudflaredProbeResult,
} from '../store/telegram';
import { theme, sectionLabelStyle } from '../lib/theme';
import type { TelegramPushPolicy, PersistedTelegramConfig } from '../store/types';

const POLL_INTERVAL_MS = 3_000;

const PUSH_POLICY_LABELS: Record<TelegramPushPolicy, string> = {
  all: 'All (questions, idle, errors)',
  'questions-only': 'Questions only',
  'errors-only': 'Errors only',
};

interface TelegramSettingsProps {
  /** True while the parent Settings dialog is open. The component starts /
   *  stops a polling loop in sync with this flag. */
  active: boolean;
}

export function TelegramSettings(props: TelegramSettingsProps) {
  const [status, setStatus] = createSignal<TelegramStatusResponse | null>(null);
  const [tokenInput, setTokenInput] = createSignal('');
  const [showToken, setShowToken] = createSignal(false);
  const [chatInput, setChatInput] = createSignal('');
  const [chatInputErr, setChatInputErr] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);

  const [redactText, setRedactText] = createSignal('');
  const [redactErr, setRedactErr] = createSignal<string | null>(null);
  const [redactDirty, setRedactDirty] = createSignal(false);
  const [extraQText, setExtraQText] = createSignal('');
  const [extraQErr, setExtraQErr] = createSignal<string | null>(null);
  const [extraQDirty, setExtraQDirty] = createSignal(false);

  // Tunnel section
  const [publicUrlInput, setPublicUrlInput] = createSignal('');
  const [cloudflaredPathInput, setCloudflaredPathInput] = createSignal('');
  const [cloudflaredProbe, setCloudflaredProbe] = createSignal<CloudflaredProbeResult | null>(null);

  // Voice section
  const [whisperPathInput, setWhisperPathInput] = createSignal('');
  const [openaiKeyInput, setOpenaiKeyInput] = createSignal('');
  const [showOpenaiKey, setShowOpenaiKey] = createSignal(false);

  const tokenInputId = createUniqueId();
  const chatInputId = createUniqueId();
  const enabledId = createUniqueId();
  const redactId = createUniqueId();
  const extraQId = createUniqueId();
  const autoTunnelId = createUniqueId();
  const publicUrlId = createUniqueId();
  const cloudflaredPathId = createUniqueId();
  const whisperPathId = createUniqueId();
  const openaiKeyId = createUniqueId();

  createEffect(() => {
    if (!props.active) return;
    let cancelled = false;
    void refreshTelegramStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const handle = setInterval(() => {
      void refreshTelegramStatus().then((s) => {
        if (!cancelled) setStatus(s);
      });
    }, POLL_INTERVAL_MS);
    onCleanup(() => {
      cancelled = true;
      clearInterval(handle);
    });
  });

  // Sync textareas with the persisted config when the dialog opens (and the
  // user has not begun editing). Subsequent edits keep their local state until
  // the user saves or cancels.
  createEffect(() => {
    if (!props.active) return;
    if (!redactDirty()) setRedactText(store.telegram.redactPatterns.join('\n'));
    if (!extraQDirty()) setExtraQText(store.telegram.extraQuestionPatterns.join('\n'));
    // Hydrate the tunnel/voice inputs from the persisted config on open.
    setPublicUrlInput(store.telegram.publicBaseUrl ?? '');
    setCloudflaredPathInput(store.telegram.cloudflaredPath ?? '');
    setWhisperPathInput(store.telegram.voice.whisperCppPath ?? '');
  });

  // Probe cloudflared once per dialog open so the auto-tunnel toggle's
  // visibility reflects current PATH state without a continuous poll.
  createEffect(() => {
    if (!props.active) return;
    void probeCloudflared().then((r) => setCloudflaredProbe(r));
  });

  function compilePatterns(
    text: string,
    flags: string,
  ): { patterns: string[]; error: string | null } {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      try {
        new RegExp(lines[i], flags);
      } catch (err) {
        return { patterns: [], error: `Line ${i + 1}: ${(err as Error).message}` };
      }
    }
    return { patterns: lines, error: null };
  }

  async function handleSaveRedactions(): Promise<void> {
    const { patterns, error } = compilePatterns(redactText(), 'g');
    if (error) {
      setRedactErr(error);
      return;
    }
    setRedactErr(null);
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramRedactPatterns(patterns);
      setRedactDirty(false);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveExtraQ(): Promise<void> {
    const { patterns, error } = compilePatterns(extraQText(), 'i');
    if (error) {
      setExtraQErr(error);
      return;
    }
    setExtraQErr(null);
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramExtraQuestionPatterns(patterns);
      setExtraQDirty(false);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetToken(): Promise<void> {
    const trimmed = tokenInput().trim();
    if (!trimmed) return;
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramToken(trimmed);
      setTokenInput('');
      const s = await refreshTelegramStatus();
      setStatus(s);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClearToken(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await applyTelegramConfig({ token: '' });
      const s = await refreshTelegramStatus();
      setStatus(s);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleEnabled(checked: boolean): Promise<void> {
    if (checked && !store.telegramHasToken) {
      setActionError('Set a bot token first.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramEnabled(checked);
      const s = await refreshTelegramStatus();
      setStatus(s);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddChat(): Promise<void> {
    const raw = chatInput().trim();
    if (!raw) return;
    if (!/^-?\d+$/.test(raw)) {
      setChatInputErr('Chat id must be an integer.');
      return;
    }
    const parsed = parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed === 0) {
      setChatInputErr('Chat id must be a non-zero integer.');
      return;
    }
    if (store.telegram.allowedChatIds.includes(parsed)) {
      setChatInputErr('Chat id already added.');
      return;
    }
    setChatInputErr(null);
    setBusy(true);
    setActionError(null);
    try {
      await addAllowedChat(parsed);
      setChatInput('');
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveChat(chatId: number): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await removeAllowedChat(chatId);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleAutoTunnel(checked: boolean): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramAutoTunnel(checked);
      const s = await refreshTelegramStatus();
      setStatus(s);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePublicUrl(): Promise<void> {
    const trimmed = publicUrlInput().trim();
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramPublicBaseUrl(trimmed || null);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCloudflaredPath(): Promise<void> {
    const trimmed = cloudflaredPathInput().trim();
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramCloudflaredPath(trimmed || null);
      // Re-probe with the new path.
      setCloudflaredProbe(await probeCloudflared());
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVoiceRuntimeChange(
    runtime: PersistedTelegramConfig['voice']['runtime'],
  ): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramVoiceRuntime(runtime);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveWhisperPath(): Promise<void> {
    const trimmed = whisperPathInput().trim();
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramWhisperCppPath(trimmed || null);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveOpenAiKey(): Promise<void> {
    const trimmed = openaiKeyInput().trim();
    if (!trimmed) return;
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramOpenAiKey(trimmed);
      setOpenaiKeyInput('');
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClearOpenAiKey(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await setTelegramOpenAiKey('');
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStart(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const s = await startTelegramBot();
      if (s) setStatus(s);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const s = await stopTelegramBot();
      if (s) setStatus(s);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Telegram control</div>

      {/* Master toggle */}
      <label
        for={enabledId}
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          cursor: 'pointer',
          padding: '8px 12px',
          'border-radius': '8px',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
        }}
      >
        <input
          id={enabledId}
          type="checkbox"
          checked={store.telegram.enabled}
          disabled={busy()}
          onChange={(e) => void handleToggleEnabled(e.currentTarget.checked)}
          style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
        />
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
          <span style={{ 'font-size': '14px', color: theme.fg }}>Enable Telegram bot</span>
          <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
            Control agents and receive notifications via Telegram. Output crosses Telegram's servers
            — redaction is best-effort, not a security boundary.
          </span>
        </div>
      </label>

      {/* Bot token */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <label for={tokenInputId} style={{ 'font-size': '13px', color: theme.fg }}>
          Bot token{' '}
          <Show when={store.telegramHasToken}>
            <span style={{ color: theme.accent, 'font-size': '12px' }}>(set ✓)</span>
          </Show>
        </label>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            id={tokenInputId}
            type={showToken() ? 'text' : 'password'}
            value={tokenInput()}
            placeholder={store.telegramHasToken ? '••••• (token saved)' : '123456:ABC...'}
            disabled={busy()}
            onInput={(e) => setTokenInput(e.currentTarget.value)}
            style={{
              flex: '1',
              padding: '6px 8px',
              'border-radius': '6px',
              border: `1px solid ${theme.border}`,
              background: theme.bgInput,
              color: theme.fg,
              'font-family': 'monospace',
              'font-size': '13px',
            }}
          />
          <button
            type="button"
            disabled={busy()}
            onClick={() => setShowToken(!showToken())}
            style={settingsButtonStyle()}
          >
            {showToken() ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            disabled={busy() || !tokenInput().trim()}
            onClick={() => void handleSetToken()}
            style={settingsButtonStyle(true)}
          >
            Save
          </button>
          <Show when={store.telegramHasToken}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void handleClearToken()}
              style={settingsButtonStyle()}
            >
              Clear
            </button>
          </Show>
        </div>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          The token is encrypted via the system keychain and never leaves the desktop. Create one
          with BotFather.
        </span>
      </div>

      {/* Allowed chats */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <label for={chatInputId} style={{ 'font-size': '13px', color: theme.fg }}>
          Allowed chats
        </label>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            id={chatInputId}
            type="text"
            inputmode="numeric"
            value={chatInput()}
            placeholder="Chat id (integer)"
            disabled={busy()}
            onInput={(e) => setChatInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddChat();
              }
            }}
            style={{
              flex: '1',
              padding: '6px 8px',
              'border-radius': '6px',
              border: `1px solid ${chatInputErr() ? theme.error : theme.border}`,
              background: theme.bgInput,
              color: theme.fg,
              'font-family': 'monospace',
              'font-size': '13px',
            }}
          />
          <button
            type="button"
            disabled={busy() || !chatInput().trim()}
            onClick={() => void handleAddChat()}
            style={settingsButtonStyle(true)}
          >
            Add
          </button>
        </div>
        <Show when={chatInputErr()}>
          <span style={{ 'font-size': '12px', color: theme.error }}>{chatInputErr()}</span>
        </Show>
        <Show
          when={store.telegram.allowedChatIds.length > 0}
          fallback={
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              No allowed chats yet. Send /start from your Telegram chat; the bot will reply with the
              chat id, then paste it above.
            </span>
          }
        >
          <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
            <For each={store.telegram.allowedChatIds}>
              {(chatId) => (
                <span
                  style={{
                    display: 'inline-flex',
                    'align-items': 'center',
                    gap: '6px',
                    padding: '3px 8px',
                    'border-radius': '999px',
                    background: theme.bgElevated,
                    border: `1px solid ${theme.border}`,
                    'font-size': '12px',
                    color: theme.fg,
                    'font-family': 'monospace',
                  }}
                >
                  {chatId}
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() => void handleRemoveChat(chatId)}
                    aria-label={`Remove chat ${chatId}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: theme.fgSubtle,
                      cursor: 'pointer',
                      padding: '0',
                      'font-size': '14px',
                      'line-height': '1',
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Push policy */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <span style={{ 'font-size': '13px', color: theme.fg }}>Push policy</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <For each={Object.entries(PUSH_POLICY_LABELS) as [TelegramPushPolicy, string][]}>
            {([value, label]) => (
              <label
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  padding: '6px 10px',
                  'border-radius': '6px',
                  border: `1px solid ${theme.border}`,
                  background:
                    store.telegram.pushPolicy === value ? theme.bgElevated : theme.bgInput,
                  cursor: 'pointer',
                  'font-size': '12px',
                  color: theme.fg,
                }}
              >
                <input
                  type="radio"
                  name="telegram-push-policy"
                  value={value}
                  checked={store.telegram.pushPolicy === value}
                  disabled={busy()}
                  onChange={() => void setTelegramPushPolicy(value)}
                  style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
                />
                {label}
              </label>
            )}
          </For>
        </div>
      </div>

      {/* Redaction patterns */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <label for={redactId} style={{ 'font-size': '13px', color: theme.fg }}>
          Redaction patterns
        </label>
        <textarea
          id={redactId}
          value={redactText()}
          rows={4}
          disabled={busy()}
          onInput={(e) => {
            setRedactText(e.currentTarget.value);
            setRedactDirty(true);
            setRedactErr(null);
          }}
          placeholder="One JavaScript regex per line, e.g. ^password:\s*\S+$"
          style={{
            padding: '6px 8px',
            'border-radius': '6px',
            border: `1px solid ${redactErr() ? theme.error : theme.border}`,
            background: theme.bgInput,
            color: theme.fg,
            'font-family': 'monospace',
            'font-size': '12px',
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <button
            type="button"
            disabled={busy() || !redactDirty()}
            onClick={() => void handleSaveRedactions()}
            style={settingsButtonStyle(true)}
          >
            Save patterns
          </button>
          <Show when={redactErr()}>
            <span style={{ 'font-size': '12px', color: theme.error }}>{redactErr()}</span>
          </Show>
        </div>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          Best-effort redaction of agent output before it reaches Telegram. Each match is replaced
          with <code>[REDACTED:user-N]</code>. Not a security boundary.
        </span>
      </div>

      {/* Extra question patterns */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <label for={extraQId} style={{ 'font-size': '13px', color: theme.fg }}>
          Extra question patterns
        </label>
        <textarea
          id={extraQId}
          value={extraQText()}
          rows={3}
          disabled={busy()}
          onInput={(e) => {
            setExtraQText(e.currentTarget.value);
            setExtraQDirty(true);
            setExtraQErr(null);
          }}
          placeholder="One case-insensitive regex per line, e.g. ^awaiting input:\s*$"
          style={{
            padding: '6px 8px',
            'border-radius': '6px',
            border: `1px solid ${extraQErr() ? theme.error : theme.border}`,
            background: theme.bgInput,
            color: theme.fg,
            'font-family': 'monospace',
            'font-size': '12px',
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <button
            type="button"
            disabled={busy() || !extraQDirty()}
            onClick={() => void handleSaveExtraQ()}
            style={settingsButtonStyle(true)}
          >
            Save patterns
          </button>
          <Show when={extraQErr()}>
            <span style={{ 'font-size': '12px', color: theme.error }}>{extraQErr()}</span>
          </Show>
        </div>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          Patterns added here are checked alongside the built-in question detectors. False positives
          wake you up — keep matches narrow.
        </span>
      </div>

      {/* Public URL + cloudflared auto-tunnel */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <span style={{ 'font-size': '13px', color: theme.fg, 'font-weight': '500' }}>
          Mini App public URL
        </span>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          Required for the “Open” button in Telegram notifications to launch the SPA inside
          Telegram. Provide one via Tailscale Funnel, ngrok, or your own reverse proxy — or enable
          the cloudflared auto-tunnel below.
        </span>
        <label for={publicUrlId} style={{ 'font-size': '13px', color: theme.fg }}>
          Public base URL
        </label>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            id={publicUrlId}
            type="url"
            value={publicUrlInput()}
            placeholder="https://abc.example.com"
            disabled={busy()}
            onInput={(e) => setPublicUrlInput(e.currentTarget.value)}
            style={{
              flex: '1',
              padding: '6px 8px',
              'border-radius': '6px',
              border: `1px solid ${theme.border}`,
              background: theme.bgInput,
              color: theme.fg,
              'font-family': 'monospace',
              'font-size': '13px',
            }}
          />
          <button
            type="button"
            disabled={busy()}
            onClick={() => void handleSavePublicUrl()}
            style={settingsButtonStyle(true)}
          >
            Save
          </button>
        </div>

        <Show
          when={cloudflaredProbe()?.available === true}
          fallback={
            <Show when={cloudflaredProbe() !== null}>
              <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                cloudflared not detected on PATH. Install it
                (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
                or point to a binary below to enable the auto-tunnel.
              </span>
            </Show>
          }
        >
          <label
            for={autoTunnelId}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
              cursor: 'pointer',
              padding: '8px 12px',
              'border-radius': '8px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'margin-top': '6px',
            }}
          >
            <input
              id={autoTunnelId}
              type="checkbox"
              checked={store.telegram.autoTunnel}
              disabled={busy()}
              onChange={(e) => void handleToggleAutoTunnel(e.currentTarget.checked)}
              style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
            />
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              <span style={{ 'font-size': '14px', color: theme.fg }}>cloudflared auto-tunnel</span>
              <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                Spawn cloudflared and publish the remote server over a free trycloudflare.com URL
                whenever the bot starts.
                <Show when={cloudflaredProbe()?.version}>
                  {' '}
                  <span style={{ 'font-family': 'monospace' }}>
                    ({cloudflaredProbe()?.version})
                  </span>
                </Show>
              </span>
            </div>
          </label>
          <Show when={status()?.tunnelUrl}>
            <span
              style={{
                'font-size': '12px',
                color: theme.accent,
                'font-family': 'monospace',
                'word-break': 'break-all',
              }}
            >
              Tunnel: {status()?.tunnelUrl}
            </span>
          </Show>
        </Show>

        <label for={cloudflaredPathId} style={{ 'font-size': '13px', color: theme.fg }}>
          cloudflared path (optional)
        </label>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            id={cloudflaredPathId}
            type="text"
            value={cloudflaredPathInput()}
            placeholder="auto-detect from PATH"
            disabled={busy()}
            onInput={(e) => setCloudflaredPathInput(e.currentTarget.value)}
            style={{
              flex: '1',
              padding: '6px 8px',
              'border-radius': '6px',
              border: `1px solid ${theme.border}`,
              background: theme.bgInput,
              color: theme.fg,
              'font-family': 'monospace',
              'font-size': '13px',
            }}
          />
          <button
            type="button"
            disabled={busy()}
            onClick={() => void handleSaveCloudflaredPath()}
            style={settingsButtonStyle()}
          >
            Save
          </button>
        </div>
      </div>

      {/* Voice prompts */}
      <Show
        when={
          store.telegram.enabled &&
          store.telegramHasToken &&
          store.telegram.allowedChatIds.length > 0
        }
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <span style={{ 'font-size': '13px', color: theme.fg, 'font-weight': '500' }}>
            Voice prompts
          </span>
          <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
            Transcribe Telegram voice messages and inject the text into the focused agent.
            Reply-chain replies override focus.
          </span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <For
              each={[
                { value: 'none' as const, label: 'Off' },
                { value: 'whisper-cpp' as const, label: 'whisper.cpp (local)' },
                { value: 'openai' as const, label: 'OpenAI Whisper API' },
              ]}
            >
              {(opt) => (
                <label
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '6px',
                    padding: '6px 10px',
                    'border-radius': '6px',
                    border: `1px solid ${theme.border}`,
                    background:
                      store.telegram.voice.runtime === opt.value ? theme.bgElevated : theme.bgInput,
                    cursor: 'pointer',
                    'font-size': '12px',
                    color: theme.fg,
                  }}
                >
                  <input
                    type="radio"
                    name="telegram-voice-runtime"
                    value={opt.value}
                    checked={store.telegram.voice.runtime === opt.value}
                    disabled={busy()}
                    onChange={() => void handleVoiceRuntimeChange(opt.value)}
                    style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
                  />
                  {opt.label}
                </label>
              )}
            </For>
          </div>

          <Show when={store.telegram.voice.runtime === 'whisper-cpp'}>
            <label for={whisperPathId} style={{ 'font-size': '13px', color: theme.fg }}>
              whisper.cpp binary path
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                id={whisperPathId}
                type="text"
                value={whisperPathInput()}
                placeholder="/usr/local/bin/whisper"
                disabled={busy()}
                onInput={(e) => setWhisperPathInput(e.currentTarget.value)}
                style={{
                  flex: '1',
                  padding: '6px 8px',
                  'border-radius': '6px',
                  border: `1px solid ${theme.border}`,
                  background: theme.bgInput,
                  color: theme.fg,
                  'font-family': 'monospace',
                  'font-size': '13px',
                }}
              />
              <button
                type="button"
                disabled={busy()}
                onClick={() => void handleSaveWhisperPath()}
                style={settingsButtonStyle(true)}
              >
                Save
              </button>
            </div>
          </Show>

          <Show when={store.telegram.voice.runtime === 'openai'}>
            <label for={openaiKeyId} style={{ 'font-size': '13px', color: theme.fg }}>
              OpenAI API key
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                id={openaiKeyId}
                type={showOpenaiKey() ? 'text' : 'password'}
                value={openaiKeyInput()}
                placeholder="sk-..."
                disabled={busy()}
                onInput={(e) => setOpenaiKeyInput(e.currentTarget.value)}
                style={{
                  flex: '1',
                  padding: '6px 8px',
                  'border-radius': '6px',
                  border: `1px solid ${theme.border}`,
                  background: theme.bgInput,
                  color: theme.fg,
                  'font-family': 'monospace',
                  'font-size': '13px',
                }}
              />
              <button
                type="button"
                disabled={busy()}
                onClick={() => setShowOpenaiKey(!showOpenaiKey())}
                style={settingsButtonStyle()}
              >
                {showOpenaiKey() ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                disabled={busy() || !openaiKeyInput().trim()}
                onClick={() => void handleSaveOpenAiKey()}
                style={settingsButtonStyle(true)}
              >
                Save
              </button>
              <button
                type="button"
                disabled={busy()}
                onClick={() => void handleClearOpenAiKey()}
                style={settingsButtonStyle()}
              >
                Clear
              </button>
            </div>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Stored encrypted via the system keychain. Never round-trips through the renderer's
              state.json. The field clears on save, so re-entering replaces the stored key.
            </span>
          </Show>
        </div>
      </Show>

      {/* Status + manual start/stop */}
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          padding: '8px 12px',
          'border-radius': '8px',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <span
            aria-hidden="true"
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: status()?.running ? theme.accent : theme.fgSubtle,
            }}
          />
          <span style={{ 'font-size': '13px', color: theme.fg }}>
            {status()?.running ? 'Running' : 'Stopped'}
            <Show when={status()?.botUsername}>
              <span style={{ color: theme.fgSubtle, 'margin-left': '6px' }}>
                @{status()?.botUsername}
              </span>
            </Show>
          </span>
          <div style={{ 'margin-left': 'auto', display: 'flex', gap: '6px' }}>
            <button
              type="button"
              disabled={busy() || status()?.running === true || !store.telegramHasToken}
              onClick={() => void handleStart()}
              style={settingsButtonStyle(true)}
            >
              Start
            </button>
            <button
              type="button"
              disabled={busy() || status()?.running !== true}
              onClick={() => void handleStop()}
              style={settingsButtonStyle()}
            >
              Stop
            </button>
          </div>
        </div>
        <Show when={status()?.lastError}>
          <span style={{ 'font-size': '12px', color: theme.error }}>{status()?.lastError}</span>
        </Show>
        <Show when={actionError()}>
          <span style={{ 'font-size': '12px', color: theme.error }}>{actionError()}</span>
        </Show>
      </div>
    </div>
  );
}

function settingsButtonStyle(primary = false): Record<string, string> {
  return {
    padding: '6px 12px',
    'border-radius': '6px',
    border: `1px solid ${theme.border}`,
    background: primary ? theme.accent : theme.bgInput,
    color: primary ? theme.accentText : theme.fg,
    cursor: 'pointer',
    'font-size': '12px',
    'font-weight': primary ? '600' : '400',
  };
}
