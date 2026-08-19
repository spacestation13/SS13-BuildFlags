import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseJsonc } from './jsonc';

/** Shape of tools/build/build_flags.json or build_flags.jsonc. */
interface FlagOption {
	value: string;
	label: string;
	/** Flag ids that get auto-selected (and can't be unselected while this option is active). */
	requires?: string[];
}
interface Flag {
	id: string;
	define: string;
	label: string;
	category: string;
	description?: string;
	requires?: string[];
	conflictsWith?: string[];
	/** For boolean flags: select flag ids this flag forces to a specific value when turned on, keyed by select flag id. */
	requiresValues?: Record<string, string>;
	/** 'boolean' (default) is a plain -D/#define toggle. 'select' carries a value from a dropdown. 'text' carries a free-typed value. */
	type?: 'boolean' | 'select' | 'text';
	/** Required when type is 'select'. First option's value should usually be '' (unset). */
	options?: FlagOption[];
	/** For 'select'/'text' flags: 'quoted' emits define="value" (e.g. a DM string literal define). */
	valueFormat?: 'raw' | 'quoted';
	/** For 'select' flags: when true, an option's value IS the whole -D/#define token (e.g. a full macro name like MAP_OVERRIDE_DEVTEST) instead of a value assigned to `define`. `define` is then unused for token generation. */
	valueIsDefine?: boolean;
	/** For 'text' flags: value used when the flag is enabled but the field is left empty. Also shown as the input placeholder. */
	default?: string;
}
interface Preset {
	id: string;
	label: string;
	flags: string[];
	/** Values for select flags this preset should set, keyed by flag id. */
	values?: Record<string, string>;
}
interface FlagsFile {
	categories?: string[];
	flags: Flag[];
	presets: Preset[];
}

const STATE_KEY = 'ss13BuildFlags.selected';
const STATE_KEY_VALUES = 'ss13BuildFlags.values';
/** For 'text' flags: whether the typed value is currently active, independent of the text itself. */
const STATE_KEY_ENABLED = 'ss13BuildFlags.enabled';
const VIEW_ID = 'ss13BuildFlags.view';

let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
	statusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		50,
	);
	statusBar.command = `${VIEW_ID}.focus`;
	context.subscriptions.push(statusBar);

	ensureDefineDocWatcher(context);

	const provider = new BuildFlagsViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		// Opens the Run and Debug panel and focuses our view within it.
		vscode.commands.registerCommand('ss13BuildFlags.pick', () =>
			vscode.commands.executeCommand(`${VIEW_ID}.focus`),
		),
		// Consumed by tasks as ${command:ss13BuildFlags.current} -> "-DA -DB".
		vscode.commands.registerCommand('ss13BuildFlags.current', () =>
			currentDefines(context),
		),
		vscode.commands.registerCommand('ss13BuildFlags.clear', () => {
			setSelected(context, []);
			setValues(context, {});
			const data = loadFlags();
			const allDisabled: Record<string, boolean> = {};
			for (const f of data?.flags.filter((f) => f.type === 'text') ?? []) {
				allDisabled[f.id] = false;
			}
			setEnabled(context, allDisabled);
			provider.refresh();
		}),
		vscode.debug.registerDebugConfigurationProvider('byond', {
			async resolveDebugConfiguration(_folder, config) {
				const baseTaskName = getBaseTaskName();
				if (!baseTaskName || config.preLaunchTask !== baseTaskName) {
					return config;
				}
				const mode = getInjectionMode();

				if (mode === 'write-file') {
					// Always write (even when nothing is selected) so a
					// previous run's defines get cleared, not left stale.
					writeLocalDefines(context);
					const exitCode = await runTaskByName(baseTaskName);
					if (exitCode === undefined) {
						return config;
					}
					if (exitCode !== 0) {
						return undefined;
					}
					config.preLaunchTask = undefined;
					return config;
				}

				// cli-args mode
				const hasValues = Object.values(getValues(context)).some((v) => v !== '');
				if (getSelected(context).length === 0 && !hasValues) {
					return config;
				}
				const tasks = await vscode.tasks.fetchTasks();
				const baseTask = tasks.find((t) => t.name === baseTaskName);
				if (!baseTask) {
					vscode.window.showWarningMessage(
						`SS13 Build Flags: could not find task "${baseTaskName}"`,
					);
					return config;
				}
				const flaggedTask = cloneTaskWithFlags(baseTask, context);
				if (!flaggedTask) {
					return config;
				}
				const execution = await vscode.tasks.executeTask(flaggedTask);
				const exitCode = await waitForTask(execution);
				if (exitCode !== 0) {
					return undefined;
				}
				config.preLaunchTask = undefined;
				return config;
			},
		}),
	);

	updateStatusBar(context);
}

export function deactivate() { }

function getBaseTaskName(): string | undefined {
	return vscode.workspace
		.getConfiguration('ss13BuildFlags')
		.get<string>('baseTask');
}

function getInjectionMode(): 'cli-args' | 'write-file' {
	return vscode.workspace
		.getConfiguration('ss13BuildFlags')
		.get<'cli-args' | 'write-file'>('injectionMode', 'cli-args');
}

/** Finds baseTaskName via fetchTasks, runs it unmodified, and awaits its exit code. */
async function runTaskByName(baseTaskName: string): Promise<number | undefined> {
	const tasks = await vscode.tasks.fetchTasks();
	const baseTask = tasks.find((t) => t.name === baseTaskName);
	if (!baseTask) {
		vscode.window.showWarningMessage(
			`SS13 Build Flags: could not find task "${baseTaskName}"`,
		);
		return undefined;
	}
	const execution = await vscode.tasks.executeTask(baseTask);
	return waitForTask(execution);
}

/** 'select' and 'text' flags carry a typed-in-JSON value instead of being plain on/off toggles. */
function isValueFlag(f: Flag): boolean {
	return f.type === 'select' || f.type === 'text';
}

/**
 * Values for select/text flags that are actually in effect: non-empty, and
 * (for 'text' flags) not unchecked via their enable checkbox. The typed text
 * for a disabled 'text' flag is kept in workspaceState so re-checking it
 * doesn't require retyping, but it's excluded here.
 */
function activeValues(context: vscode.ExtensionContext): Record<string, string> {
	const data = loadFlags();
	const values = getValues(context);
	const enabled = getEnabled(context);
	const result: Record<string, string> = {};
	for (const f of data?.flags ?? []) {
		if (!isValueFlag(f)) {
			continue;
		}
		if (f.type === 'text' && enabled[f.id] === false) {
			continue;
		}
		const value = values[f.id] || (f.type === 'text' ? f.default : undefined);
		if (!value) {
			continue;
		}
		result[f.id] = value;
	}
	return result;
}

/** Builds the raw define tokens (without the -D/#define prefix) for all active flags. */
function activeDefineTokens(context: vscode.ExtensionContext): string[] {
	const data = loadFlags();
	const byId = new Map(data?.flags.map((f) => [f.id, f]) ?? []);
	const tokens: string[] = [];

	for (const id of getSelected(context)) {
		const f = byId.get(id);
		if (f && !isValueFlag(f)) {
			tokens.push(f.define);
		}
	}

	for (const [id, value] of Object.entries(activeValues(context))) {
		const f = byId.get(id);
		if (!f) {
			continue;
		}
		if (f.valueIsDefine) {
			tokens.push(value);
			continue;
		}
		tokens.push(f.valueFormat === 'quoted' ? `${f.define}="${value}"` : `${f.define}=${value}`);
	}

	return tokens;
}

function cloneTaskWithFlags(
	baseTask: vscode.Task,
	context: vscode.ExtensionContext,
): vscode.Task | undefined {
	const defines = activeDefineTokens(context).map((d) => `-D${d}`);

	if (defines.length === 0) {
		return undefined;
	}

	const exec = baseTask.execution;
	let newExec: vscode.ShellExecution | vscode.ProcessExecution;

	if (exec instanceof vscode.ShellExecution) {
		if (exec.commandLine) {
			newExec = new vscode.ShellExecution(
				`${exec.commandLine} ${defines.join(' ')}`,
				exec.options,
			);
		} else if (exec.command) {
			const args = [...(exec.args ?? []), ...defines];
			newExec = new vscode.ShellExecution(exec.command, args, exec.options);
		} else {
			return undefined;
		}
	} else if (exec instanceof vscode.ProcessExecution) {
		const args = [...exec.args, ...defines];
		newExec = new vscode.ProcessExecution(exec.process, args, exec.options);
	} else {
		return undefined;
	}

	const task = new vscode.Task(
		baseTask.definition,
		baseTask.scope ?? vscode.TaskScope.Workspace,
		`${baseTask.name} (flagged)`,
		baseTask.source,
		newExec,
		baseTask.problemMatchers,
	);
	task.group = baseTask.group;
	task.presentationOptions = baseTask.presentationOptions;
	return task;
}

function waitForTask(execution: vscode.TaskExecution): Promise<number | undefined> {
	return new Promise((resolve) => {
		const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
			if (e.execution === execution) {
				disposable.dispose();
				resolve(e.exitCode);
			}
		});
	});
}

///Load some configs babyyy

function workspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function flagsFilePath(): string | undefined {
	const root = workspaceRoot();
	if (!root) {
		return undefined;
	}
	const rel = vscode.workspace
		.getConfiguration('ss13BuildFlags')
		.get<string>('configPath', 'tools/build/build_flags.json');
	return path.join(root, rel);
}

function localDefinesFilePath(): string | undefined {
	const root = workspaceRoot();
	const rel = vscode.workspace
		.getConfiguration('ss13BuildFlags')
		.get<string>('localDefinesPath');
	if (!root || !rel) {
		return undefined;
	}
	return path.join(root, rel);
}

/** Opens a workspace-relative file path referenced in a flag's description, optionally jumping to a line. */
async function openWorkspaceFile(rel: string, line?: number): Promise<void> {
	const root = workspaceRoot();
	if (!root || typeof rel !== 'string') {
		return;
	}
	const full = path.join(root, rel);
	if (!fs.existsSync(full)) {
		vscode.window.showWarningMessage(`SS13 Build Flags: could not find file "${rel}"`);
		return;
	}
	const options: vscode.TextDocumentShowOptions | undefined = line
		? { selection: new vscode.Range(line - 1, 0, line - 1, 0) }
		: undefined;
	await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full), options);
}

function loadFlags(): FlagsFile | undefined {
	const file = flagsFilePath();
	if (!file || !fs.existsSync(file)) {
		return undefined;
	}
	try {
		return parseJsonc<FlagsFile>(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		vscode.window.showErrorMessage(`SS13 Build Flags: failed to parse ${file}: ${err}`);
		return undefined;
	}
}

// Auto-desc: fall back to a flag's ///-doc-comment above its #define in DM source.
const DEFINE_DOC_RE = /((?:^[ \t]*\/\/\/.*\n)+)^[ \t]*(?:\/\/[ \t]*)?#define[ \t]+(\w+)/gm;

let defineDocCache: Map<string, string> | undefined;
let defineDocWatcher: vscode.FileSystemWatcher | undefined;

/** Workspace-relative path to the single DM file scanned for /// doc comments, or undefined when unset. */
function definesDocFilePath(): string | undefined {
	const root = workspaceRoot();
	const rel = vscode.workspace
		.getConfiguration('ss13BuildFlags')
		.get<string>('definesDocPath');
	if (!root || !rel) {
		return undefined;
	}
	return path.join(root, rel);
}

/** Scans the configured DM file once and maps #define name -> its /// doc comment */
function buildDefineDocMap(): Map<string, string> {
	const map = new Map<string, string>();
	const file = definesDocFilePath();
	if (!file) {
		return map;
	}
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return map;
	}
	DEFINE_DOC_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = DEFINE_DOC_RE.exec(text))) {
		const name = m[2];
		if (map.has(name)) {
			continue;
		}
		const doc = m[1]
			.split('\n')
			.map((l) => l.replace(/^[ \t]*\/\/\/ ?/, '').trimEnd())
			.filter((l) => l.length > 0)
			.join(' ');
		if (doc) {
			map.set(name, doc);
		}
	}
	return map;
}

function getDefineDocMap(): Map<string, string> {
	if (!defineDocCache) {
		defineDocCache = buildDefineDocMap();
	}
	return defineDocCache;
}

/** Rebuilds the doc map next time it's needed, e.g. after the configured DM file is edited. */
function ensureDefineDocWatcher(context: vscode.ExtensionContext): void {
	if (defineDocWatcher) {
		return;
	}
	const file = definesDocFilePath();
	if (!file) {
		return;
	}
	defineDocWatcher = vscode.workspace.createFileSystemWatcher(file);
	const invalidate = () => { defineDocCache = undefined; };
	context.subscriptions.push(
		defineDocWatcher,
		defineDocWatcher.onDidChange(invalidate),
		defineDocWatcher.onDidCreate(invalidate),
		defineDocWatcher.onDidDelete(invalidate),
	);
}

/** Extracts the bare macro name from a define token, dropping any assigned value (e.g. `NAME=1` -> `NAME`). */
function defineMacroName(define: string): string {
	return define.trim().split(/[=\s]/, 1)[0];
}

/** Fills in flag.description from the DM source's doc comment where the flags file left it blank. */
async function withAutoDescriptions(data: FlagsFile): Promise<FlagsFile> {
	if (!data.flags.some((f) => !f.description && f.define)) {
		return data;
	}
	const docs = getDefineDocMap();
	return {
		...data,
		flags: data.flags.map((f) =>
			f.description || !f.define
				? f
				: { ...f, description: docs.get(defineMacroName(f.define)) ?? f.description },
		),
	};
}

// Get selected state

function getSelected(context: vscode.ExtensionContext): string[] {
	return context.workspaceState.get<string[]>(STATE_KEY, []);
}

function setSelected(context: vscode.ExtensionContext, ids: string[]) {
	// Keep only ids that still exist in the flags file, preserving file order.
	const data = loadFlags();
	const known = new Set(data?.flags.map((f) => f.id));
	const cleaned = data
		? data.flags.filter((f) => ids.includes(f.id)).map((f) => f.id)
		: ids.filter((id) => known.has(id));
	context.workspaceState.update(STATE_KEY, cleaned);
	updateStatusBar(context);
}

function getValues(context: vscode.ExtensionContext): Record<string, string> {
	return context.workspaceState.get<Record<string, string>>(STATE_KEY_VALUES, {});
}

function setValues(context: vscode.ExtensionContext, values: Record<string, string>) {
	// Keep only ids that still exist as select/text flags in the flags file.
	const data = loadFlags();
	const known = new Set(data?.flags.filter(isValueFlag).map((f) => f.id));
	const cleaned: Record<string, string> = {};
	for (const [id, value] of Object.entries(values)) {
		if (known.has(id)) {
			cleaned[id] = value;
		}
	}
	context.workspaceState.update(STATE_KEY_VALUES, cleaned);
	updateStatusBar(context);
}

function getEnabled(context: vscode.ExtensionContext): Record<string, boolean> {
	return context.workspaceState.get<Record<string, boolean>>(STATE_KEY_ENABLED, {});
}

function setEnabled(context: vscode.ExtensionContext, enabled: Record<string, boolean>) {
	// Keep only ids that still exist as 'text' flags in the flags file.
	const data = loadFlags();
	const known = new Set(data?.flags.filter((f) => f.type === 'text').map((f) => f.id));
	const cleaned: Record<string, boolean> = {};
	for (const [id, value] of Object.entries(enabled)) {
		if (known.has(id)) {
			cleaned[id] = value;
		}
	}
	context.workspaceState.update(STATE_KEY_ENABLED, cleaned);
	updateStatusBar(context);
}

/** Overwrites localDefinesPath with #defines for the currently active flags (write-file mode). */
function writeLocalDefines(context: vscode.ExtensionContext): void {
	const file = localDefinesFilePath();
	if (!file) {
		return;
	}
	const defineLines = activeDefineTokens(context).map((d) => `#define ${d}`);

	fs.writeFileSync(file, defineLines.length ? `${defineLines.join('\n')}\n` : '');
}

function currentDefines(context: vscode.ExtensionContext): string {
	return activeDefineTokens(context)
		.map((d) => `-D${d}`)
		.join(' ');
}

function updateStatusBar(context: vscode.ExtensionContext) {
	if (!flagsFilePath() || !fs.existsSync(flagsFilePath()!)) {
		statusBar.hide();
		return;
	}
	const data = loadFlags();
	const byId = new Map(data?.flags.map((f) => [f.id, f]) ?? []);
	const ids = getSelected(context);
	const values = activeValues(context);
	const valueLabels = Object.entries(values)
		.map(([id, v]) => {
			const f = byId.get(id);
			const option = f?.options?.find((o) => o.value === v);
			return `${f?.label ?? id}: ${option?.label ?? v}`;
		});
	const names = [
		...ids.map((id) => byId.get(id)?.label ?? id),
		...valueLabels,
	];
	if (names.length === 0) {
		statusBar.text = '$(flame) Flags: none';
	} else {
		statusBar.text =
			names.length === 1
				? `$(flame) ${names[0]}`
				: `$(flame) ${names[0]} +${names.length - 1}`;
	}
	const tokens = [
		...ids.map((id) => byId.get(id)?.define ?? id),
		...Object.entries(values).map(([id, v]) => {
			const f = byId.get(id);
			return f?.valueIsDefine ? v : `${f?.define ?? id}=${v}`;
		}),
	];
	statusBar.tooltip = tokens.length
		? `Build flags: ${tokens.join(', ')}\nClick to open the Build Flags view`
		: 'No build flags selected. Click to open the Build Flags view';
	statusBar.show();
}

class BuildFlagsViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.onDidDispose(() => {
			this.view = undefined;
		});
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.postInit();
			}
		});
		webviewView.webview.onDidReceiveMessage((msg) => {
			if (msg?.type === 'ready') {
				this.postInit();
			} else if (msg?.type === 'select') {
				// Autosaves on every toggle/preset pick
				setSelected(this.context, msg.flags ?? []);
				setValues(this.context, msg.values ?? {});
				setEnabled(this.context, msg.enabled ?? {});
			} else if (msg?.type === 'openFile') {
				openWorkspaceFile(msg.path, msg.line);
			}
		});
		webviewView.webview.html = getHtml(webviewView.webview, this.context.extensionUri);
		this.postInit();
	}

	refresh(): void {
		this.postInit();
	}

	private async postInit(): Promise<void> {
		if (!this.view) {
			return;
		}
		const data = loadFlags();
		if (!data) {
			this.view.webview.html = getMissingConfigHtml();
			return;
		}
		const resolved = await withAutoDescriptions(data);
		if (!this.view) {
			return;
		}
		this.view.webview.postMessage({
			type: 'init',
			data: resolved,
			selected: getSelected(this.context),
			values: getValues(this.context),
			enabled: getEnabled(this.context),
		});
	}
}

function getNonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function getMissingConfigHtml(): string {
	const file = flagsFilePath() ?? 'build_flags.json';
	return /* html */ `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground);">
	<p>Could not find <code>${file}</code>.</p>
	<p>Set <code>ss13BuildFlags.configPath</code> if it lives elsewhere in the workspace.</p>
	</body></html>`;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'webview.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'webview.js'));
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource}`,
		`script-src ${webview.cspSource} 'nonce-${nonce}'`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div class="toolbar">
		<select id="preset"><option value="">Custom</option></select>
		<button class="secondary" id="clear" title="Clear all flags">Clear</button>
	</div>
	<div id="categories"></div>
	<div class="count" id="count"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
