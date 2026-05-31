'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const serverDir = path.join(rootDir, 'packages', 'server');
const coreSrcDir = path.join(rootDir, 'packages', 'core');
const coreDestDir = path.join(serverDir, 'node_modules', '@apilix', 'core');

function run(command, options = {}) {
	cp.execSync(command, {
		stdio: 'inherit',
		cwd: rootDir,
		...options,
	});
}

function sanitizeSemver(value) {
	return String(value || '').replace(/^[^0-9]*/, '');
}

function main() {
	const rootPkg = require(path.join(rootDir, 'package.json'));
	const electronVersion = sanitizeSemver(rootPkg?.devDependencies?.electron);

	if (!electronVersion) {
		throw new Error('Cannot determine Electron version from root package.json');
	}

	// Remove existing node_modules to avoid stale workspace symlinks that
	// electron-builder may not follow correctly on Windows.
	const serverNodeModules = path.join(serverDir, 'node_modules');
	if (fs.existsSync(serverNodeModules)) {
		console.log('[dist:prepare:server] Removing existing server node_modules...');
		fs.rmSync(serverNodeModules, { recursive: true, force: true });
	}

	console.log('[dist:prepare:server] Installing server production dependencies...');
	run('npm install --prefix packages/server --omit=dev --install-links --no-workspaces');

	console.log('[dist:prepare:server] Auditing for vulnerabilities...');
	try {
		run('npm audit fix --prefix packages/server --no-workspaces');
	} catch (error) {
		console.warn('[dist:prepare:server] Warning: npm audit fix encountered an issue.');
		console.warn('[dist:prepare:server] Some vulnerabilities may remain. Check manually with: npm audit --prefix packages/server');
	}

	// Verify that critical dependencies were installed.
	const criticalDeps = ['express', 'cors', 'axios'];
	for (const dep of criticalDeps) {
		const depPath = path.join(serverNodeModules, dep);
		if (!fs.existsSync(depPath)) {
			throw new Error(
				`[dist:prepare:server] Critical dependency '${dep}' missing from packages/server/node_modules after install. ` +
				'Ensure npm >= 9 and that packages/server/package.json lists it as a dependency.'
			);
		}
	}

	console.log('[dist:prepare:server] Copying @apilix/core into packages/server/node_modules...');
	fs.mkdirSync(coreDestDir, { recursive: true });
	fs.cpSync(coreSrcDir, coreDestDir, {
		recursive: true,
		force: true,
		filter: (source) => path.basename(source) !== 'node_modules',
	});

	console.log('[dist:prepare:server] Installing @apilix/core production dependencies...');
	run('npm install --omit=dev', { cwd: coreDestDir });

	console.log(`[dist:prepare:server] Rebuilding better-sqlite3 for Electron ${electronVersion}...`);
	try {
		run(
			`npx --yes @electron/rebuild -f -w better-sqlite3 -v ${electronVersion} -m ${JSON.stringify(serverDir)}`
		);
	} catch (error) {
		console.warn('[dist:prepare:server] Warning: Failed to rebuild better-sqlite3 for Electron.');
		console.warn('[dist:prepare:server] SQLite connections may be unavailable in packaged builds.');
	}
}

main();
