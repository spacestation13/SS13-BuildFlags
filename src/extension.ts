import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Shape of tools/build/build_flags.json. */
interface Flag {
	id: string;
	define: string;
	label: string;
	category: string;
	description?: string;
	requires?: string[];
	conflictsWith?: string[];
}
interface Preset {
	id: string;
	label: string;
	flags: string[];
}
interface FlagsFile {
	categories?: string[];
	flags: Flag[];
	presets: Preset[];
}

const STATE_KEY = 'tgBuildFlags.selected';
const VIEW_ID = 'tgBuildFlags.view';

let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
	statusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		50,
	);
	statusBar.command = `${VIEW_ID}.focus`;
	context.subscriptions.push(statusBar);

	const provider = new BuildFlagsViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		// Opens the Run and Debug panel and focuses our view within it.
		vscode.commands.registerCommand('tgBuildFlags.pick', () =>
			vscode.commands.executeCommand(`${VIEW_ID}.focus`),
		),
		// Consumed by tasks as ${command:tgBuildFlags.current} -> "-DA -DB".
		vscode.commands.registerCommand('tgBuildFlags.current', () =>
			currentDefines(context),
		),
		vscode.commands.registerCommand('tgBuildFlags.clear', () => {
			setSelected(context, []);
			provider.refresh();
		}),
		vscode.debug.registerDebugConfigurationProvider('byond', {
			async resolveDebugConfiguration(_folder, config) {
				const baseTaskName = getBaseTaskName();
				if (!baseTaskName || getSelected(context).length === 0) {
					return config;
				}
				if (config.preLaunchTask !== baseTaskName) {
					return config;
				}
				const tasks = await vscode.tasks.fetchTasks();
				const baseTask = tasks.find((t) => t.name === baseTaskName);
				if (!baseTask) {
					vscode.window.showWarningMessage(
						`TG Build Flags: could not find task "${baseTaskName}"`,
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
		.getConfiguration('tgBuildFlags')
		.get<string>('baseTask');
}

function cloneTaskWithFlags(
	baseTask: vscode.Task,
	context: vscode.ExtensionContext,
): vscode.Task | undefined {
	const data = loadFlags();
	const byId = new Map(data?.flags.map((f) => [f.id, f]) ?? []);
	const defines = getSelected(context)
		.map((id) => byId.get(id)?.define)
		.filter((d): d is string => Boolean(d))
		.map((d) => `-D${d}`);

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
		.getConfiguration('tgBuildFlags')
		.get<string>('configPath', 'tools/build/build_flags.json');
	return path.join(root, rel);
}

function loadFlags(): FlagsFile | undefined {
	const file = flagsFilePath();
	if (!file || !fs.existsSync(file)) {
		return undefined;
	}
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as FlagsFile;
	} catch (err) {
		vscode.window.showErrorMessage(`TG Build Flags: failed to parse ${file}: ${err}`);
		return undefined;
	}
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

function currentDefines(context: vscode.ExtensionContext): string {
	const data = loadFlags();
	if (!data) {
		return '';
	}
	const byId = new Map(data.flags.map((f) => [f.id, f]));
	return getSelected(context)
		.map((id) => byId.get(id)?.define)
		.filter((d): d is string => Boolean(d))
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
	if (ids.length === 0) {
		statusBar.text = '$(flame) Flags: none';
	} else {
		const first = byId.get(ids[0])?.label ?? ids[0];
		statusBar.text =
			ids.length === 1
				? `$(flame) ${first}`
				: `$(flame) ${first} +${ids.length - 1}`;
	}
	statusBar.tooltip = ids.length
		? `Build flags: ${ids.map((id) => byId.get(id)?.define ?? id).join(', ')}\nClick to open the Build Flags view`
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
			}
		});
		webviewView.webview.html = getHtml(webviewView.webview);
		this.postInit();
	}

	refresh(): void {
		this.postInit();
	}

	private postInit(): void {
		if (!this.view) {
			return;
		}
		const data = loadFlags();
		if (!data) {
			this.view.webview.html = getMissingConfigHtml();
			return;
		}
		this.view.webview.postMessage({
			type: 'init',
			data,
			selected: getSelected(this.context),
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
	<p>Set <code>tgBuildFlags.configPath</code> if it lives elsewhere in the workspace.</p>
	</body></html>`;
}

///lol yeah I should split this up
const WEBVIEW_STYLE = `
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		padding: 4px 8px 12px;
		color: var(--vscode-foreground);
	}
	.toolbar {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 10px;
		position: sticky;
		top: 0;
		background: var(--vscode-sideBar-background);
		padding: 6px 0;
		z-index: 1;
	}
	select, button {
		font-family: inherit;
		font-size: inherit;
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		border: none;
		padding: 3px 8px;
		border-radius: 3px;
		cursor: pointer;
	}
	select {
		color: var(--vscode-dropdown-foreground);
		background: var(--vscode-dropdown-background);
		border: 1px solid var(--vscode-dropdown-border);
		flex: 1;
		min-width: 0;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary {
		color: var(--vscode-button-secondaryForeground);
		background: var(--vscode-button-secondaryBackground);
	}
	.category { margin-bottom: 10px; }
	.category h2 {
		font-size: 0.8em;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		opacity: 0.7;
		margin: 0 0 4px;
		border-bottom: 1px solid var(--vscode-panel-border);
		padding-bottom: 2px;
	}
	label.flag {
		display: flex;
		gap: 6px;
		align-items: flex-start;
		padding: 3px 0;
		cursor: pointer;
	}
	label.flag input { margin-top: 3px; flex-shrink: 0; }
	.flag .meta { display: flex; flex-direction: column; min-width: 0; }
	.flag .name { font-weight: 600; }
	.flag .desc { opacity: 0.7; font-size: 0.9em; }
	.warn {
		color: var(--vscode-editorWarning-foreground);
		font-size: 0.85em;
		margin: 2px 0 0 22px;
	}
	.count { opacity: 0.7; font-size: 0.85em; margin-top: 6px; }
`;



///but hey this works
const WEBVIEW_SCRIPT =  `
const vscode = acquireVsCodeApi();
let DATA = { flags: [], presets: [], categories: [] };
let selected = new Set();

window.addEventListener('message', (e) => {
	const msg = e.data;
	if (msg.type === 'init') {
		DATA = msg.data;
		selected = new Set(msg.selected || []);
		renderPresets();
		render();
	}
});

function byId(id) {
	return DATA.flags.find(f => f.id === id);
}

function renderPresets() {
	const sel = document.getElementById('preset');
	sel.querySelectorAll('option:not([value=""])').forEach(o => o.remove());
	for (const p of DATA.presets) {
		const opt = document.createElement('option');
		opt.value = p.id;
		opt.textContent = p.label;
		sel.appendChild(opt);
	}
	sel.addEventListener('change', () => {
		const p = DATA.presets.find(x => x.id === sel.value);
		if (p) {
			selected = new Set(p.flags);
			render();
			save();
		}
	});
}

function save() {
	vscode.postMessage({ type: 'select', flags: [...selected] });
}

function toggle(id, on) {
	if (on) {
		selected.add(id);
		for (const req of (byId(id).requires || [])) {
			selected.add(req);
		}
	} else {
		selected.delete(id);
		// Drop anything that required this flag.
		for (const f of DATA.flags) {
			if ((f.requires || []).includes(id)) {
				selected.delete(f.id);
			}
		}
	}
	syncPresetDropdown();
	render();
	save();
}

function syncPresetDropdown() {
	const sel = document.getElementById('preset');
	const match = DATA.presets.find(p =>
		p.flags.length === selected.size && p.flags.every(f => selected.has(f)));
	sel.value = match ? match.id : '';
}

function render() {
	const container = document.getElementById('categories');
	container.innerHTML = '';
	const cats = DATA.categories && DATA.categories.length
		? DATA.categories
		: [...new Set(DATA.flags.map(f => f.category))];
	for (const cat of cats) {
		const flags = DATA.flags.filter(f => f.category === cat);
		if (!flags.length) {
			continue;
		}
		const div = document.createElement('div');
		div.className = 'category';
		const h2 = document.createElement('h2');
		h2.textContent = cat;
		div.appendChild(h2);
		for (const f of flags) {
			const label = document.createElement('label');
			label.className = 'flag';
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = selected.has(f.id);
			cb.addEventListener('change', () => toggle(f.id, cb.checked));
			const meta = document.createElement('div');
			meta.className = 'meta';
			const name = document.createElement('span');
			name.className = 'name';
			name.textContent = f.label + '  (-D' + f.define + ')';
			meta.appendChild(name);
			if (f.description) {
				const d = document.createElement('span');
				d.className = 'desc';
				d.textContent = f.description;
				meta.appendChild(d);
			}
			label.appendChild(cb);
			label.appendChild(meta);
			div.appendChild(label);
			// Conflict warning.
			const conflicts = (f.conflictsWith || []).filter(c => selected.has(c) && selected.has(f.id));
			if (conflicts.length) {
				const w = document.createElement('div');
				w.className = 'warn';
				w.textContent = 'Conflicts with: ' + conflicts.map(c => (byId(c) || {}).label || c).join(', ');
				div.appendChild(w);
			}
		}
		container.appendChild(div);
	}
	document.getElementById('count').textContent =
		selected.size + ' flag' + (selected.size === 1 ? '' : 's') + ' selected';
	syncPresetDropdown();
}

document.getElementById('clear').addEventListener('click', () => {
	selected = new Set();
	render();
	save();
});

vscode.postMessage({ type: 'ready' });
`;

function getHtml(webview: vscode.Webview): string {
	const nonce = getNonce();
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>${WEBVIEW_STYLE}</style>
</head>
<body>
	<div class="toolbar">
		<select id="preset"><option value="">Custom</option></select>
		<button class="secondary" id="clear" title="Clear all flags">Clear</button>
	</div>
	<div id="categories"></div>
	<div class="count" id="count"></div>
	<script nonce="${nonce}">${WEBVIEW_SCRIPT}</script>
</body>
</html>`;
}
