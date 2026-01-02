import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { createLogger } from "./logger";

const log = createLogger("utils.godot", { output: "Godot LSP" });

export function get_editor_data_dir(): string {
	// from: https://stackoverflow.com/a/26227660
	const appdata =
		process.env.APPDATA ||
		(process.platform === "darwin"
			? `${process.env.HOME}/Library/Preferences`
			: `${process.env.HOME}/.local/share`);

	return path.join(appdata, "Godot");
}

let projectDir: string | undefined = undefined;
let projectFile: string | undefined = undefined;

export async function get_project_dir(): Promise<string | undefined> {
	if (projectDir && projectFile) {
		return projectDir;
	}

	let file = "";
	if (vscode.workspace.workspaceFolders !== undefined) {
		const files = await vscode.workspace.findFiles("**/project.godot", null);

		if (files.length === 0) {
			return undefined;
		}
		if (files.length === 1) {
			file = files[0].fsPath;
			if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
				return undefined;
			}
		} else if (files.length > 1) {
			// if multiple project files, pick the top-most one
			const best = files.reduce((a, b) => (a.fsPath.length <= b.fsPath.length ? a : b));
			if (best) {
				file = best.fsPath;
				if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
					return undefined;
				}
			}
		}
	}
	projectFile = file;
	projectDir = path.dirname(file);
	if (os.platform() === "win32") {
		// capitalize the drive letter in windows absolute paths
		projectDir = projectDir[0].toUpperCase() + projectDir.slice(1);
	}
	return projectDir;
}

export async function get_project_file(): Promise<string | undefined> {
	if (projectDir === undefined || projectFile === undefined) {
		await get_project_dir();
	}
	return projectFile;
}

let projectVersion: string | undefined = undefined;

export async function get_project_version(): Promise<string | undefined> {
	if (projectVersion) {
		return projectVersion;
	}

	if (projectDir === undefined || projectFile === undefined) {
		await get_project_dir();
	}

	if (projectFile === undefined) {
		return undefined;
	}

	let godotVersion = "3.x";
	const document = await vscode.workspace.openTextDocument(projectFile);
	const text = document.getText();

	const match = text.match(/config\/features=PackedStringArray\((.*)\)/);
	if (match) {
		const line = match[0];
		const version = line.match(/\"(4.[0-9]+)\"/);
		if (version) {
			godotVersion = version[1];
		}
	}

	projectVersion = godotVersion;
	return projectVersion;
}

export function find_project_file(start: string, depth = 20) {
	// TODO: rename this, it's actually more like "find_parent_project_file"
	// This function appears to be fast enough, but if speed is ever an issue,
	// memoizing the result should be straightforward
	if (start === ".") {
		if (fs.existsSync("project.godot") && fs.statSync("project.godot").isFile()) {
			return "project.godot";
		}
		return null;
	}
	const folder = path.dirname(start);
	if (start === folder) {
		return null;
	}
	const projFile = path.join(folder, "project.godot");

	if (fs.existsSync(projFile) && fs.statSync(projFile).isFile()) {
		return projFile;
	}
	if (depth === 0) {
		return null;
	}
	return find_project_file(folder, depth - 1);
}

export async function convert_resource_path_to_uri(resPath: string): Promise<vscode.Uri | null> {
	const dir = await get_project_dir();
	return vscode.Uri.joinPath(vscode.Uri.file(dir), resPath.substring("res://".length));
}

export async function convert_uri_to_resource_path(uri: vscode.Uri): Promise<string | null> {
	const project_dir = path.dirname(find_project_file(uri.fsPath));
	if (project_dir === null) {
		return;
	}

	let relative_path = path.normalize(path.relative(project_dir, uri.fsPath));
	relative_path = relative_path.split(path.sep).join(path.posix.sep);
	return `res://${relative_path}`;
}

const uidCache: Map<string, vscode.Uri | null> = new Map();

export async function convert_uids_to_uris(uids: string[]): Promise<Map<string, vscode.Uri>> {
	const not_found_uids: string[] = [];
	const uris: Map<string, vscode.Uri> = new Map();

	log.info(`[UID] Resolving UIDs: ${uids.join(", ")}`);

	let found_all = true;
	for (const uid of uids) {
		if (!uid.startsWith("uid://")) {
			continue;
		}

		if (uidCache.has(uid)) {
			const uri = uidCache.get(uid);
			if (fs.existsSync(uri.fsPath)) {
				uris.set(uid, uri);
				log.info(`[UID] Cache hit: ${uid} -> ${uri.fsPath}`);
				continue;
			}

			uidCache.delete(uid);
		}

		found_all = false;
		not_found_uids.push(uid);
	}

	if (found_all) {
		return uris;
	}

	log.info(`[UID] Not found in cache, searching files for: ${not_found_uids.join(", ")}`);

	const startTime = Date.now();

	// Search .uid files (scripts, shaders, scenes, resources)
	// Use direct fs reads instead of vscode.openTextDocument for performance
	const uidFiles = await vscode.workspace.findFiles("**/*.uid", null);

	for (const file of uidFiles) {
		try {
			// .uid files are tiny (<50 bytes), direct read is much faster
			const text = fs.readFileSync(file.fsPath, "utf-8").trim();
			const match = text.match(/uid:\/\/([0-9a-zA-Z]*)/);
			if (!match) {
				continue;
			}

			const file_path = file.fsPath.substring(0, file.fsPath.length - ".uid".length);
			if (!fs.existsSync(file_path)) {
				continue;
			}

			const file_uri = vscode.Uri.file(file_path);
			uidCache.set(match[0], file_uri);

			if (not_found_uids.includes(match[0])) {
				uris.set(match[0], file_uri);
				if (uris.size === not_found_uids.length) {
					log.info(`[UID] Resolved all in ${Date.now() - startTime}ms (from .uid files)`);
					return uris;
				}
			}
		} catch {
			// Skip files that can't be read
		}
	}

	if (uris.size === not_found_uids.length) {
		log.info(`[UID] Resolved all in ${Date.now() - startTime}ms`);
		return uris;
	}

	// Search .import files (textures, audio, etc.)
	const importFiles = await vscode.workspace.findFiles("**/*.import", null);

	for (const file of importFiles) {
		try {
			// Read only first 1KB - UID is always in the header
			const fd = fs.openSync(file.fsPath, "r");
			const buffer = Buffer.alloc(1024);
			fs.readSync(fd, buffer, 0, 1024, 0);
			fs.closeSync(fd);
			const text = buffer.toString("utf-8");

			const match = text.match(/uid="(uid:\/\/[0-9a-zA-Z]*)"/);
			if (!match) {
				continue;
			}

			const uid = match[1];
			const file_path = file.fsPath.substring(0, file.fsPath.length - ".import".length);
			if (!fs.existsSync(file_path)) {
				continue;
			}

			const file_uri = vscode.Uri.file(file_path);
			uidCache.set(uid, file_uri);

			if (not_found_uids.includes(uid)) {
				uris.set(uid, file_uri);
				if (uris.size === not_found_uids.length) {
					log.info(`[UID] Resolved all in ${Date.now() - startTime}ms (from .import files)`);
					return uris;
				}
			}
		} catch {
			// Skip files that can't be read
		}
	}

	if (uris.size === not_found_uids.length) {
		log.info(`[UID] Resolved all in ${Date.now() - startTime}ms`);
		return uris;
	}

	// Search .tres and .tscn files (UIDs embedded in file header)
	const resourceFiles = await vscode.workspace.findFiles("**/*.{tres,tscn}", null);

	for (const file of resourceFiles) {
		try {
			// Read only first 512 bytes - header with UID is at the start
			const fd = fs.openSync(file.fsPath, "r");
			const buffer = Buffer.alloc(512);
			fs.readSync(fd, buffer, 0, 512, 0);
			fs.closeSync(fd);
			const text = buffer.toString("utf-8");

			const match = text.match(/uid="(uid:\/\/[0-9a-zA-Z]*)"/);
			if (!match) {
				continue;
			}

			const uid = match[1];
			const file_uri = file;
			uidCache.set(uid, file_uri);

			if (not_found_uids.includes(uid)) {
				uris.set(uid, file_uri);
				if (uris.size === not_found_uids.length) {
					log.info(`[UID] Resolved all in ${Date.now() - startTime}ms (from .tres/.tscn files)`);
					return uris;
				}
			}
		} catch {
			// Skip files that can't be read
		}
	}

	log.info(`[UID] Search completed in ${Date.now() - startTime}ms, found ${uris.size}/${not_found_uids.length}`)

	// Log unresolved UIDs
	const unresolved = not_found_uids.filter(uid => !uris.has(uid));
	if (unresolved.length > 0) {
		log.warn(`[UID] Could not resolve: ${unresolved.join(", ")}`);
	}

	return uris;
}

export async function convert_uid_to_uri(uid: string): Promise<vscode.Uri | undefined> {
	const uris = await convert_uids_to_uris([uid]);
	return uris.get(uid);
}

export type VERIFY_STATUS = "SUCCESS" | "WRONG_VERSION" | "INVALID_EXE";
export type VERIFY_RESULT = {
	status: VERIFY_STATUS;
	godotPath: string;
	version?: string;
};

export function verify_godot_version(godotPath: string, expectedVersion: "3" | "4" | string): VERIFY_RESULT {
	let target = clean_godot_path(godotPath);

	let output = "";
	try {
		output = execSync(`"${target}" --version`).toString().trim();
	} catch {
		if (path.isAbsolute(target)) {
			return { status: "INVALID_EXE", godotPath: target };
		}
		const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
		target = path.resolve(workspacePath, target);
		try {
			output = execSync(`"${target}" --version`).toString().trim();
		} catch {
			return { status: "INVALID_EXE", godotPath: target };
		}
	}

	const pattern = /^(([34])\.([0-9]+)(?:\.[0-9]+)?)/m;
	const match = output.match(pattern);
	if (!match) {
		return { status: "INVALID_EXE", godotPath: target };
	}
	if (match[2] !== expectedVersion) {
		return { status: "WRONG_VERSION", godotPath: target, version: match[1] };
	}
	return { status: "SUCCESS", godotPath: target, version: match[1] };
}

export function clean_godot_path(godotPath: string): string {
	let pathToClean = godotPath;

	// check for environment variable syntax
	// looking for: ${env:FOOBAR}
	// extracts "FOOBAR"
	const pattern = /\$\{env:(.+?)\}/;
	const match = godotPath.match(pattern);

	if (match && match.length >= 2)	{
		pathToClean = process.env[match[1]];
	}

	// strip leading and trailing quotes
	let target = pathToClean.replace(/^"/, "").replace(/"$/, "");

	// try to fix macos paths
	if (os.platform() === "darwin" && target.endsWith(".app")) {
		target = path.join(target, "Contents", "MacOS", "Godot");
	}

	return target;
}

/**
 * Checks if the current Godot project uses C#.
 * Detection is based on presence of *.csproj files in the project directory.
 */
export async function is_csharp_project(): Promise<boolean> {
	const projectDir = await get_project_dir();
	if (!projectDir) {
		return false;
	}

	// Check for .csproj files which indicate a C# project
	const csprojFiles = await vscode.workspace.findFiles("**/*.csproj", null, 1);
	return csprojFiles.length > 0;
}
