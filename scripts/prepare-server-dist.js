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

function parseCliArgs(argv) {
	const out = {};
	for (const arg of argv || []) {
		if (arg.startsWith('--platform=')) {
			out.platform = arg.slice('--platform='.length);
		} else if (arg.startsWith('--arch=')) {
			out.arch = arg.slice('--arch='.length);
		}
	}
	return out;
}

function normalizePlatform(value) {
	const v = String(value || '').toLowerCase();
	if (!v) return process.platform;
	if (v === 'win') return 'win32';
	if (v === 'windows') return 'win32';
	if (v === 'mac') return 'darwin';
	if (v === 'osx') return 'darwin';
	return v;
}

function normalizeArch(value) {
	const v = String(value || '').toLowerCase();
	if (!v) return process.arch;
	if (v === 'x86_64') return 'x64';
	if (v === 'amd64') return 'x64';
	if (v === 'aarch64') return 'arm64';
	return v;
}

function assertBuildTargetCompatibility(targetPlatform, targetArch) {
	if (targetPlatform !== process.platform || targetArch !== process.arch) {
		throw new Error(
			`[dist:prepare:server] Refusing to prepare server dependencies for ${targetPlatform}/${targetArch} on ` +
			`${process.platform}/${process.arch}. Native SQLite addon (better-sqlite3) must be installed/rebuilt on the target OS/arch. ` +
			'Build Windows installers on Windows runners and macOS installers on macOS runners.'
		);
	}
}

function shouldSkipAuditFix() {
	if (process.env.APILIX_SKIP_AUDIT_FIX === '1') return true;
	if (process.env.CI === 'true') return true;
	return false;
}

function main() {
	const cli = parseCliArgs(process.argv.slice(2));
	const rootPkg = require(path.join(rootDir, 'package.json'));
	const electronVersion = sanitizeSemver(rootPkg?.devDependencies?.electron);
	const targetPlatform = normalizePlatform(cli.platform || process.env.APILIX_TARGET_PLATFORM || process.env.npm_config_platform);
	const targetArch = normalizeArch(cli.arch || process.env.APILIX_TARGET_ARCH || process.env.npm_config_arch);
	const useCiInstallForServer = process.env.CI === 'true' && fs.existsSync(path.join(serverDir, 'package-lock.json'));

	if (!electronVersion) {
		throw new Error('Cannot determine Electron version from root package.json');
	}

	assertBuildTargetCompatibility(targetPlatform, targetArch);

	// Remove existing node_modules to avoid stale workspace symlinks that
	// electron-builder may not follow correctly on Windows.
	const serverNodeModules = path.join(serverDir, 'node_modules');
	if (fs.existsSync(serverNodeModules)) {
		console.log('[dist:prepare:server] Removing existing server node_modules...');
		fs.rmSync(serverNodeModules, { recursive: true, force: true });
	}

	console.log(`[dist:prepare:server] Installing server production dependencies for ${targetPlatform}/${targetArch}...`);
	run(
		useCiInstallForServer
			? 'npm ci --prefix packages/server --omit=dev --no-workspaces'
			: 'npm install --prefix packages/server --omit=dev --install-links --no-workspaces',
		{
			env: {
				...process.env,
				npm_config_platform: targetPlatform,
				npm_config_arch: targetArch,
			},
		}
	);

	if (shouldSkipAuditFix()) {
		console.log('[dist:prepare:server] Skipping npm audit fix (CI/APILIX_SKIP_AUDIT_FIX=1).');
	} else {
		console.log('[dist:prepare:server] Auditing for vulnerabilities...');
		try {
			run('npm audit fix --prefix packages/server --no-workspaces');
		} catch (error) {
			console.warn('[dist:prepare:server] Warning: npm audit fix encountered an issue.');
			console.warn('[dist:prepare:server] Some vulnerabilities may remain. Check manually with: npm audit --prefix packages/server');
		}
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

	console.log(`[dist:prepare:server] Rebuilding better-sqlite3 for Electron ${electronVersion} on ${targetPlatform}/${targetArch}...`);
	run(
		`npx --yes @electron/rebuild -f -w better-sqlite3 -v ${electronVersion} -m ${JSON.stringify(serverDir)}`,
		{
			env: {
				...process.env,
				npm_config_platform: targetPlatform,
				npm_config_arch: targetArch,
			},
		}
	);
}

main();
