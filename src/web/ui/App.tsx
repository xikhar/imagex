import { Fragment, useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { Box, Component, FileText, Frame, Image, Layers3, MapPin, Palette, X } from 'lucide-react';
import LogoWhite from '../logo/logo-white.svg?react';
import { PrimaryActionButton } from '@/components/ui/primary-action-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { setPreviewResolution } from './flow/imaging/index.js';
import type {
  ImageXAsset,
  ImageXOutputAsset,
  ImageXProject,
  ImageXProjectSummary,
  ImageXTemplateSummary,
  ImageXWorkflow,
  NodeType,
  OutputNodeResult,
} from '../../shared/types.js';
import './App.css';
import { BottomNotification } from './notifications/index.js';
import { JsonCodeBlock } from './components/JsonCodeBlock/index.js';
import { AssetsPanel } from './editor/AssetsPanel/index.js';
import { FlowEditor } from './editor/FlowEditor/index.js';
import { InspectorPanel, InspectorToggle } from './editor/InspectorPanel/index.js';
import { NodesPanel } from './editor/NodesPanel/index.js';
import { LogoMenuButton, Sidebar } from './editor/Sidebar/index.js';
import { SidePanel } from './editor/SidePanel/index.js';
import { TopBarTabs, TopBarRunControl } from './editor/TopBar/index.js';
import { WorkflowsPanel } from './editor/WorkflowsPanel/index.js';
import { useEditorActions } from './editor/useEditorActions.js';
import { useProjectActions } from './editor/useProjectActions.js';
import type { AuthStatus, ConfirmDialogState, FloatingMenu, TextDialogState } from './editor/types.js';
import { projectIdFromPath, pushProjectRoute } from './utils/routing.js';
import { editorShortcuts } from './shortcuts/registry.js';
import { useShortcuts } from './shortcuts/useShortcuts.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';

// ─── App ─────────────────────────────────────────────────────────────────────

export function App() {
  // ─── Top-level state ─────────────────────────────────────────────────────────

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [project, setProject] = useState<ImageXProject | null>(null);
  const [workflow, setWorkflow] = useState<ImageXWorkflow | null>(null);
  const [status, setStatus] = useState('Loading workspace...');
  const [outputResults, setOutputResults] = useState<Map<string, OutputNodeResult>>(new Map());
  const [notification, setNotification] = useState<string | null>(null);
  const [menu, setMenu] = useState<FloatingMenu>(null);
  const [promptOverlay, setPromptOverlay] = useState<{ prompt: string } | null>(null);
  const [assetPicker, setAssetPicker] = useState<{ nodeId: string; fieldId: string } | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showMinimap, setShowMinimap] = useState(() => localStorage.getItem('imagex.minimap') !== 'false');
  const [textDialog, setTextDialog] = useState<TextDialogState>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [fontScale, setFontScale] = useState(() => Number(localStorage.getItem('imagex.fontScale')) || 1);
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('imagex.rightWidth')) || 340);
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('imagex.rightOpen') !== 'false');
  const [activeSidePanel, setActiveSidePanel] = useState<string | null>(null);
  const [sidePanelWidth, setSidePanelWidth] = useState(() => Number(localStorage.getItem('imagex.sidePanelWidth')) || 260);
  const [workflowSearchQuery, setWorkflowSearchQuery] = useState('');

  const notificationTimer = useRef<number | null>(null);
  const bootstrapped = useRef(false);

  // ─── Notification helper ───────────────────────────────────────────────────

  function showNotification(message: string) {
    setNotification(message);
    if (notificationTimer.current) window.clearTimeout(notificationTimer.current);
    notificationTimer.current = window.setTimeout(() => setNotification(null), 3800);
  }

  // ─── Hooks ─────────────────────────────────────────────────────────────────

  const editor = useEditorActions({
    workflow,
    setWorkflow,
    project,
    setStatus,
    showNotification,
    setOutputResults,
    setAssetPicker,
    setActiveSidePanel,
    setPromptOverlay,
    onNodeMenu: (nodeId, position) => setMenu({ type: 'node', nodeId, x: position.x, y: position.y }),
  });

  const projectActions = useProjectActions({
    project,
    setProject,
    workflow,
    setStatus,
    showNotification,
    loadWorkflow: editor.restoreWorkflowSnapshot,
    applyWorkflow: editor.applyWorkflow,
    patchOutputNodes: editor.patchOutputNodes,
    clearHistory: editor.clearHistory,
    recordHistory: editor.recordHistory,
    syncLatestWorkflow: editor.commitFlowToWorkflow,
    nodesRef: editor.nodesRef,
    edgesRef: editor.edgesRef,
    setTextDialog,
    setConfirmDialog,
    setShowNewProject,
    setActiveSidePanel,
    setOutputResults,
  });

  useEffect(() => {
    if (activeSidePanel === 'assets') void projectActions.refreshOutputAssets();
  }, [activeSidePanel, project?.metadata.id]);

  useEffect(() => {
    if (assetPicker) void projectActions.refreshOutputAssets();
  }, [assetPicker, project?.metadata.id]);

  // ─── Shortcuts ─────────────────────────────────────────────────────────────

  function openAddNodeContextMenu() {
    if (!project || !workflow || !editor.flowApiRef.current) return;
    setActiveSidePanel(null);

    const lastMouse = editor.lastMousePosRef.current;
    const workspace = document.querySelector('.workspace')?.getBoundingClientRect();
    const mouseIsInWorkspace = workspace
      ? lastMouse.x >= workspace.left && lastMouse.x <= workspace.right && lastMouse.y >= workspace.top && lastMouse.y <= workspace.bottom
      : Boolean(lastMouse.x || lastMouse.y);
    const position =
      mouseIsInWorkspace
        ? lastMouse
        : {
            x: workspace ? workspace.left + workspace.width / 2 : window.innerWidth / 2,
            y: workspace ? workspace.top + workspace.height / 2 : window.innerHeight / 2,
          };
    const flowPosition = editor.flowApiRef.current.screenToFlowPosition(position);
    setMenu({ type: 'pane', x: position.x, y: position.y, flowX: flowPosition.x, flowY: flowPosition.y });
  }

  useShortcuts(editorShortcuts, {
    'toggle-add-node': openAddNodeContextMenu,
    'delete-selection': editor.deleteSelection,
    'clear-selection': editor.clearSelection,
    'detach-frame': editor.detachSelectionFromFrames,
    'duplicate-field': editor.duplicateActiveCustomField,
    undo: editor.undo,
    redo: editor.redo,
  });

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    const authResponse = await fetch('/api/auth/status');
    setAuth(await authResponse.json());
    await projectActions.bootstrap();
    bootstrapped.current = true;
    const projectId = projectIdFromPath(window.location.pathname);
    if (projectId) {
      await projectActions.openProject(projectId, { navigate: false });
    } else {
      setStatus('Dashboard');
    }
  }

  // ─── UI preference persistence ────────────────────────────────────────────

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(fontScale));
    localStorage.setItem('imagex.fontScale', String(fontScale));
  }, [fontScale]);

  useEffect(() => {
    localStorage.setItem('imagex.minimap', String(showMinimap));
  }, [showMinimap]);

  useEffect(() => {
    localStorage.setItem('imagex.rightOpen', String(rightOpen));
  }, [rightOpen]);

  useEffect(() => {
    localStorage.setItem('imagex.sidePanelWidth', String(sidePanelWidth));
  }, [sidePanelWidth]);

  useEffect(() => {
    localStorage.setItem('imagex.rightWidth', String(rightWidth));
  }, [rightWidth]);

  // ─── Routing (popstate) ────────────────────────────────────────────────────

  useEffect(() => {
    const onPopState = () => {
      if (window.location.pathname === '/settings') {
        setShowSettings(true);
        return;
      }
      setShowSettings(false);
      const projectId = projectIdFromPath(window.location.pathname);
      if (projectId) {
        void projectActions.openProject(projectId, { navigate: false });
        return;
      }
      projectActions.closeProject();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (window.location.pathname === '/settings') {
      setShowSettings(true);
    }
  }, []);

  // ─── Settings routing ──────────────────────────────────────────────────────

  function openSettingsRoute() {
    setShowSettings(true);
    if (window.location.pathname !== '/settings') window.history.pushState({}, '', '/settings');
  }

  function closeSettingsRoute() {
    setShowSettings(false);
    if (window.location.pathname === '/settings') {
      if (project) {
        pushProjectRoute(project);
      } else {
        window.history.pushState({}, '', '/');
      }
    }
  }

  // ─── Top bar menu dispatcher ───────────────────────────────────────────────

  function handleTopBarMenuAction(action: string) {
    if (!workflow) return;
    if (action === 'file-new-workflow') void projectActions.createWorkflow();
    if (action === 'file-rename-workflow') projectActions.renameWorkflowFromMenu(workflow.id);
    if (action === 'file-compile-prompt') void handleShowCompiledPrompt(editor.selectedId ?? undefined);
    if (action === 'edit-undo') editor.undo();
    if (action === 'edit-redo') editor.redo();
    if (action === 'edit-duplicate') editor.duplicateSelection();
    if (action === 'edit-delete') editor.deleteSelection();
    if (action === 'edit-disconnect') editor.disconnectSelection();
    if (action === 'edit-detach-frame') editor.detachSelectionFromFrames();
    if (action === 'edit-clear-selection') editor.clearSelection();
    if (action === 'view-zoom-in') editor.flowApiRef.current?.zoomIn();
    if (action === 'view-zoom-out') editor.flowApiRef.current?.zoomOut();
    if (action === 'view-fit') editor.flowApiRef.current?.fitView();
    if (action === 'view-toggle-minimap') setShowMinimap((current) => !current);
    if (action === 'view-toggle-inspector') setRightOpen((current) => !current);
    if (action === 'settings-open') openSettingsRoute();
    if (action === 'settings-shortcuts') setShowShortcuts(true);
    if (action === 'exit-project') projectActions.closeProject();
  }

  // ─── Compiled prompt with overlay ──────────────────────────────────────────

  async function handleShowCompiledPrompt(nodeId?: string) {
    const prompt = await editor.showCompiledPrompt(nodeId);
    if (prompt !== undefined) {
      setPromptOverlay({ prompt });
    }
  }

  // ─── Context menu dispatcher ───────────────────────────────────────────────

  function handleMenuAction(action: string, menuState: Exclude<FloatingMenu, null>) {
    setMenu(null);
    if (menuState.type === 'node') {
      if (action === 'duplicate') editor.duplicateNode(menuState.nodeId);
      if (action === 'create-asset') projectActions.openCreateNodeAssetDialog(menuState.nodeId);
      if (action === 'delete') editor.deleteNode(menuState.nodeId);
      if (action === 'disconnect') editor.disconnectNode(menuState.nodeId);
      if (action === 'remove-frame') editor.removeFrameOnly(menuState.nodeId);
      if (action === 'detach-frame') detachNodeFromFrame(menuState.nodeId);
      return;
    }
    if (menuState.type === 'selection') {
      if (action === 'duplicate') editor.duplicateSelection();
      if (action === 'create-asset') projectActions.openCreateNodeAssetDialog('__selection__');
      if (action === 'delete') editor.deleteSelection();
      if (action === 'disconnect') editor.disconnectSelection();
      if (action === 'detach-frame') editor.detachSelectionFromFrames();
      return;
    }
    if (menuState.type === 'pane') {
      if (action.startsWith('add:')) editor.addNode(action.slice(4) as NodeType, { x: menuState.flowX, y: menuState.flowY });
      return;
    }
    if (menuState.type === 'workflow') {
      if (action === 'rename') projectActions.renameWorkflowFromMenu(menuState.workflowId);
      if (action === 'delete') projectActions.deleteWorkflow(menuState.workflowId);
      return;
    }
    if (menuState.type === 'asset') {
      if (action === 'rename') projectActions.renameAsset(menuState.assetId);
      if (action === 'delete') projectActions.deleteAsset(menuState.assetId);
      return;
    }
    if (menuState.type === 'output-asset') {
      if (action === 'rename') projectActions.renameOutputAsset(menuState.assetId);
      if (action === 'delete') projectActions.deleteOutputAsset(menuState.assetId);
      return;
    }
    if (menuState.type === 'node-asset') {
      if (action === 'rename') projectActions.renameNodeAsset(menuState.assetId);
      if (action === 'delete') projectActions.deleteNodeAsset(menuState.assetId);
      return;
    }
    if (menuState.type === 'project') {
      if (action === 'open') void projectActions.openProject(menuState.projectId);
      if (action === 'rename') projectActions.renameProjectFromMenu(menuState.projectId);
      if (action === 'delete') void projectActions.deleteProjectFromMenu(menuState.projectId);
    }
  }

  function detachNodeFromFrame(_nodeId: string) {
    // The node is already selected by openNodeMenu, so detachSelectionFromFrames handles it.
    editor.detachSelectionFromFrames();
  }

  // ─── Asset picker ──────────────────────────────────────────────────────────

  function selectAssetForField(asset: ImageXAsset) {
    if (!assetPicker) return;
    editor.selectAssetForField(asset, assetPicker);
  }

  function selectOutputAssetForField(asset: ImageXOutputAsset) {
    if (!assetPicker) return;
    editor.selectAssetForField(asset, assetPicker);
  }

  // ─── Dialog submission ─────────────────────────────────────────────────────

  async function submitTextDialog(value: string) {
    if (!textDialog) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const dialog = textDialog;
    setTextDialog(null);
    if (dialog.type === 'rename-asset') await projectActions.submitRenameAsset(dialog.id, trimmed);
    if (dialog.type === 'rename-output-asset') await projectActions.submitRenameOutputAsset(dialog.id, trimmed);
    if (dialog.type === 'rename-node-asset') await projectActions.submitRenameNodeAsset(dialog.id, trimmed);
    if (dialog.type === 'rename-workflow') await projectActions.submitRenameWorkflow(dialog.id, trimmed);
    if (dialog.type === 'rename-project') await projectActions.submitRenameProject(dialog.id, trimmed);
    if (dialog.type === 'create-node-asset') await projectActions.createNodeAssetFromNode(dialog.id, trimmed);
  }

  async function submitConfirmDialog() {
    if (!confirmDialog) return;
    const dialog = confirmDialog;
    setConfirmDialog(null);
    if (dialog.type === 'delete-project') await projectActions.submitDeleteProject(dialog.id);
  }

  // ─── Dialogs JSX ───────────────────────────────────────────────────────────

  const appDialogs = (
    <>
      {textDialog && (
        <TextInputDialog
          title={textDialog.title}
          label={textDialog.label}
          initialValue={textDialog.initialValue}
          onCancel={() => setTextDialog(null)}
          onSubmit={(value) => {
            void submitTextDialog(value);
          }}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={() => {
            void submitConfirmDialog();
          }}
        />
      )}
    </>
  );

  // ─── Dashboard view ────────────────────────────────────────────────────────

  if (!project || !workflow) {
    return (
      <main className="dashboard-shell">
        <section className="dashboard-header">
          <div>
            <span className="brand dashboard-brand">
              <LogoWhite width={24} height={24} />
              imagex
            </span>
            <h1>Projects</h1>
            <p>Open a recent imagex project or create a new folder-backed project.</p>
          </div>
          <PrimaryActionButton onClick={() => setShowNewProject(true)}>
            New Project
          </PrimaryActionButton>
        </section>
        <section className="project-grid">
          {projectActions.projects.map((item) => (
            <button
              key={item.id}
              className="project-card shadcn-card-button"
              onClick={() => projectActions.openProject(item.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ type: 'project', projectId: item.id, x: event.clientX, y: event.clientY });
              }}
            >
              <strong>{item.title}</strong>
              <span>{item.description || 'No description'}</span>
              <small>{item.path}</small>
            </button>
          ))}
          {projectActions.projects.length === 0 && (
            <div className="empty-dashboard">
              <strong>No projects yet</strong>
              <span>Create a project from scratch or start from a workflow template.</span>
            </div>
          )}
        </section>
        {showNewProject && (
          <NewProjectModal
            templates={projectActions.templates}
            onCreate={projectActions.createProjectFromModal}
            onClose={() => setShowNewProject(false)}
          />
        )}
        {appDialogs}
        {notification && <BottomNotification message={notification} onClose={() => setNotification(null)} />}
        {menu && <FloatingContextMenu menu={menu} isFrame={false} canDetach={false} onClose={() => setMenu(null)} onAction={handleMenuAction} />}
      </main>
    );
  }

  // ─── Editor view ───────────────────────────────────────────────────────────
  const selectedOutputCount = editor.selectedNodeIds().filter((id) =>
    editor.nodes.some((node) => node.id === id && node.type === 'codex-output')
  ).length;
  const generationActive = editor.nodes.some((node) => {
    if (node.type !== 'codex-output') return false;
    const data = node.data.workflowNode.data;
    const generation = data.generation as { status?: string } | undefined;
    return Boolean(data.generating) || generation?.status === 'queued' || generation?.status === 'running';
  });

  return (
    <main className="app-shell">
      {/* Full-screen canvas workspace */}
      <section className="workspace">
        <FlowEditor
          onSelectNode={editor.setSelectedId}
          onNodeMenu={editor.openNodeMenu}
          onBeforeChange={editor.recordHistory}
          onPaneMenu={(position, flowPosition) => setMenu({ type: 'pane', x: position.x, y: position.y, flowX: flowPosition.x, flowY: flowPosition.y })}
          onSelectionMenu={(position) => setMenu({ type: 'selection', x: position.x, y: position.y })}
          onSelectionChangeIds={editor.handleSelectionChange}
          onNodeDragHoverFrame={editor.handleNodeDragFrameState}
          onNodeDragStopCheckFrames={editor.expandFramesForNode}
          onPaneClickClear={editor.clearSelection}
          onCommitFlow={() => editor.commitFlowToWorkflow()}
          onFlowReady={(api) => { editor.flowApiRef.current = api; }}
          placingNodeId={editor.placingNodeId}
          onPlacingMove={editor.handlePlacingMove}
          onPlacingDrop={editor.handlePlacingDrop}
          showMinimap={showMinimap}
        />
      </section>

      {/* Floating logo + menu button */}
      <div className="floating-panel floating-logo-btn">
        <LogoMenuButton
          onMenuAction={handleTopBarMenuAction}
          showMinimap={showMinimap}
          rightOpen={rightOpen}
        />
      </div>

      {/* Floating workflow tabs */}
      <div className="floating-panel floating-tabs">
        <TopBarTabs
          workflows={projectWorkflows(project)}
          activeWorkflowId={workflow.id}
          onSelectWorkflow={projectActions.selectWorkflow}
          onWorkflowMenu={(workflowId, position) => setMenu({ type: 'workflow', workflowId, x: position.x, y: position.y })}
          onCreateWorkflow={projectActions.createWorkflow}
        />
      </div>

      {/* Top-right actions container (run + inspector) */}
      <div className="top-bar-right">
        <TopBarRunControl
          onRun={editor.runWorkflow}
          onCancel={editor.cancelWorkflow}
          status={status}
          canRun={Boolean(workflow)}
          selectedOutputCount={selectedOutputCount}
          generationActive={generationActive}
        />
        <div className="inspector-toggle-wrap">
          <InspectorToggle onOpen={() => setRightOpen((open) => !open)} />
        </div>
      </div>

      {/* Floating sidebar pill */}
      <div className="floating-panel floating-sidebar">
        <Sidebar
          activePanel={activeSidePanel}
          onOpenPanel={(id) => setActiveSidePanel((current) => (current === id ? null : id))}
          onOpenModal={(id) => {
            if (id === 'settings') openSettingsRoute();
            if (id === 'shortcuts') setShowShortcuts(true);
          }}
        />
      </div>

      {/* Floating side panel */}
      {activeSidePanel && (
        <div
          className="floating-panel floating-side-panel"
          style={{ '--side-panel': `${sidePanelWidth}px` } as CSSProperties}
        >
          <SidePanel onClose={() => setActiveSidePanel(null)}>
            {activeSidePanel === 'workflows' && (
              <WorkflowsPanel
                workflows={projectWorkflows(project)}
                activeWorkflowId={workflow.id}
                onSelect={projectActions.selectWorkflow}
                onCreate={projectActions.createWorkflow}
                onMenu={(workflowId, position) => setMenu({ type: 'workflow', workflowId, x: position.x, y: position.y })}
                searchQuery={workflowSearchQuery}
                onSearch={setWorkflowSearchQuery}
              />
            )}
            {activeSidePanel === 'nodes' && <NodesPanel onAdd={editor.addNode} />}
            {activeSidePanel === 'assets' && workflow && (
              <AssetsPanel
                assets={projectActions.assets}
                outputAssets={projectActions.outputAssets}
                nodeAssets={projectActions.nodeAssets}
                onImport={projectActions.importAssets}
                onAddImageAsset={editor.addImageAssetNode}
                onAddOutputAsset={editor.addImageAssetNode}
                onAddNodeAsset={editor.addNodeAsset}
                onMenu={(assetId, position) => setMenu({ type: 'asset', assetId, x: position.x, y: position.y })}
                onOutputMenu={(assetId, position) => setMenu({ type: 'output-asset', assetId, x: position.x, y: position.y })}
                onNodeMenu={(assetId, position) => setMenu({ type: 'node-asset', assetId, x: position.x, y: position.y })}
                onRefreshOutputs={projectActions.refreshOutputAssets}
              />
            )}
          </SidePanel>
          <ResizeHandle side="left" onResize={setSidePanelWidth} min={200} max={400} />
        </div>
      )}

      {/* Floating inspector panel */}
      {rightOpen && (
        <div
          className="floating-panel floating-inspector"
          style={{ '--right-panel': `${rightWidth}px` } as CSSProperties}
        >
          <ResizeHandle side="right" onResize={setRightWidth} min={280} max={520} />
          <InspectorPanel
            node={editor.selectedNode}
            onChange={editor.updateNodeData}
            outputResults={outputResults}
            onClose={() => setRightOpen(false)}
            connectedHandles={editor.nodes.find((n) => n.id === editor.selectedId)?.data.connectedTargetHandles || []}
            onDisconnect={editor.disconnectHandle}
            onAddField={editor.addCustomField}
            onDynamicFieldChange={editor.updateCustomFieldValue}
            onOpenAssets={editor.openAssetPickerForField}
            onShowPrompt={(nodeId) => { void handleShowCompiledPrompt(nodeId); }}
          />
        </div>
      )}

      {menu && (
        <FloatingContextMenu
          menu={menu}
          isFrame={menu.type === 'node' && editor.nodes.some((node) => node.id === menu.nodeId && node.type === 'frame')}
          canDetach={
            menu.type === 'selection'
              ? editor.selectedNodeIds().some((id) => editor.nodes.some((node) => node.id === id && typeof node.data.workflowNode.data.frameId === 'string'))
              : menu.type === 'node' &&
                editor.nodes.some((node) => node.id === menu.nodeId && typeof node.data.workflowNode.data.frameId === 'string')
          }
          onClose={() => setMenu(null)}
          onAction={handleMenuAction}
        />
      )}
      {showSettings && (
        <SettingsModal
          auth={auth}
          fontScale={fontScale}
          onFontScale={setFontScale}
          historyLimit={editor.historyLimit}
          onHistoryLimit={editor.setHistoryLimit}
          undoCount={editor.undoCount}
          redoCount={editor.redoCount}
          onClose={() => closeSettingsRoute()}
        />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {assetPicker && (
        <AssetsModal
          assets={projectActions.assets}
          outputAssets={projectActions.outputAssets}
          onImport={projectActions.importAssets}
          onSelect={selectAssetForField}
          onSelectOutput={selectOutputAssetForField}
          onMenu={(assetId, position) => setMenu({ type: 'asset', assetId, x: position.x, y: position.y })}
          onOutputMenu={(assetId, position) => setMenu({ type: 'output-asset', assetId, x: position.x, y: position.y })}
          onClose={() => setAssetPicker(null)}
        />
      )}

      {appDialogs}
      {promptOverlay && <PromptOverlay prompt={promptOverlay.prompt} onClose={() => setPromptOverlay(null)} />}
      {notification && <BottomNotification message={notification} onClose={() => setNotification(null)} />}
    </main>
  );
}

// ─── Helper functions ────────────────────────────────────────────────────────

function projectWorkflows(project: ImageXProject): Array<{ id: string; title: string }> {
  const workflows = project.metadata.workflows?.length
    ? project.metadata.workflows
    : [{ id: project.workflow.id, title: project.workflow.name, file: project.metadata.workflowFile }];
  return workflows.map((workflow) => ({ id: workflow.id, title: workflow.title }));
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ResizeHandle({
  side,
  onResize,
  min,
  max,
}: {
  side: 'left' | 'right';
  onResize: (width: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div
      className={`resize-handle ${side}`}
      onMouseDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const panel = side === 'left' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling;
        const startWidth = panel?.getBoundingClientRect().width || min;
        const onMove = (moveEvent: MouseEvent) => {
          const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
          onResize(Math.max(min, Math.min(max, startWidth + delta)));
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }}
    />
  );
}

type MenuAction = { action: string; label: string; danger?: boolean };
type MenuGroup = { items: MenuAction[] };

function FloatingContextMenu({
  menu,
  isFrame,
  canDetach,
  onClose,
  onAction,
}: {
  menu: Exclude<FloatingMenu, null>;
  isFrame: boolean;
  canDetach: boolean;
  onClose: () => void;
  onAction: (action: string, menu: Exclude<FloatingMenu, null>) => void;
}) {
  const groups: MenuGroup[] =
    menu.type === 'pane'
      ? [
          {
            items: [
              { action: 'add:prompt', label: 'Add Prompt' },
              { action: 'add:image', label: 'Add Image' },
              { action: 'add:color', label: 'Add Color' },
              { action: 'add:file', label: 'Add File' },
            ],
          },
          { items: [{ action: 'add:codex-output', label: 'Add Output' }] },
          {
            items: [
              { action: 'add:color-balance', label: 'Add Color Balance' },
              { action: 'add:rotate-flip', label: 'Add Rotate/Flip' },
              { action: 'add:crop', label: 'Add Crop' },
              { action: 'add:blur', label: 'Add Blur' },
              { action: 'add:download', label: 'Add Download' },
            ],
          },
          { items: [{ action: 'add:frame', label: 'Add Frame' }] },
        ]
      : menu.type === 'workflow'
        ? [
            { items: [{ action: 'rename', label: 'Rename' }] },
            { items: [{ action: 'delete', label: 'Delete', danger: true }] },
          ]
        : menu.type === 'asset'
          ? [
              { items: [{ action: 'rename', label: 'Rename' }] },
              { items: [{ action: 'delete', label: 'Delete', danger: true }] },
            ]
          : menu.type === 'output-asset'
            ? [
                { items: [{ action: 'rename', label: 'Rename' }] },
                { items: [{ action: 'delete', label: 'Delete', danger: true }] },
              ]
          : menu.type === 'node-asset'
            ? [
                { items: [{ action: 'rename', label: 'Rename' }] },
                { items: [{ action: 'delete', label: 'Delete', danger: true }] },
              ]
          : menu.type === 'project'
            ? [
                { items: [{ action: 'open', label: 'Open' }] },
                { items: [{ action: 'rename', label: 'Rename' }] },
                { items: [{ action: 'delete', label: 'Delete', danger: true }] },
              ]
            : [
                {
                  items: [
                    { action: 'duplicate', label: 'Duplicate' },
                    ...(isFrame ? [] : [{ action: 'create-asset', label: 'Create node asset' } as MenuAction]),
                    ...(canDetach ? [{ action: 'detach-frame', label: 'Detach from frame' } as MenuAction] : []),
                  ],
                },
                {
                  items: [
                    { action: 'disconnect', label: 'Disconnect all edges' },
                    ...(isFrame ? [{ action: 'remove-frame', label: 'Remove frame only' } as MenuAction] : []),
                  ],
                },
                { items: [{ action: 'delete', label: 'Delete', danger: true }] },
              ];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <>
      <div
        className="menu-backdrop"
        role="button"
        aria-label="Close menu"
        tabIndex={-1}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div className="node-menu" style={{ left: menu.x, top: menu.y }}>
        <div className="menu-list">
          {groups.map((group, gIndex) => (
            <Fragment key={gIndex}>
              {gIndex > 0 && <div className="menu-separator" />}
              {group.items.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  className={`menu-item ${item.danger ? 'danger' : ''}`}
                  onClick={() => onAction(item.action, menu)}
                >
                  {item.label}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </>
  );
}

function useDismiss(onClose: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
}

function NewProjectModal({
  templates,
  onCreate,
  onClose,
}: {
  templates: ImageXTemplateSummary[];
  onCreate: (input: { title: string; description: string; templateId: string }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState(templates[0]?.id || 'scratch');
  const handleBackdrop = useDismiss(onClose);
  return (
    <div className="prompt-overlay-backdrop" role="dialog" aria-modal="true" onClick={handleBackdrop}>
      <section className="new-project-modal">
        <header>
          <h2>New Project</h2>
          <button type="button" className="ix-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="new-project-form">
          <label>
            <span>Title</span>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </label>
          <label>
            <span>Description</span>
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </label>
          <div className="template-picker">
            {templates.map((template) => (
              <Button
                key={template.id}
                variant={template.id === templateId ? 'secondary' : 'outline'}
                className={template.id === templateId ? 'selected template-choice' : 'template-choice'}
                type="button"
                onClick={() => setTemplateId(template.id)}
              >
                <strong>{template.title}</strong>
                <span>{template.description}</span>
              </Button>
            ))}
          </div>
          <Button
            onClick={() => onCreate({ title: title.trim() || 'Untitled Project', description, templateId })}
          >
            Create Project
          </Button>
        </div>
      </section>
    </div>
  );
}

function TextInputDialog({
  title,
  label,
  initialValue,
  onCancel,
  onSubmit,
}: {
  title: string;
  label: string;
  initialValue: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const canSubmit = value.trim().length > 0;
  const handleBackdrop = useDismiss(onCancel);
  return (
    <div className="prompt-overlay-backdrop" role="dialog" aria-modal="true" onClick={handleBackdrop}>
      <section className="dialog-modal">
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit(value);
          }}
        >
          <header>
            <h2>{title}</h2>
          </header>
          <label>
            <span>{label}</span>
            <Input value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
          </label>
          <div className="dialog-actions">
            <Button variant="ghost" size="icon" type="button" onClick={onCancel} aria-label="Cancel"><X size={16} /></Button>
            <Button type="submit" disabled={!canSubmit}>
              Save
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const handleBackdrop = useDismiss(onCancel);
  return (
    <div className="prompt-overlay-backdrop" role="dialog" aria-modal="true" onClick={handleBackdrop}>
      <section className="dialog-modal">
        <div className="dialog-form">
          <header>
            <h2>{title}</h2>
          </header>
          <p className="dialog-message">{message}</p>
          <div className="dialog-actions">
            <Button variant="ghost" size="icon" type="button" onClick={onCancel} aria-label="Cancel"><X size={16} /></Button>
            <Button className="danger" type="button" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

const nodeChoices: Array<{ type: NodeType; label: string; description: string; icon: ComponentType<{ size?: number }> }> = [
  { type: 'prompt', label: 'Prompt', description: 'Prompt text fragment', icon: FileText },
  { type: 'image', label: 'Image', description: 'Reference or edit target', icon: Image },
  { type: 'color', label: 'Color', description: 'Color picker', icon: Palette },
  { type: 'file', label: 'File', description: 'Document attachment', icon: Component },
  { type: 'codex-output', label: 'Output', description: 'Generation target', icon: Box },
  { type: 'color-balance', label: 'Color Balance', description: 'RGB/HSL adjustment', icon: Layers3 },
  { type: 'rotate-flip', label: 'Rotate/Flip', description: 'Rotation and flip', icon: MapPin },
  { type: 'frame', label: 'Frame', description: 'Group nodes visually', icon: Frame },
];

function AssetsModal({
  assets,
  outputAssets,
  onImport,
  onSelect,
  onSelectOutput,
  onMenu,
  onOutputMenu,
  onClose,
}: {
  assets: ImageXAsset[];
  outputAssets: ImageXOutputAsset[];
  onImport: (files: FileList | null) => void;
  onSelect: (asset: ImageXAsset) => void;
  onSelectOutput: (asset: ImageXOutputAsset) => void;
  onMenu: (assetId: string, position: { x: number; y: number }) => void;
  onOutputMenu: (assetId: string, position: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<'images' | 'outputs'>('images');
  const handleBackdrop = useDismiss(onClose);
  return (
    <div className="prompt-overlay-backdrop" role="dialog" aria-modal="true" onClick={handleBackdrop}>
      <section className="assets-modal">
        <header>
          <div>
            <h2>Image Assets</h2>
            <p>Select an existing image or import more into this project.</p>
          </div>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => inputRef.current?.click()}>Import Images</Button>
          <button type="button" className="ix-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void onImport(event.target.files);
              event.currentTarget.value = '';
            }}
          />
        </header>
        <div className="assets-modal-body">
          <div className="asset-picker-tabs">
            <button type="button" className={tab === 'images' ? 'active' : ''} onClick={() => setTab('images')}>Images</button>
            <button type="button" className={tab === 'outputs' ? 'active' : ''} onClick={() => setTab('outputs')}>Outputs</button>
          </div>
          <div className="asset-grid-compact">
            {(tab === 'images' ? assets : outputAssets).map((asset) => (
              <article
                key={asset.id}
                className="asset-card-compact"
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (asset.type === 'image') onMenu(asset.id, { x: event.clientX, y: event.clientY });
                  else onOutputMenu(asset.id, { x: event.clientX, y: event.clientY });
                }}
              >
                <button type="button" onClick={() => asset.type === 'image' ? onSelect(asset) : onSelectOutput(asset)}>
                  <span className="asset-thumbnail">
                    <img src={asset.url} alt={asset.name} loading="lazy" />
                  </span>
                  <span className="asset-name">{asset.name}</span>
                </button>
              </article>
            ))}
            {tab === 'images' && assets.length === 0 && <p className="muted">No image assets in this project yet.</p>}
            {tab === 'outputs' && outputAssets.length === 0 && <p className="muted">No generated outputs in this project yet.</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsModal({
  auth,
  fontScale,
  onFontScale,
  historyLimit,
  onHistoryLimit,
  undoCount,
  redoCount,
  onClose,
}: {
  auth: AuthStatus | null;
  fontScale: number;
  onFontScale: (scale: number) => void;
  historyLimit: number;
  onHistoryLimit: (limit: number) => void;
  undoCount: number;
  redoCount: number;
  onClose: () => void;
}) {
  const handleBackdrop = useDismiss(onClose);
  const [previewRes, setPreviewRes] = useState(() => Number(localStorage.getItem('imagex.previewResolution')) || 1024);
  return (
    <div className="prompt-overlay-backdrop" role="dialog" aria-modal="true" onClick={handleBackdrop}>
      <section className="settings-modal">
        <header>
          <h2>Settings</h2>
          <button type="button" className="ix-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="settings-content">
          <section className="settings-status">
            <div>
              <span>Daemon</span>
              <strong>Connected</strong>
            </div>
            <div>
              <span>Authentication</span>
              <strong>{auth?.authenticated ? 'Authenticated' : 'Run imagex auth'}</strong>
            </div>
          </section>
          <label className="settings-row">
            <span>Font scale</span>
            <Slider min={0.5} max={3} step={0.1} value={[fontScale]} onValueChange={(value) => onFontScale(value[0] ?? fontScale)} />
            <strong>{fontScale.toFixed(2)}x</strong>
          </label>
          <label className="settings-row">
            <span>Preview resolution</span>
            <Select
              value={String(previewRes)}
              onValueChange={(val) => { const v = Number(val); setPreviewRes(v); setPreviewResolution(v); }}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4} style={{ zIndex: 9999 }}>
                <SelectItem value="512">512px (Fast)</SelectItem>
                <SelectItem value="768">768px</SelectItem>
                <SelectItem value="1024">1024px (Default)</SelectItem>
                <SelectItem value="1280">1280px</SelectItem>
                <SelectItem value="1536">1536px</SelectItem>
                <SelectItem value="2048">2048px (Quality)</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="settings-row">
            <span>History size</span>
            <Slider min={10} max={200} step={5} value={[historyLimit]} onValueChange={(value) => onHistoryLimit(value[0] ?? historyLimit)} />
            <strong>{historyLimit}</strong>
          </label>
          <section className="settings-status">
            <div>
              <span>Undo entries</span>
              <strong>{undoCount}</strong>
            </div>
            <div>
              <span>Redo entries</span>
              <strong>{redoCount}</strong>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const handleBackdrop = useDismiss(onClose);
  return (
    <div className="prompt-overlay-backdrop" role="dialog" aria-modal="true" onClick={handleBackdrop}>
      <section className="settings-modal shortcuts-modal">
        <header>
          <h2>Shortcuts</h2>
          <button type="button" className="ix-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="shortcut-list">
          {editorShortcuts.map((shortcut) => (
            <div key={shortcut.id}>
              <kbd>{shortcut.label}</kbd>
              <span>{shortcut.description}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PromptOverlay({ prompt, onClose }: { prompt: string; onClose: () => void }) {
  const formatted = formatJsonPrompt(prompt);
  return (
    <div className="prompt-overlay-backdrop" role="dialog" aria-modal="true" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="prompt-overlay">
        <header>
          <h2>Compiled Prompt</h2>
          <button type="button" className="ix-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        {formatted ? <JsonCodeBlock code={formatted} /> : <div className="empty-preview">No prompt generated</div>}
      </section>
    </div>
  );
}

function formatJsonPrompt(prompt: string): string {
  try {
    return JSON.stringify(JSON.parse(prompt), null, 2);
  } catch {
    return prompt;
  }
}
