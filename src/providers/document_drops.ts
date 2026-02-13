import * as path from "node:path";
import { exec, ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import {
	CancellationToken,
	DataTransfer,
	DocumentDropEdit,
	DocumentDropEditProvider,
	ExtensionContext,
	languages,
	Position,
	ProviderResult,
	Range,
	TextDocument,
	Uri,
} from "vscode";
import { SceneParser } from "../scene_tools/parser";
import { ScenePreviewWebviewProvider } from "../scene_tools/scene_preview_webview";
import { createLogger, node_name_to_snake, node_name_to_pascal, node_name_to_camel, get_project_version, get_project_dir, convert_uri_to_resource_path } from "../utils";
import { subProcess, killSubProcesses } from "../utils/subspawn";
import { SceneNode } from "../scene_tools/types";

const log = createLogger("providers.drops");

interface CSharpStyleResult {
	edit: string | vscode.SnippetString;
	/** The exact C# property/field name for scene file NodePath assignment. Undefined = no scene modification. */
	scenePropertyName?: string;
}

interface CSharpStyleOption {
	label: string;
	description: string;
	generator: (className: string, propertyName: string, fieldName: string, nodePath: string) => CSharpStyleResult;
}

const CSHARP_STYLE_OPTIONS: Record<string, CSharpStyleOption> = {
	exportPrivate: {
		label: "[Export] private property",
		description: "Private auto-property with underscore prefix",
		generator: (className, _propertyName, fieldName) => {
			const snippet = new vscode.SnippetString();
			snippet.appendText(`[Export] private ${className} _`);
			snippet.appendPlaceholder(fieldName);
			snippet.appendText(" { get; set; }");
			return { edit: snippet, scenePropertyName: `_${fieldName}` };
		},
	},
	exportPublic: {
		label: "[Export] public property",
		description: "Public auto-property",
		generator: (className, propertyName) => {
			const snippet = new vscode.SnippetString();
			snippet.appendText(`[Export] public ${className} `);
			snippet.appendPlaceholder(propertyName);
			snippet.appendText(" { get; set; }");
			return { edit: snippet, scenePropertyName: propertyName };
		},
	},
	lazyField: {
		label: "Lazy field (C# 14)",
		description: "Cached with field keyword",
		generator: (className, _propertyName, fieldName, nodePath) => ({
			edit: `${className} _${fieldName} => field ??= GetNode<${className}>("${nodePath}");`,
		}),
	},
	expressionBodied: {
		label: "Expression-bodied property",
		description: "Simple getter, no caching",
		generator: (className, propertyName, _fieldName, nodePath) => ({
			edit: `${className} ${propertyName} => GetNode<${className}>("${nodePath}");`,
		}),
	},
};

/** Default style key */
const DEFAULT_CSHARP_STYLE = "exportPublic";

export class GDDocumentDropEditProvider implements DocumentDropEditProvider {
	public parser = new SceneParser();
	public scenePreview?: ScenePreviewWebviewProvider;

	constructor(private context: ExtensionContext) {
		const dropEditSelector = [
			{ language: "csharp", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
		];
		context.subscriptions.push(languages.registerDocumentDropEditProvider(dropEditSelector, this));
		context.subscriptions.push(
			vscode.commands.registerCommand("godotTools.rebuildCSharp", () => this.rebuildCSharp()),
		);
	}

	public async provideDocumentDropEdits(
		document: TextDocument,
		position: Position,
		dataTransfer: DataTransfer,
		token: CancellationToken,
	): Promise<DocumentDropEdit> {
		// log.debug("provideDocumentDropEdits", document, dataTransfer);

		// Try to get data from the WebView-based Scene Preview first
		const webviewData = dataTransfer.get("application/vnd.code.tree.godotTools.scenePreview");
		if (webviewData) {
			return this.handleWebviewDrop(document, position, webviewData);
		}

		// Fall back to native TreeView drag data (godot/* MIME types)
		const targetResPath = await convert_uri_to_resource_path(document.uri);

		const sceneItem = dataTransfer.get("godot/scene");
		if (!sceneItem?.value) {
			return undefined;
		}
		const originFsPath = sceneItem.value;
		const originUri = vscode.Uri.file(originFsPath);

		const originDocument = await vscode.workspace.openTextDocument(originUri);
		const scene = await this.parser.parse_scene(originDocument);

		let scriptId = "";
		for (const res of scene.externalResources.values()) {
			if (res.path === targetResPath) {
				scriptId = res.id;
				break;
			}
		}

		let nodePathOfTarget: SceneNode;
		if (scriptId) {
			const find_node = () => {
				if (scene.root.scriptId === scriptId) {
					return scene.root;
				}
				for (const node of scene.nodes.values()) {
					if (node.scriptId === scriptId) {
						return node;
					}
				}
			};
			nodePathOfTarget = find_node();
		}

		const className: string = dataTransfer.get("godot/class")?.value;
		if (className) {
			const nodePath: string = dataTransfer.get("godot/path")?.value;
			let relativePath: string = dataTransfer.get("godot/relativePath")?.value;
			const unique = dataTransfer.get("godot/unique")?.value === "true";
			const label: string = dataTransfer.get("godot/label")?.value;

			if (nodePathOfTarget) {
				const targetPath = path.normalize(path.relative(nodePathOfTarget?.path, nodePath));
				relativePath = targetPath.split(path.sep).join(path.posix.sep);
			}

			// For the root node, the path is empty and needs to be replaced with the node name
			let savePath = relativePath || label;

			if (document.languageId === "gdscript") {
				if (savePath.startsWith(".")) {
					savePath = `'${savePath}'`;
				}
				let qualifiedPath = `$${savePath}`;

				if (unique) {
					// For unique nodes, we can use the % syntax and drop the full path
					qualifiedPath = `%${label}`;
				}

				const line = document.lineAt(position.line);
				if (line.text === "") {
					// We assume that if the user is dropping a node in an empty line, they are at the top of
					// the script and want to declare an onready variable

					const snippet = new vscode.SnippetString();

					if ((await get_project_version())?.startsWith("4")) {
						snippet.appendText("@");
					}
					snippet.appendText("onready var ");
					snippet.appendPlaceholder(node_name_to_snake(label));
					snippet.appendText(`: ${className} = ${qualifiedPath}`);
					return new vscode.DocumentDropEdit(snippet);
				}

				// In any other place, we assume the user wants to get a reference to the node itself
				return new vscode.DocumentDropEdit(qualifiedPath);
			}

			if (document.languageId === "csharp") {
				const propertyName = node_name_to_pascal(label);
				const fieldName = node_name_to_camel(label);
				const nodePath = unique ? `%${label}` : savePath;

				const line = document.lineAt(position.line);
				if (line.text.trim() === "") {
					// Empty line: use configured style for property declaration
					const config = vscode.workspace.getConfiguration("godotTools.csharp");
					const styleKey = config.get<string>("nodeReferenceStyle", DEFAULT_CSHARP_STYLE);
					const style = CSHARP_STYLE_OPTIONS[styleKey] || CSHARP_STYLE_OPTIONS[DEFAULT_CSHARP_STYLE];
					const result = style.generator(className, propertyName, fieldName, nodePath);
					return new vscode.DocumentDropEdit(result.edit);
				}

				// Non-empty line: inline GetNode call
				return new vscode.DocumentDropEdit(`GetNode<${className}>("${nodePath}")`);
			}
		}
	}

	/**
	 * Handle drops from the WebView-based Scene Preview.
	 * The WebView sends JSON data with node information.
	 */
	private async handleWebviewDrop(
		document: TextDocument,
		position: Position,
		webviewDataItem: vscode.DataTransferItem,
	): Promise<DocumentDropEdit> {
		try {
			const rawData = await webviewDataItem.asString();
			const nodeData = JSON.parse(rawData);

			const className: string = nodeData.type;
			const label: string = nodeData.name;
			let relativePath: string = nodeData.relativePath;
			const unique: boolean = nodeData.unique === true || nodeData.unique === "true";
			const scenePath: string = nodeData.scenePath;
			const useSecondaryStyle: boolean = nodeData.useSecondaryStyle === true;

			if (!className || !label) {
				log.debug("WebView drop missing required data:", nodeData);
				return undefined;
			}

			// Load the scene to find the target node (the script that's being dropped onto)
			const targetResPath = await convert_uri_to_resource_path(document.uri);
			const originUri = vscode.Uri.file(scenePath);
			const originDocument = await vscode.workspace.openTextDocument(originUri);
			const scene = await this.parser.parse_scene(originDocument);

			// Find the script ID for the target document
			let scriptId = "";
			for (const res of scene.externalResources.values()) {
				if (res.path === targetResPath) {
					scriptId = res.id;
					break;
				}
			}

			// Find the node that has this script attached
			// Pass 1: Direct script in scene ext_resources
			let nodePathOfTarget: SceneNode;
			if (scriptId) {
				if (scene.root?.scriptId === scriptId) {
					nodePathOfTarget = scene.root;
				} else {
					for (const node of scene.nodes.values()) {
						if (node.scriptId === scriptId) {
							nodePathOfTarget = node;
							break;
						}
					}
				}
			}

			// Pass 2: Check instanced scene root scripts (e.g., ChildScene.tscn whose root has the script)
			if (!nodePathOfTarget && targetResPath) {
				for (const node of scene.nodes.values()) {
					if (node.resourcePath?.endsWith(".tscn")) {
						const rootScript = this.parser.getRootScriptFromSceneSync(node.resourcePath);
						if (rootScript === targetResPath) {
							nodePathOfTarget = node;
							break;
						}
					}
				}
			}

			// If we found the target node, compute relative path from target to dragged node
			if (nodePathOfTarget) {
				const targetPath = path.normalize(path.relative(nodePathOfTarget.path, nodeData.path));
				relativePath = targetPath.split(path.sep).join(path.posix.sep);
			}

			// For the root node, the path is empty and needs to be replaced with the node name
			let savePath = relativePath || label;

			if (document.languageId === "gdscript") {
				if (savePath.startsWith(".")) {
					savePath = `'${savePath}'`;
				}
				let qualifiedPath = `$${savePath}`;

				if (unique) {
					qualifiedPath = `%${label}`;
				}

				const line = document.lineAt(position.line);
				if (line.text === "") {
					const snippet = new vscode.SnippetString();
					if ((await get_project_version())?.startsWith("4")) {
						snippet.appendText("@");
					}
					snippet.appendText("onready var ");
					snippet.appendPlaceholder(node_name_to_snake(label));
					snippet.appendText(`: ${className} = ${qualifiedPath}`);
					return new vscode.DocumentDropEdit(snippet);
				}

				return new vscode.DocumentDropEdit(qualifiedPath);
			}

			if (document.languageId === "csharp") {
				const propertyName = node_name_to_pascal(label);
				const fieldName = node_name_to_camel(label);
				const nodePath = unique ? `%${label}` : savePath;

				const line = document.lineAt(position.line);
				if (line.text.trim() === "") {
					const config = vscode.workspace.getConfiguration("godotTools.csharp");
					// Use secondary style if Ctrl+Shift was held during drag start
					const styleKey = useSecondaryStyle
						? config.get<string>("secondaryNodeReferenceStyle", "lazyField")
						: config.get<string>("nodeReferenceStyle", DEFAULT_CSHARP_STYLE);
					const style = CSHARP_STYLE_OPTIONS[styleKey] || CSHARP_STYLE_OPTIONS[DEFAULT_CSHARP_STYLE];
					const result = style.generator(className, propertyName, fieldName, nodePath);

					// For export styles: if script is in the scene, immediately modify the .tscn
					if (result.scenePropertyName && nodePathOfTarget) {
						this.applySceneModification(scenePath, nodePathOfTarget.text, nodePathOfTarget.label, result.scenePropertyName, nodePath)
							.catch(err => log.error("Failed to apply scene modification:", err));
						this.scenePreview?.showRebuildBanner();
					}

					return new vscode.DocumentDropEdit(result.edit);
				}

				return new vscode.DocumentDropEdit(`GetNode<${className}>("${nodePath}")`);
			}
		} catch (error) {
			log.error("Error handling WebView drop:", error);
		}

		return undefined;
	}

	/**
	 * Rebuild C# project via dotnet build.
	 * Triggered by the "Rebuild" button in the Scene Preview banner.
	 */
	private async rebuildCSharp(): Promise<void> {
		const projectDir = await get_project_dir();
		if (!projectDir) {
			vscode.window.showWarningMessage("Could not determine Godot project directory.");
			return;
		}

		const slnFiles = await vscode.workspace.findFiles("**/*.sln", null, 1);
		const buildTarget = slnFiles.length > 0 ? `"${slnFiles[0].fsPath}"` : ".";
		const buildCommand = `dotnet build ${buildTarget}`;

		const success = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Rebuilding C# project...", cancellable: false },
			() => new Promise<boolean>((resolve) => {
				exec(buildCommand, { cwd: projectDir }, (err, _stdout, stderr) => {
					if (err) {
						log.error("C# build failed:", stderr);
						vscode.window.showWarningMessage(
							"C# build failed. Rebuild manually so the NodePaths are recognized.",
						);
						resolve(false);
					} else {
						log.info("C# build succeeded");
						resolve(true);
					}
				});
			}),
		);

		if (success) {
			this.scenePreview?.hideRebuildBanner();
			vscode.window.showInformationMessage("C# rebuilt. You can now reload the scene in Godot.");
		}
	}

	/**
	 * Modify a .tscn scene file to add a NodePath assignment for an exported variable.
	 * Adds the property name to node_paths=PackedStringArray(...) and inserts the NodePath property.
	 */
	private async applySceneModification(
		sceneFsPath: string,
		targetNodeText: string,
		targetNodeLabel: string,
		propertyName: string,
		nodePath: string,
	): Promise<void> {
		const sceneUri = vscode.Uri.file(sceneFsPath);
		const doc = await vscode.workspace.openTextDocument(sceneUri);
		const text = doc.getText();

		// Find the target node's [node ...] line by matching its exact text
		const nodeIndex = text.indexOf(targetNodeText);
		if (nodeIndex < 0) {
			log.warn(`Could not find node line in scene file: ${targetNodeText}`);
			return;
		}

		const nodeLineStart = doc.positionAt(nodeIndex);
		const nodeLineEnd = doc.positionAt(nodeIndex + targetNodeText.length);

		// Determine the node's body (between this [node] and next [section])
		const nextSectionRegex = /\n\[/;
		const bodyStart = nodeIndex + targetNodeText.length;
		const nextSectionMatch = text.slice(bodyStart).match(nextSectionRegex);
		const bodyEnd = nextSectionMatch
			? bodyStart + nextSectionMatch.index
			: text.length;
		const nodeBody = text.slice(bodyStart, bodyEnd);

		// Check for duplicate property
		const propRegex = new RegExp(`^${propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "m");
		if (propRegex.test(nodeBody)) {
			log.debug(`Property ${propertyName} already exists on node, skipping`);
			return;
		}

		const edit = new vscode.WorkspaceEdit();

		// 1. Modify the [node ...] line to add/extend node_paths
		const nodePathsMatch = targetNodeText.match(/node_paths=PackedStringArray\(([^)]*)\)/);
		let modifiedNodeLine: string;
		if (nodePathsMatch) {
			const existingEntries = nodePathsMatch[1];
			const newEntries = existingEntries
				? `${existingEntries}, "${propertyName}"`
				: `"${propertyName}"`;
			modifiedNodeLine = targetNodeText.replace(
				/node_paths=PackedStringArray\([^)]*\)/,
				`node_paths=PackedStringArray(${newEntries})`,
			);
		} else {
			modifiedNodeLine = targetNodeText.replace(
				/\]$/,
				` node_paths=PackedStringArray("${propertyName}")]`,
			);
		}
		edit.replace(sceneUri, new vscode.Range(nodeLineStart, nodeLineEnd), modifiedNodeLine);

		// 2. Insert the NodePath property line at the end of the node's body
		const insertPos = doc.positionAt(bodyEnd);
		edit.insert(sceneUri, insertPos, `\n${propertyName} = NodePath("${nodePath}")`);

		await vscode.workspace.applyEdit(edit);
		await doc.save();
		log.info(`Modified scene file: added ${propertyName} = NodePath("${nodePath}") to node ${targetNodeLabel}`);
	}
}

/**
 * Manages a background `dotnet watch build` process that auto-rebuilds C# on save.
 * When active, Godot auto-detects assembly changes without manual Rebuild clicks.
 */
export class DotnetWatchManager {
	private proc?: ChildProcess;

	async start(): Promise<void> {
		if (this.proc) return;

		const projectDir = await get_project_dir();
		if (!projectDir) return;

		const slnFiles = await vscode.workspace.findFiles("**/*.sln", null, 1);
		const buildTarget = slnFiles.length > 0 ? slnFiles[0].fsPath : ".";

		this.proc = subProcess("DotnetWatch", `dotnet watch build --project "${buildTarget}"`, {
			shell: true,
			cwd: projectDir,
		});

		this.proc.stdout?.on("data", (data) => {
			const msg = data.toString().trim();
			if (msg) log.info(`[dotnet watch] ${msg}`);
		});

		this.proc.stderr?.on("data", (data) => {
			const msg = data.toString().trim();
			if (msg) log.warn(`[dotnet watch] ${msg}`);
		});

		this.proc.on("close", (code) => {
			log.info(`dotnet watch exited with code ${code}`);
			this.proc = undefined;
		});

		log.info("Started dotnet watch build");
	}

	stop(): void {
		if (this.proc) {
			killSubProcesses("DotnetWatch");
			this.proc = undefined;
			log.info("Stopped dotnet watch build");
		}
	}
}
