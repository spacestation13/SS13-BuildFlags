# SS13 Build Flags

A VS Code extension to add a checkbox picker for build/debug flags, The flag list and presets are read from the game repo's `tools/build/build_flags.json`, so contributors edit flags there and this extension will pick them up.

## What it does

- **A view inside the Run and Debug side panel** (same container as the launch
  config dropdown/breakpoints), not a separate tab: checkboxes grouped by
  category, each showing its `-D` define and description.
- **Preset dropdown** at the top of the view: picking a preset instantly
  checks exactly that preset's boxes. Toggling boxes by hand flips the
  dropdown back to "Custom".
- **Dependencies**: checking a flag auto-checks its `requires`;
  unchecking a requirement drops dependents; `conflictsWith` shows a warning.
- **Dependency handling** Writes the selection to `.vscode/.buildflags` (one `-D` define per line) so
  it's readable outside the extension, and so the build can pick it up without
  depending on the extension being installed. (some people HATE extensions)

## Build / run locally

```sh
npm install
npm run compile
```

Then press **F5** in this folder to launch an Extension Development Host, open
the tgstation workspace inside it, and open the **Run and Debug** panel. There should be a section for the flags

## How it works in the game repo

The extension never talks to the build directly. It only writes
`.vscode/.buildflags` (gitignored). `tools/build/build.ts` reads that file
itself (see `getLocalFlagFileDefines()` in game repo) and folds its defines into the normal
`Build All` task.

- With the extension: check boxes / pick a preset -> `.buildflags` updates ->
  next build picks up those defines, on any launch config.

The hand-written/`generate_flag_configs`-generated preset build tasks and
launch configs in `.vscode/` are unaffected either way since they pass their own args.
