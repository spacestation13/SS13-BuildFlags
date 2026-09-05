# SS13 Build Flags

A VS Code extension to add a checkbox picker for build/debug flags. The flag list and presets are read from the game repo's flags JSON file (`ss13BuildFlags.configPath`, default `tools/build/build_flags.json`), so contributors edit flags there and this extension picks them up.

## What it does

- **A view inside the Run and Debug side panel** (same container as the launch
  config dropdown/breakpoints), not a separate tab: checkboxes grouped by
  category, each showing its define and description.
- **Preset dropdown** at the top of the view: picking a preset instantly
  checks exactly that preset's boxes. Toggling boxes by hand flips the
  dropdown back to "Custom".
- **Dependencies**: checking a flag auto-checks its `requires`;
  unchecking a requirement drops dependents; `conflictsWith` shows a warning.
- **Injection on F5**: when the resolved launch config's `preLaunchTask`
  matches `ss13BuildFlags.baseTask`, the extension injects the selected flags
  and runs that task itself before launching the debugger, via one of two
  modes (`ss13BuildFlags.injectionMode`):
  - `cli-args` (default): clones the base task with `-D${define}` appended to
    its command/args — matches DreamMaker's own CLI define syntax.
  - `write-file`: writes the selected `#define`s into
    `ss13BuildFlags.localDefinesPath`, then runs the base task unmodified.

## Settings

- `ss13BuildFlags.configPath` — workspace-relative path to the flags JSON.
- `ss13BuildFlags.baseTask` — exact task name/label to inject flags into.
- `ss13BuildFlags.localDefinesPath` — workspace-relative path for `write-file` mode.
- `ss13BuildFlags.definesDocPath` — workspace-relative DM file for automatic `///` descriptions, `//#region Category` categories. Close regions with `//#endregion`.

## Build / run locally

```sh
npm install
npm run compile
```

Then press **F5** in this folder to launch an Extension Development Host, open
the target game repo inside it, and open the **Run and Debug** panel. There
should be a section for the flags.

## Publish to VS Code Marketplace

This repo includes a GitHub Actions workflow that publishes to the VS Code Marketplace.

### One-time setup

1. Create a Personal Access Token in the Visual Studio Marketplace publisher
  portal with publish rights for your publisher.
2. In your GitHub repo settings, add it as an actions secret named
  `VSCE_PAT`.

### Release flow

1. Bump `version` in `package.json` and push that.
2. Create and push a tag like `v1.0.1`:

Pushing a `v*` tag triggers publish automatically. You can also run the
workflow manually from the Actions tab.
