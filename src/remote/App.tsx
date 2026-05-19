import { createSignal, onMount, Show, Switch, Match } from 'solid-js';
import { initAuth } from './auth';
import { connect, agents } from './ws';
import { AgentList } from './AgentList';
import { AgentDetail } from './AgentDetail';
import { NewTask } from './NewTask';

export function App() {
  const [authed, setAuthed] = createSignal(false);
  // Separate view state from detail data so the agentId/taskName signals
  // never become empty while AgentDetail is still mounted (avoids reactive
  // race where Show disposes children *after* props re-evaluate to null).
  const [view, setView] = createSignal<'list' | 'detail' | 'new'>('list');
  const [detailAgentId, setDetailAgentId] = createSignal('');
  const [detailTaskName, setDetailTaskName] = createSignal('');
  const [notice, setNotice] = createSignal('');

  function selectAgent(id: string, name: string) {
    setDetailAgentId(id);
    setDetailTaskName(name);
    setView('detail');
  }

  function openNewTask() {
    setNotice('');
    setView('new');
  }

  function handleSpawnSuccess(newAgentId: string) {
    // Find taskName from the freshly-pushed agents list if it's already
    // arrived; fall back to a placeholder otherwise (AgentDetail re-reads
    // the name once the next agents push lands).
    const match = agents().find((a) => a.agentId === newAgentId);
    setDetailAgentId(newAgentId);
    setDetailTaskName(match?.taskName ?? '');
    setView('detail');
  }

  function handleTaskCreatedNoAgent() {
    setNotice('Task created on desktop but the agent did not start. Retry from desktop.');
    setView('list');
  }

  onMount(() => {
    const token = initAuth();
    if (token) {
      setAuthed(true);
      connect();
    }
  });

  return (
    <Show
      when={authed()}
      fallback={
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            height: '100%',
            color: '#999',
            'font-size': '17px',
            padding: '20px',
            'text-align': 'center',
          }}
        >
          <div>
            <p style={{ 'margin-bottom': '12px' }}>Not authenticated.</p>
            <p style={{ 'font-size': '14px', color: '#666' }}>
              Scan the QR code from the Parallel Code desktop app to connect.
            </p>
          </div>
        </div>
      }
    >
      <Switch
        fallback={
          <AgentList
            onSelect={selectAgent}
            onNewTask={openNewTask}
            notice={notice() || undefined}
            onDismissNotice={() => setNotice('')}
          />
        }
      >
        <Match when={view() === 'detail'}>
          <AgentDetail
            agentId={detailAgentId()}
            taskName={detailTaskName()}
            onBack={() => setView('list')}
          />
        </Match>
        <Match when={view() === 'new'}>
          <NewTask
            onSuccess={handleSpawnSuccess}
            onTaskCreatedNoAgent={handleTaskCreatedNoAgent}
            onCancel={() => setView('list')}
          />
        </Match>
      </Switch>
    </Show>
  );
}
