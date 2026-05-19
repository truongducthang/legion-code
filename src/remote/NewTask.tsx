import { createSignal, createEffect, For, Show, onCleanup, type JSX } from 'solid-js';
import { listProjects, listBranches, spawnTask } from './ws';
import type {
  RemoteProject,
  RemoteBranch,
  SpawnResultMessage,
} from '../../electron/remote/protocol';

interface NewTaskProps {
  onSuccess: (agentId: string) => void;
  /** Called when the spawn returned ok:true but no agent id. */
  onTaskCreatedNoAgent: () => void;
  onCancel: () => void;
}

const AGENT_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'copilot', label: 'Copilot CLI' },
];

/** Best-effort id factory; we don't need crypto-strong here since the server
 *  only treats requestId as an opaque correlator. */
function makeRequestId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function NewTask(props: NewTaskProps) {
  const [projects, setProjects] = createSignal<RemoteProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = createSignal(false);
  const [selectedProject, setSelectedProject] = createSignal<string>('');
  const [branches, setBranches] = createSignal<RemoteBranch[]>([]);
  const [baseBranch, setBaseBranch] = createSignal<string>('');
  const [agentId, setAgentId] = createSignal<string>('claude-code');
  const [taskName, setTaskName] = createSignal('');
  const [prompt, setPrompt] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');

  // Load projects on mount. The initial value of selectedProject is '' so
  // pre-selecting unconditionally is safe.
  void (async () => {
    const list = await listProjects();
    setProjects(list);
    setProjectsLoaded(true);
    if (list.length > 0) {
      setSelectedProject((cur) => cur || list[0].root);
    }
  })();

  // Whenever the selected project changes, re-fetch branches.
  createEffect(() => {
    const root = selectedProject();
    if (!root) {
      setBranches([]);
      setBaseBranch('');
      return;
    }
    let cancelled = false;
    void (async () => {
      const list = await listBranches(root);
      if (cancelled) return;
      setBranches(list);
      // Default to the current branch if present, else "" (= desktop default).
      const current = list.find((b) => b.current);
      setBaseBranch(current?.name ?? '');
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  const submitDisabled = () =>
    submitting() || !selectedProject() || !taskName().trim() || !prompt().trim() || !agentId();

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (submitDisabled()) return;
    setSubmitting(true);
    setErrorMessage('');
    const requestId = makeRequestId();
    const reply: SpawnResultMessage = await spawnTask({
      requestId,
      projectRoot: selectedProject(),
      baseBranch: baseBranch() ? baseBranch() : null,
      agentId: agentId(),
      taskName: taskName().trim(),
      prompt: prompt(),
    });
    setSubmitting(false);
    if (reply.ok) {
      if (reply.agentId) {
        props.onSuccess(reply.agentId);
      } else {
        props.onTaskCreatedNoAgent();
      }
      return;
    }
    setErrorMessage(formatError(reply.error, reply.message));
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#0b0f14',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '14px 16px 12px',
          'border-bottom': '1px solid #223040',
          background: '#12181f',
        }}
      >
        <button
          type="button"
          onClick={() => props.onCancel()}
          style={buttonChromeStyle}
          aria-label="Cancel"
        >
          Cancel
        </button>
        <span style={{ 'font-size': '17px', 'font-weight': '600', color: '#d7e4f0' }}>
          New task
        </span>
        <span style={{ width: '52px' }} />
      </div>

      <form
        onSubmit={handleSubmit}
        style={{
          flex: '1',
          overflow: 'auto',
          padding: '16px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '20px',
          '-webkit-overflow-scrolling': 'touch',
          'padding-bottom': 'max(20px, env(safe-area-inset-bottom))',
        }}
      >
        <Show
          when={!projectsLoaded() || projects().length > 0}
          fallback={<div style={emptyStateStyle}>Open a project on the desktop first.</div>}
        >
          <Field label="Project">
            <select
              value={selectedProject()}
              onChange={(e) => setSelectedProject(e.currentTarget.value)}
              disabled={!projectsLoaded() || submitting()}
              style={selectStyle}
            >
              <Show when={!projectsLoaded()}>
                <option value="">Loading…</option>
              </Show>
              <For each={projects()}>{(p) => <option value={p.root}>{p.name}</option>}</For>
            </select>
          </Field>

          <Field label="Base branch">
            <select
              value={baseBranch()}
              onChange={(e) => setBaseBranch(e.currentTarget.value)}
              disabled={submitting()}
              style={selectStyle}
            >
              <option value="">Use desktop default</option>
              <For each={branches()}>
                {(b) => (
                  <option value={b.name}>
                    {b.name}
                    {b.current ? ' (current)' : ''}
                  </option>
                )}
              </For>
            </select>
          </Field>

          <Field label="Agent">
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
              }}
            >
              <For each={AGENT_PRESETS}>
                {(p) => (
                  <label
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '12px',
                      padding: '12px 14px',
                      background: agentId() === p.id ? '#1a2735' : '#0f141b',
                      border: `1px solid ${agentId() === p.id ? '#2ec8ff' : '#223040'}`,
                      'border-radius': '12px',
                      color: '#d7e4f0',
                      'font-size': '15px',
                      cursor: 'pointer',
                      'touch-action': 'manipulation',
                    }}
                  >
                    <input
                      type="radio"
                      name="agent-preset"
                      value={p.id}
                      checked={agentId() === p.id}
                      onChange={() => setAgentId(p.id)}
                      disabled={submitting()}
                      style={{ width: '20px', height: '20px' }}
                    />
                    <span>{p.label}</span>
                  </label>
                )}
              </For>
            </div>
          </Field>

          <Field label="Task name">
            <input
              type="text"
              value={taskName()}
              onInput={(e) => setTaskName(e.currentTarget.value)}
              placeholder="What is this task?"
              maxLength={200}
              disabled={submitting()}
              style={inputStyle}
            />
          </Field>

          <Field label="Prompt">
            <textarea
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              rows={6}
              maxLength={16384}
              placeholder="What should the agent do?"
              disabled={submitting()}
              style={{ ...inputStyle, resize: 'vertical', 'font-family': 'inherit' }}
            />
          </Field>

          <Show when={errorMessage()}>
            <div
              style={{
                padding: '10px 12px',
                background: '#7f1d1d',
                color: '#fca5a5',
                'border-radius': '10px',
                'font-size': '14px',
              }}
            >
              {errorMessage()}
            </div>
          </Show>

          <button
            type="submit"
            disabled={submitDisabled()}
            style={{
              padding: '14px',
              background: submitDisabled() ? '#1f2937' : '#2ec8ff',
              color: submitDisabled() ? '#678197' : '#06121d',
              border: 'none',
              'border-radius': '12px',
              'font-size': '16px',
              'font-weight': '600',
              cursor: submitDisabled() ? 'default' : 'pointer',
              'touch-action': 'manipulation',
            }}
          >
            {submitting() ? 'Spawning…' : 'Spawn task'}
          </button>
        </Show>
      </form>
    </div>
  );
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
      }}
    >
      <span
        style={{
          'font-size': '13px',
          'text-transform': 'uppercase',
          'letter-spacing': '0.06em',
          color: '#678197',
        }}
      >
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

const selectStyle = {
  background: '#0f141b',
  border: '1px solid #223040',
  'border-radius': '12px',
  padding: '12px 14px',
  color: '#d7e4f0',
  'font-size': '16px',
  width: '100%',
  // Native select honours these; reset chrome to avoid iOS shrinkage.
  appearance: 'none' as const,
  'min-height': '48px',
};

const inputStyle = {
  background: '#0f141b',
  border: '1px solid #223040',
  'border-radius': '12px',
  padding: '12px 14px',
  color: '#d7e4f0',
  'font-size': '16px',
  width: '100%',
  'box-sizing': 'border-box' as const,
  'min-height': '48px',
};

const buttonChromeStyle = {
  background: 'transparent',
  border: 'none',
  color: '#2ec8ff',
  'font-size': '16px',
  cursor: 'pointer',
  padding: '4px 8px',
  'touch-action': 'manipulation',
};

const emptyStateStyle = {
  'text-align': 'center' as const,
  color: '#9bb0c3',
  padding: '40px 16px',
  'font-size': '15px',
};

function formatError(code: string, message: string): string {
  switch (code) {
    case 'invalid_project':
      return 'That project is no longer open on the desktop.';
    case 'invalid_branch':
      return 'That branch is no longer available.';
    case 'invalid_agent':
      return 'That agent preset is not configured on the desktop.';
    case 'invalid_name':
      return 'Task name is empty.';
    case 'invalid_prompt':
      return 'Prompt is empty.';
    case 'create_failed':
      return `Could not create the worktree: ${message}`;
    case 'spawn_failed':
      if (message === 'busy') return 'Another task is being created — try again in a moment.';
      if (message === 'rate_limited') return 'Slow down — one spawn every 2 seconds.';
      if (message === 'timed_out') return 'The desktop did not respond. Try again.';
      return `Spawn failed: ${message}`;
    default:
      return message || 'Unknown error';
  }
}
