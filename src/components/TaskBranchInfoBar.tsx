import { Show, type JSX } from 'solid-js';
import {
  store,
  getProject,
  showNotification,
  getPrChecks,
  getConflictPreflight,
} from '../store/store';
import { revealItemInDir, openInEditor } from '../lib/shell';
import { InfoBar } from './InfoBar';
import { theme } from '../lib/theme';
import { isMac } from '../lib/platform';
import type { Task } from '../store/types';

const infoBarBtnStyle: JSX.CSSProperties = {
  display: 'inline-flex',
  'align-items': 'center',
  gap: '4px',
  'align-self': 'stretch',
  background: 'transparent',
  border: 'none',
  padding: '0 4px',
  color: 'inherit',
  cursor: 'pointer',
  'font-family': 'inherit',
  'font-size': 'inherit',
};

interface TaskBranchInfoBarProps {
  task: Task;
  onEditProject: (projectId: string) => void;
  onOpenMerge?: () => void;
}

export function TaskBranchInfoBar(props: TaskBranchInfoBarProps) {
  const mod = isMac ? 'Cmd' : 'Ctrl';
  const editorTitle = () =>
    store.editorCommand
      ? `Click to open in ${store.editorCommand} · ${mod}+Click to reveal in file manager · ${mod}+Shift+Click to open the project root in ${store.editorCommand}`
      : `Click to reveal in file manager · ${mod}+Shift+Click to reveal the project root`;

  const handleOpenInEditor = (e: MouseEvent) => {
    const modKey = e.ctrlKey || e.metaKey;
    if (modKey && e.shiftKey) {
      const projectPath = getProject(props.task.projectId)?.path;
      if (!projectPath) return;
      const action = store.editorCommand
        ? openInEditor(store.editorCommand, projectPath)
        : revealItemInDir(projectPath);
      action.catch((err) =>
        showNotification(
          `Could not open project folder: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (store.editorCommand && !modKey) {
      openInEditor(store.editorCommand, props.task.worktreePath).catch((err) =>
        showNotification(`Editor failed: ${err instanceof Error ? err.message : 'unknown error'}`),
      );
    } else {
      revealItemInDir(props.task.worktreePath).catch((err) =>
        showNotification(
          `Could not open folder: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  };

  return (
    <InfoBar class="task-branch-info-bar">
      {(() => {
        const project = getProject(props.task.projectId);
        return (
          <Show when={project}>
            {(p) => (
              <button
                type="button"
                onClick={() => props.onEditProject(p().id)}
                title="Project settings"
                style={{ ...infoBarBtnStyle, margin: '0 8px 0 0' }}
              >
                <div
                  style={{
                    width: '7px',
                    height: '7px',
                    'border-radius': '50%',
                    background: p().color,
                    'flex-shrink': '0',
                  }}
                />
                {p().name}
              </button>
            )}
          </Show>
        );
      })()}
      <Show when={props.task.githubUrl}>
        {(url) => {
          const pr = () => getPrChecks(props.task.id);
          const dotColor = (): string | null => {
            const c = pr();
            if (!c || c.overall === 'none') return null;
            if (c.overall === 'pending') return theme.warning;
            if (c.overall === 'success') return theme.success;
            return theme.error;
          };
          const buttonTitle = (): string => {
            const c = pr();
            if (!c || c.overall === 'none') return url();
            return `${c.passing} passing, ${c.pending} pending, ${c.failing} failing`;
          };
          return (
            <button
              type="button"
              onClick={() => window.open(url(), '_blank')}
              title={buttonTitle()}
              style={{ ...infoBarBtnStyle, 'margin-right': '8px', color: theme.accent }}
            >
              <Show when={dotColor()}>
                {(color) => (
                  <div
                    style={{
                      width: '7px',
                      height: '7px',
                      'border-radius': '50%',
                      background: color(),
                      'flex-shrink': '0',
                      animation:
                        pr()?.overall === 'pending'
                          ? 'askcode-pulse 1.4s ease-in-out infinite'
                          : undefined,
                    }}
                  />
                )}
              </Show>
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                style={{ 'flex-shrink': '0' }}
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              {url().replace(/^https?:\/\/(www\.)?github\.com\//, '')}
            </button>
          );
        }}
      </Show>
      <Show when={props.task.gitIsolation !== 'none'}>
        <button
          type="button"
          title={editorTitle()}
          onClick={handleOpenInEditor}
          style={{ ...infoBarBtnStyle, 'margin-right': '12px' }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{ 'flex-shrink': '0' }}
          >
            <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
          </svg>
          <Show when={props.task.gitIsolation !== 'direct'}>{props.task.branchName}</Show>
          <Show when={props.task.gitIsolation === 'direct'}>
            <span
              style={{
                'font-size': '11px',
                'font-weight': '600',
                padding: '1px 6px',
                'border-radius': '4px',
                background: `color-mix(in srgb, ${theme.warning} 15%, transparent)`,
                color: theme.warning,
                border: `1px solid color-mix(in srgb, ${theme.warning} 25%, transparent)`,
              }}
            >
              {props.task.branchName}
            </span>
          </Show>
        </button>
        {(() => {
          const cp = () => getConflictPreflight(props.task.id);
          const visible = () => {
            const c = cp();
            return c !== undefined && c.status !== 'unknown';
          };
          const badgeColor = (): string => {
            const c = cp();
            if (!c) return 'transparent';
            if (c.status === 'clean') return theme.success;
            if (c.status === 'stale') return theme.warning;
            if (c.status === 'conflict') return theme.error;
            return 'transparent';
          };
          // One-line accessible label: status · base · N ahead · K conflicting.
          const badgeTitle = (): string => {
            const c = cp();
            if (!c) return '';
            const conflicts = c.conflictingFiles.length;
            return `${c.status} · ${c.baseBranch} · ${c.mainAheadCount} ahead · ${conflicts} conflicting`;
          };
          return (
            <Show when={visible()}>
              <button
                type="button"
                title={badgeTitle()}
                aria-label={badgeTitle()}
                onClick={() => props.onOpenMerge?.()}
                disabled={!props.onOpenMerge}
                style={{
                  ...infoBarBtnStyle,
                  'margin-right': '12px',
                  cursor: props.onOpenMerge ? 'pointer' : 'default',
                }}
              >
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    'border-radius': '50%',
                    background: badgeColor(),
                    'flex-shrink': '0',
                  }}
                />
                <Show when={cp()?.status === 'conflict'}>
                  <span
                    style={{
                      'font-size': '11px',
                      'font-weight': '600',
                      color: theme.error,
                    }}
                  >
                    {cp()?.conflictingFiles.length}
                  </span>
                </Show>
              </button>
            </Show>
          );
        })()}
      </Show>
      <button
        type="button"
        title={editorTitle()}
        onClick={handleOpenInEditor}
        style={{ ...infoBarBtnStyle, opacity: 0.6 }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="currentColor"
          style={{ 'flex-shrink': '0' }}
        >
          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
        </svg>
        {props.task.worktreePath}
      </button>
      <Show when={props.task.externalWorktree}>
        <span
          style={{
            display: 'inline-flex',
            'align-items': 'center',
            gap: '4px',
            color: theme.accent,
          }}
        >
          Existing worktree
        </span>
      </Show>
    </InfoBar>
  );
}
