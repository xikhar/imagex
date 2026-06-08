# AGENTS.md

This file is the onboarding note for AI coding agents working in ImageX. Keep it current, concise, and open-ended: update it when architecture, commands, storage, or product direction changes.

## Project Purpose

ImageX is a local-first, node-based image generation workflow editor. Users compose prompts, image references, colors, files, image-processing steps, and AI output nodes into a DAG; the app previews image edits locally and compiles the graph into structured JSON prompts plus image references for generation.

The current checkout is a Vite/React web app plus a local Express daemon. Do not assume an Electron wrapper exists unless the codebase gains one.

## Current Shape

- Package manager: `npm` with `package-lock.json`; do not switch package managers casually.
- Runtime: Node.js 20+, ESM TypeScript, React 19, Vite, Tailwind CSS v4, shadcn/ui, React Flow, Zustand, raw WebGL frontend image pipelines, photon-node daemon transforms, Express.
- Main commands:
  - Install: `npm install`
  - Dev app: `npm run dev` starts daemon on `127.0.0.1:3847` and Vite on `127.0.0.1:5173`
  - Web only: `npm run dev:web`
  - Daemon only: `npm run dev:daemon`
  - Remote bind, only on a trusted network: `npx tsx src/cli/index.ts ui --host 0.0.0.0 --allow-remote`
  - Type check: `npm run check`
  - Tests: `npm test` runs typecheck, unit tests, WebGL browser verification, and workflow E2E verification
  - WebGL verifier only: `npm run test:webgl`
  - Workflow E2E verifier only: `npm run test:e2e`
  - Production build: `npm run build`
  - Start built daemon/UI: `npm start`
- CLI commands:
  - Auth: `npx tsx src/cli/index.ts auth`
  - Status: `npx tsx src/cli/index.ts whoami` or `npx tsx src/cli/index.ts doctor`
  - Logout: `npx tsx src/cli/index.ts logout`

## Read These First

- `README.md` for the human-facing overview and quickstart.
- `package.json`, `vite.config.ts`, `tsconfig.json`, and `components.json` for tooling.
- `src/shared/types.ts` for persisted workflow, project, node, asset, and generation schemas.
- `src/web/ui/flow/meta.ts`, `src/web/ui/flow/ports.ts`, and `src/web/ui/flow/fields/definitions.ts` for node catalog, port compatibility, and field definitions.
- `src/workflows/compiler.ts` for graph-to-prompt compilation.
- `src/daemon/server.ts` for API routes, durable generation jobs, output-node run planning, image-reference resolution, and server-side image transforms.
- `src/providers/codexImage.ts` for the Codex Responses image tool transport. `CODEX_API_BASE` can point to a local mock endpoint during development.
- `src/projects/store.ts` and `src/workflows/store.ts` for local persistence.
- `src/web/state/flowStore.ts`, `src/web/state/graphEngine.ts`, and `src/web/ui/flow/imaging/` for the performance-sensitive editor and preview pipeline.
- `src/web/ui/App.tsx`, `src/web/styles.css`, `src/web/ui/editor/TopBar/`, `src/web/ui/editor/Sidebar/`, `src/web/ui/editor/SidePanel/`, and `src/web/ui/editor/InspectorPanel/` for the floating editor shell.
- `src/web/ui/editor/useEditorActions.ts` and `src/web/ui/editor/useProjectActions.ts` for workflow, project, generation, asset, undo/redo, and autosave behavior.

Gitignored local notes may exist. Treat them as private context only; do not quote unpublished details into tracked files.

## Architecture Invariants

- Persisted workflow data uses `ImageXWorkflow`, `ImageXNode`, and `ImageXEdge` from `src/shared/types.ts`. React Flow nodes are adapters around those workflow nodes, not a separate source of truth.
- `FlowStore` owns React Flow nodes and edges. `FlowEditor` reads them through store hooks, keeps React Flow props stable, and lets React Flow handle transient drag positions. Durable workflow sync happens on drag stop; selection, dimension, and position-only changes must not wake `GraphEngine`.
- Keep React Flow handle dragging as the only connection gesture. `FlowEditor` sets `connectOnClick={false}` because click-to-connect can leave handles in a bad pointer-event state after interrupted connection attempts.
- Dynamic handles must refresh React Flow internals when their ids or positions change. `BaseNode` owns this for node-level input/output handle signatures, including output image sockets that appear after generation.
- ImageX node components use a custom `React.memo` comparator that ignores React Flow position and dragging props. The wrapper owns live movement; node content should re-render only for rendered data, selection, type/id, or connectability changes.
- Keep React Flow handles visible outside node borders. Do not use paint containment on `.react-flow__node` or `.ix-node`; scope containment to internal preview/media boxes.
- Media-node pan/zoom performance depends on stable DOM and warm decoded surfaces. Avoid `onlyRenderVisibleElements` unless profiling proves it helps, keep `viewport-zooming` narrow, and preserve the `refreshPreviewSurfaces()` post-layout refresh in `FlowEditor`.
- The editor shell is a floating-panel layout. `App.tsx` renders the `FlowEditor` as a fixed full-screen workspace behind independent fixed panels: logo/menu, workflow tabs, top-right run/inspector controls, left sidebar pill, optional side panel, and optional inspector panel. Do not reintroduce a grid-column shell or always-visible collapsed inspector rail.
- Top-bar UI is split intentionally: `LogoMenuButton` lives in `Sidebar/index.tsx`, while `TopBarTabs` and `TopBarRunControl` live in `TopBar/index.tsx`.
- `App.tsx` orchestrates top-level UI state with `useEditorActions` and `useProjectActions`. `src/web/state/editorStore.ts` exists, but verify active usage before moving logic into it.
- `GraphEngine` owns image dependency tracing and per-node/downstream invalidation. It should not eagerly reprocess every preview on global node/edge changes. Use the `ongoing` flag for live slider/drag updates so downstream invalidation waits until commit.
- Edit-node previews, graph exports, and frontend downloads use the shared raw WebGL pipeline in `src/web/ui/flow/imaging/`. Keep one shared WebGL renderer with cached source textures; visible previews may use preview resolution caps, but export/download/server paths must preserve full-resolution coordinates. Output-node and image-selector previews use `PreviewImage` with bounded 2048px long-edge decoding.
- Prompt compilation is structured data, not prose concatenation. Nodes compile into nested JSON objects; duplicate field labels become arrays; image placeholders start as `__imagex_ref` markers and are post-processed into `[image-N]` references.
- Primitive node text fields start from built-in defaults for old workflows, but managed nodes store an authoritative `data.fields` list with `data.fieldsMode: 'managed'`. Keep ports, compiler traversal, and UI rendering aligned with `fieldDefinitionsFor()`. Prompt nodes must retain at least one text-like field.
- Image-editing nodes pass image references through the compiler; actual transforms are applied by the frontend preview path and mirrored on the daemon before generation. Edit nodes process one image input, so reconnecting `image-in` replaces the old edge.
- Each `codex-output` node corresponds to one generation target. Output dependencies must run in topological order, independent topo levels may run in parallel, circular output dependencies must be detected, and generated images remain individually addressable through `result-out` / `result-out:<index>` handles.
- Dynamic output image handles must not leave orphaned edges when previews are cleared or regenerated. Duplicated output nodes may keep their previous preview, but connecting or reconnecting a new input into an output node must clear stale output generation state.
- The asset library has three asset classes: imported image assets, reusable node assets, and generated output assets flattened from durable run history. Deleting or renaming image/output assets must reconcile any current workflow nodes that reference their `assetId` or `assetUrl`.
- Asset rename/delete workflow cleanup lives in `src/web/ui/editor/assetReconciliation.ts`. Keep generated-output image deletion, dynamic handle shifting, imported asset cleanup, and generation status updates covered by unit tests.
- Node assets are reusable workflow snippets with `schemaVersion: 1`. The root must be a non-frame node; frames may be included only as containers. Save and insert paths must strip transient UI state, output generation state, stale generated-output references, and non-internal edges while preserving relative node positions and valid imported asset references.

## Generation Architecture

- Project generation is a durable daemon-managed job system, not client-only state. Shared types live in `src/shared/types.ts` (`GenerationRunMode`, `GenerationJobStatus`, `OutputNodeGenerationState`).
- The web app may recover generation state through `/generate-status`, but `useProjectActions` must own exactly one active recovery poll. Polls must be aborted and sequence-checked on project load, workflow switch, dashboard close, and unmount so stale generation responses cannot patch the active editor.
- Run modes are:
  - `selected`: run selected output nodes; run empty upstream output dependencies first, but reuse stored upstream output results when present.
  - `forced`: run selected output nodes and all upstream output dependencies again.
  - `all`: run every output node as a forced run in dependency order.
- Per-output generation state is stored on each output node under `node.data.generation`, with `node.data.generating` used by the UI to keep Run disabled across refreshes.
- Per-run assets and metadata are stored under the project output directory:
  - `outputs/runs/index.json` tracks the newest 50 run records in chronological creation order.
  - `outputs/runs/<job-id>/job.json` stores the full run record.
  - `outputs/runs/<job-id>/<output-node-id>/` stores generated files for that output node.
- `/api/projects/:projectId/generate-status` is the recovery source of truth after refresh or daemon restart. If a persisted job is still marked running but no active in-memory job exists, reconcile complete saved outputs to `done`, partial saved outputs to `partial`, and empty outputs to `error`.
- `/api/projects/:projectId/generate/cancel` aborts the active provider requests and persists partial output state. UI cancel controls should call this endpoint before clearing local state.
- Do not reintroduce client-only polling as the source of truth for generation progress. Stream events and polling should both apply the same `GenerationJobStatus` shape.
- Generation stream error events must include the final job status so the UI clears `generating` and shows node-level errors after provider failures.
- `/api/projects/:projectId/output-assets` exposes generated output images as a flattened asset list. Rename/delete operations update the durable run `job.json` and `outputs/runs/index.json`; delete also removes the generated file when it is still under the project outputs root.
- Project output file-serving supports nested `outputs/runs/...` paths and must preserve path traversal checks.
- Mutating `/api/*` routes require the per-process `x-imagex-session` token from `/api/session`. The web app installs this automatically in `src/web/client/sessionFetch.ts`; test scripts that call the daemon directly must fetch and send the token.

## Product And UX Direction

- Keep the app as a dense, dark, keyboard-first workflow editor, not a marketing page.
- Use existing design tokens in `src/web/styles.css` and component styling in the nearby CSS module for the feature being changed.
- Current visual language: near-black surfaces, warm amber accent, per-node accent colors, Geist sans, JetBrains Mono for code/data, lucide icons.
- **Buttons**: primary/default buttons use an **outline** style (transparent bg, subtle border, amber on hover) — not filled. See `.ix-primary-action-btn` and `[data-slot='button'][data-variant='default']` in `styles.css`.
- **Floating panels**: editor chrome uses `.floating-panel` plus specific classes such as `.floating-logo-btn`, `.floating-tabs`, `.floating-sidebar`, `.floating-side-panel`, and `.floating-inspector`. Keep panels off the viewport edges using `--top-bar-gap`, `--top-bar-height`, and matching side/bottom offsets.
- **Close buttons**: use the shared `.ix-close-btn` class for panel and modal close controls.
- **Menus/dropdowns**: all use shared canonical classes from `src/web/ui/components/dropdown.css` — `.menu-shell`/`.ix-dropdown` for the container, `.menu-list`/`.ix-dropdown-list` for the wrapper, `.menu-item`/`.ix-dropdown-item` for rows, `.menu-separator`/`.ix-dropdown-separator` for dividers. Keep this consistent when adding new menus.
- **Typography**: font sizes are defined as CSS variables in `styles.css` (`--ui-text-xs` through `--ui-text-xl`). Use these variables instead of hardcoded rem values.
- Use shadcn components already present under `src/web/components/ui` before inventing custom primitives. Use the shadcn `Select`, not native `<select>`, for app UI.
- Use icons for tool actions where a familiar icon exists. Avoid emoji unless explicitly requested.
- Keep node dimensions stable. If adding fields, controls, labels, previews, or loading states, check that they do not resize nodes unpredictably or make text overflow.
- The `A` shortcut opens the same canvas add-node context menu used by right-clicking the pane; it should not toggle the sidebar node panel.

## Feature Entry Points

When adding a new node type, usually update:

- `src/shared/types.ts`
- `src/web/ui/flow/meta.ts`
- `src/web/ui/flow/ports.ts`
- `src/web/ui/flow/fields/definitions.ts`
- `src/web/ui/flow/adapters.ts`
- `src/web/ui/flow/nodes/ImageXNode.tsx` and possibly `NodeContent.tsx`
- `src/workflows/compiler.ts`
- `src/web/state/graphEngine.ts` and `src/web/ui/flow/imaging/` if the node produces or transforms images
- `src/daemon/server.ts` if generation needs server-side parity

When changing image operations, keep frontend WebGL preview, full-resolution download, prompt compilation behavior, daemon-side generation transforms, and `npm run test:webgl` coverage aligned.

When changing providers or auth, keep all provider-specific code isolated under `src/providers/` and `src/auth/`, then thread only typed options through the daemon/UI. Do not mix API-key and OAuth flows without an explicit product decision.

When changing generation provider behavior, keep `CODEX_API_BASE` override support intact. A separate local mock service may live outside this repo at `/home/shikhar/Projects/codex-image-mock-service`; do not document it as a required dependency for ImageX.

When changing persistence, include schema compatibility for existing files under `IMAGEX_HOME` or `~/.imagex`.

## Data, Auth, And Security

- Local data root is `process.env.IMAGEX_HOME || ~/.imagex`.
- Auth is stored in `auth.json` with restrictive permissions. Never commit credentials, generated project data, `.env`, or outputs.
- The daemon defaults to loopback hosts. Non-loopback binds require `--allow-remote` and should be treated as trusted-network only; the local session token is a CSRF guard, not remote user authentication.
- Project assets and outputs are served through daemon routes that guard against path traversal. Preserve those checks when touching file-serving code.
- Avoid adding telemetry or external network calls outside explicit auth/generation flows.
- For local generation testing without real network image calls, start ImageX with `CODEX_API_BASE=http://127.0.0.1:8787/backend-api/codex/responses` only when a local mock service is intentionally running.

## Code Quality Choices

- TypeScript is strict. Prefer shared types and narrow boundary validation over `any`.
- Keep imports compatible with the current ESM setup. Local TS imports generally use `.js` specifiers.
- Keep graph/compiler/persistence transforms deterministic and easy to test with plain data.
- Prefer small, local abstractions over broad rewrites. The editor has performance-sensitive state boundaries; measure or reason carefully before changing them.
- Do not copy names, comments, file names, or branding from private/reference code into tracked files.
- If changing UI, verify with the running app when practical, especially React Flow dragging, connection validation, node sizing, image previews, and modals.

## Verification

- Docs-only changes: no build is required, but check Markdown manually.
- TypeScript/source changes: run `npm run check`.
- Frontend image pipeline changes: run `npm run test:webgl`; it launches Vite and headless Chrome through DevTools Protocol to verify representative node-step outputs and a cached render-loop performance guard.
- Changes touching build config, daemon, provider, or packaging: run `npm run build`.
- UI behavior changes: run `npm run dev` and inspect `http://127.0.0.1:5173`.
- Generation changes: if auth is unavailable, still verify compile endpoints and UI state; do not claim live image generation worked.
- Workflow browser regressions: run `npm run test:e2e`. It starts ImageX with a temp `IMAGEX_HOME`, Vite with `IMAGEX_DAEMON_URL`, Chrome through DevTools Protocol, and a local mock Codex Responses endpoint.

## Installed Skills

Skills live under `.agents/skills/` and are tracked by `skills-lock.json`.

- `frontend-design`: use for substantial UI creation or visual redesign while preserving ImageX's workflow-editor product shape.
- `shadcn`: use when adding, updating, debugging, or composing shadcn/ui components. Run `npx shadcn@latest docs <component>` before relying on component APIs.
- `tailwind-design-system`: use for Tailwind v4 tokens, theming, and reusable design-system work.
- `vercel-react-best-practices`: use for React performance, data fetching, bundle, rendering, or rerender-sensitive changes.
- `vercel-composition-patterns`: use for component API refactors, compound components, and avoiding boolean-prop sprawl.
- `web-design-guidelines`: use for UI, accessibility, and UX review passes.

## External References

- React Flow LLM index: https://reactflow.dev/llms.txt
- React Flow docs to consider for this app: custom nodes, handles, validation, prevent cycles, performance, computing flows, grouping/subflows, undo/redo, and testing.
- OpenAI image generation and Responses image tool docs: https://platform.openai.com/docs/guides/images/image-generation and https://platform.openai.com/docs/guides/tools-image-generation
- shadcn project config: `components.json`; use the local `shadcn` skill and CLI for current component docs.
- Tailwind CSS v4 docs: https://tailwindcss.com/docs

## Maintenance Notes

- Keep this file pointer-heavy. Prefer stable concepts and file entry points over long directory dumps.
- If a rule becomes task-specific, move it to a narrower doc or skill and link to it here.
- If architecture changes, update this file in the same PR as the code.
