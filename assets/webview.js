const vscode = acquireVsCodeApi();
let DATA = { flags: [], presets: [], categories: [] };
let selected = new Set();
let values = {};
/** For 'text' flags: id -> whether its typed value is active. Missing = enabled. */
let enabled = {};

function isTextEnabled(id) {
	return enabled[id] !== false;
}

window.addEventListener('message', (e) => {
	const msg = e.data;
	if (msg.type === 'init') {
		DATA = msg.data;
		selected = new Set(msg.selected || []);
		values = { ...(msg.values || {}) };
		enabled = { ...(msg.enabled || {}) };
		renderPresets();
		render();
	}
});

function byId(id) {
	return DATA.flags.find((f) => f.id === id);
}

// Matches workspace-relative file paths (forward- or backslash-separated, e.g. Windows-style),
// with an optional trailing :line (e.g. _std/types.dm:32).
const FILE_REF_RE = /((?:[\w-]+[\\/])*[\w.-]+\.(?:dm|dme|json|md|txt))(?::(\d+))?\b/g;

function renderDescription(container, text) {
	FILE_REF_RE.lastIndex = 0;
	let last = 0;
	let m;
	while ((m = FILE_REF_RE.exec(text))) {
		if (m.index > last) {
			container.appendChild(document.createTextNode(text.slice(last, m.index)));
		}
		const ref = m[0];
		const filePath = m[1];
		const line = m[2] ? parseInt(m[2], 10) : undefined;
		const a = document.createElement('a');
		a.className = 'file-ref';
		a.textContent = ref;
		a.title = 'Open ' + ref;
		a.href = '#';
		a.addEventListener('click', (e) => {
			e.preventDefault();
			vscode.postMessage({ type: 'openFile', path: filePath, line });
		});
		container.appendChild(a);
		last = m.index + m[0].length;
	}
	if (last < text.length) {
		container.appendChild(document.createTextNode(text.slice(last)));
	}
}

function renderPresets() {
	const sel = document.getElementById('preset');
	sel.querySelectorAll('option:not([value=""])').forEach((o) => o.remove());
	for (const p of DATA.presets) {
		const opt = document.createElement('option');
		opt.value = p.id;
		opt.textContent = p.label;
		sel.appendChild(opt);
	}
	sel.addEventListener('change', () => {
		const p = DATA.presets.find((x) => x.id === sel.value);
		if (p) {
			selected = new Set(p.flags);
			values = { ...(p.values || {}) };
			// A preset's explicit values should take effect, not stay hidden behind a stale checkbox.
			enabled = {};
			render();
			save();
		}
	});
}

function save() {
	vscode.postMessage({ type: 'select', flags: [...selected], values, enabled });
}

function setValue(id, value) {
	values[id] = value;
	const option = (byId(id).options || []).find((o) => o.value === value);
	for (const req of option?.requires || []) {
		selected.add(req);
	}
	// Deselect any boolean flag that requires a different value for this select.
	for (const f of DATA.flags) {
		const reqVal = (f.requiresValues || {})[id];
		if (reqVal !== undefined && reqVal !== value) {
			selected.delete(f.id);
		}
	}
	render();
	save();
}

function isActiveValue(id) {
	const f = byId(id);
	if (f && f.type === 'text' && !isTextEnabled(id)) {
		return false;
	}
	const v = values[id] || (f && f.type === 'text' ? f.default : undefined);
	return !!v;
}

function updateCount() {
	const activeValues = Object.keys(values).filter(isActiveValue).length;
	const count = selected.size + activeValues;
	document.getElementById('count').textContent =
		count + ' flag' + (count === 1 ? '' : 's') + ' selected';
}

function toggle(id, on) {
	if (on) {
		selected.add(id);
		for (const req of byId(id).requires || []) {
			selected.add(req);
		}
		for (const [selId, val] of Object.entries(byId(id).requiresValues || {})) {
			values[selId] = val;
			enabled[selId] = true;
		}
	} else {
		selected.delete(id);
		// Drop anything that required this flag.
		for (const f of DATA.flags) {
			if ((f.requires || []).includes(id)) {
				selected.delete(f.id);
			}
		}
		// Reset any select value whose active option required this flag.
		for (const f of DATA.flags) {
			const option = (f.options || []).find((o) => o.value === values[f.id]);
			if ((option?.requires || []).includes(id)) {
				values[f.id] = '';
			}
		}
	}
	syncPresetDropdown();
	render();
	save();
}

function syncPresetDropdown() {
	const sel = document.getElementById('preset');
	const match = DATA.presets.find((p) => {
		if (p.flags.length !== selected.size || !p.flags.every((f) => selected.has(f))) {
			return false;
		}
		const presetValues = p.values || {};
		const activeValueIds = Object.keys(values).filter(isActiveValue);
		if (activeValueIds.length !== Object.keys(presetValues).length) {
			return false;
		}
		return activeValueIds.every((id) => values[id] === presetValues[id]);
	});
	sel.value = match ? match.id : '';
}

function render() {
	const container = document.getElementById('categories');
	container.innerHTML = '';
	const cats = DATA.categories && DATA.categories.length
		? DATA.categories
		: [...new Set(DATA.flags.map((f) => f.category))];
	for (const cat of cats) {
		const flags = DATA.flags.filter((f) => f.category === cat);
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
			const meta = document.createElement('div');
			meta.className = 'meta';
			const name = document.createElement('span');
			name.className = 'name';

			if (f.type === 'select') {
				name.textContent = f.label;
				meta.appendChild(name);
				if (f.description) {
					const d = document.createElement('span');
					d.className = 'desc';
					renderDescription(d, f.description);
					meta.appendChild(d);
				}
				const sel = document.createElement('select');
				sel.className = 'value-select';
				for (const opt of f.options || []) {
					const o = document.createElement('option');
					o.value = opt.value;
					o.textContent = opt.label;
					sel.appendChild(o);
				}
				sel.value = values[f.id] || '';
				sel.addEventListener('change', () => setValue(f.id, sel.value));
				meta.appendChild(sel);
				label.appendChild(meta);
				div.appendChild(label);
				const activeOption = (f.options || []).find((o) => o.value === values[f.id]);
				const missingReqs = (activeOption?.requires || []).filter((r) => !selected.has(r));
				if (missingReqs.length) {
					const w = document.createElement('div');
					w.className = 'warn';
					w.textContent =
						'Requires: ' + missingReqs.map((r) => (byId(r) || {}).label || r).join(', ');
					div.appendChild(w);
				}
				continue;
			}

			if (f.type === 'text') {
				name.textContent = f.label;
				meta.appendChild(name);
				if (f.description) {
					const d = document.createElement('span');
					d.className = 'desc';
					renderDescription(d, f.description);
					meta.appendChild(d);
				}
				const input = document.createElement('input');
				input.type = 'text';
				input.className = 'value-input';
				input.placeholder = f.default || '';
				input.value = values[f.id] || '';
				input.disabled = !isTextEnabled(f.id);
				let saveTimer;
				input.addEventListener('input', () => {
					values[f.id] = input.value;
					updateCount();
					clearTimeout(saveTimer);
					saveTimer = setTimeout(() => {
						syncPresetDropdown();
						save();
					}, 400);
				});
				input.addEventListener('blur', () => {
					clearTimeout(saveTimer);
					syncPresetDropdown();
					save();
				});
				meta.appendChild(input);

				const cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.checked = isTextEnabled(f.id);
				cb.title = 'Enable/disable this value without clearing it';
				cb.addEventListener('change', () => {
					enabled[f.id] = cb.checked;
					input.disabled = !cb.checked;
					updateCount();
					syncPresetDropdown();
					save();
				});
				label.appendChild(cb);
				label.appendChild(meta);
				div.appendChild(label);
				continue;
			}

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = selected.has(f.id);
			cb.addEventListener('change', () => toggle(f.id, cb.checked));
			name.textContent = f.label;
			meta.appendChild(name);
			if (f.description) {
				const d = document.createElement('span');
				d.className = 'desc';
				renderDescription(d, f.description);
				meta.appendChild(d);
			}
			label.appendChild(cb);
			label.appendChild(meta);
			div.appendChild(label);
			// Conflict warning.
			const conflicts = (f.conflictsWith || []).filter(
				(c) => selected.has(c) && selected.has(f.id),
			);
			if (conflicts.length) {
				const w = document.createElement('div');
				w.className = 'warn';
				w.textContent =
					'Conflicts with: ' + conflicts.map((c) => (byId(c) || {}).label || c).join(', ');
				div.appendChild(w);
			}
		}
		container.appendChild(div);
	}
	updateCount();
	syncPresetDropdown();
}

document.getElementById('clear').addEventListener('click', () => {
	selected = new Set();
	values = {};
	enabled = {};
	for (const f of DATA.flags) {
		if (f.type === 'text') {
			enabled[f.id] = false;
		}
	}
	render();
	save();
});

vscode.postMessage({ type: 'ready' });
