<div align="center">
  <img src="./src/web/logo/logo-white.svg" alt="Imagex logo" width="88" height="88" />
  <h1>Imagex</h1>
  <p><strong>A local-first visual workspace for building repeatable AI image workflows.</strong></p>
  <p>
    Compose prompts, references, brand assets, edits, and generation steps on a canvas,
    then run only the outputs you need.
  </p>
</div>

# 

Imagex helps you turn scattered image-generation experiments into reusable workflows. Instead of keeping prompts, references, edits, and output variations in separate places, you arrange them visually, connect the pieces that belong together, preview image edits locally, and generate the final outputs you choose.

It is built for workflows where consistency matters: brand explorations, product mockups, visual campaigns, character or style studies, and any process where one generated image may feed the next step.


https://github.com/user-attachments/assets/1eb75c6d-c716-4d8e-aaa5-4fee26065e56



## Highlights

- **Visual canvas**: build image workflows with prompt, image, color, file, edit, and output nodes.
- **Selective runs**: run one output, multiple selected outputs, rerun connected inputs, or regenerate everything in order.
- **Reusable assets**: manage imported images, saved node snippets, and generated outputs in the project asset library.
- **Local previews**: crop, rotate, flip, blur, and color-balance images before sending them into generation.
- **Durable runs**: refreshes and restarts recover generation state instead of losing track of in-progress work.
- **Multi-workflow projects**: keep related experiments together and switch between workflows from the top bar.
- **Local-first storage**: projects, assets, auth, run metadata, and generated files stay on your machine.

## What You Can Build

- Brand logo explorations that feed into packaging or product-shot workflows.
- Product images using a logo, material references, background directions, and palette nodes.
- Visual systems where one generated concept becomes a reference for later outputs.
- Before/after image-edit chains that can be reused across multiple outputs.
- Prompt kits and reusable node snippets for repeated creative directions.

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm install -g imagex
```

### Run

```bash
imagex
```

On first run, Imagex prompts you to authenticate with OpenAI Codex / ChatGPT, then starts the local app and opens the web UI.

- Web UI: `http://127.0.0.1:3847`
- Data directory: `~/.imagex`

## Authentication

Authenticate manually:

```bash
imagex auth
```

Check status:

```bash
imagex status
imagex doctor
```

`imagex whoami` is also available as a status alias.

Log out:

```bash
imagex logout
```

## Development

For local development from source:

```bash
git clone https://github.com/shikhargen/imagex.git
cd imagex
npm install
npm run dev
```

This starts the local API and Vite dev UI:

- App: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3847`

| Script               | Description                                      |
| -------------------- | ------------------------------------------------ |
| `npm run dev`        | Start the local API and Vite dev server          |
| `npm run dev:web`    | Start only the Vite dev server                   |
| `npm run dev:daemon` | Start only the local API                         |
| `npm run check`      | Type-check with TypeScript                       |
| `npm run test:webgl` | Run the browser WebGL image-pipeline verifier    |
| `npm test`           | Run typecheck and the WebGL verifier             |
| `npm run build`      | Build TypeScript and the web UI                  |
| `npm start`          | Run the built app without opening a browser      |

For local generation testing without real image calls, run a compatible mock service separately and start Imagex with:

```bash
CODEX_API_BASE=http://127.0.0.1:8787/backend-api/codex/responses npm run dev
```

## How It Works

Imagex is a Vite/React web app backed by a local Express API. The editor stores project files locally, renders interactive image previews in the browser, and sends generation requests through the local API so run state can be saved and recovered.

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui, React Flow, Zustand.
- **Image previews**: raw WebGL for browser-side preview, export, and download paths.
- **Local API**: Node.js 20+, Express, ESM TypeScript.
- **Generation transport**: OpenAI Codex OAuth and Responses image tool support.

## Storage

By default Imagex stores local data in `~/.imagex`. Set `IMAGEX_HOME` to use a different root.

Imported images and reusable node snippets live under each project's `assets/` directory. Generated outputs are stored per project under:

```text
outputs/runs/index.json
outputs/runs/<job-id>/job.json
outputs/runs/<job-id>/<output-node-id>/
```

`outputs/runs/index.json` keeps the newest run records in chronological order.

## Project Structure

```text
src/
  auth/           # Codex OAuth storage and auth helpers
  cli/            # CLI commands
  config/         # Local path configuration
  daemon/         # Local API, generation jobs, file serving
  projects/       # Project persistence
  providers/      # Provider transports
  shared/         # Shared persisted types
  web/            # React frontend
    state/        # Flow store and graph engine
    ui/           # Editor shell, panels, nodes, components
  workflows/      # Compiler and workflow persistence
```

## Verification

Use the focused command for the area you changed:

```bash
npm run check
npm run test:webgl
npm run build
```

For UI behavior, run `npm run dev` and inspect the editor in the browser.

## License

MIT
