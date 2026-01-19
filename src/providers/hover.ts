import * as vscode from "vscode";
import {
	Uri,
	Position,
	TextDocument,
	CancellationToken,
	ExtensionContext,
	HoverProvider,
	MarkdownString,
	Hover,
} from "vscode";
import { SceneParser } from "../scene_tools";
import { convert_resource_path_to_uri, createLogger, convert_uid_to_uri, convert_uri_to_resource_path } from "../utils";

const log = createLogger("providers.hover");

// Maximum lines to show in hover preview to prevent UI freeze on large files
const MAX_PREVIEW_LINES = 50;
// Maximum characters per line in preview
const MAX_LINE_LENGTH = 200;

export class GDHoverProvider implements HoverProvider {
	public parser = new SceneParser();

	constructor(private context: ExtensionContext) {
		const selector = [
			{ language: "gdresource", scheme: "file" },
			{ language: "gdscene", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
			{ language: "csharp", scheme: "file" },
		];
		context.subscriptions.push(
			vscode.languages.registerHoverProvider(selector, this),
		);
	}

	async get_links(text: string): Promise<string> {
		let links = "";
		for (const match of text.matchAll(/res:\/\/[^"^']*/g)) {
			const uri = await convert_resource_path_to_uri(match[0]);
			if (uri instanceof Uri) {
				links += `* [${match[0]}](${uri})\n`;
			}
		}
		for (const match of text.matchAll(/uid:\/\/[0-9a-zA-Z]*/g)) {
			const uri = await convert_uid_to_uri(match[0]);
			if (uri instanceof Uri) {
				links += `* [${match[0]}](${uri})\n`;
			}
		}
		return links;
	}

	/**
	 * Truncate text for preview to prevent UI freeze on large files
	 */
	private truncateForPreview(text: string, languageId: string): string {
		const lines = text.split("\n");
		let truncated = false;

		// Limit line count
		let previewLines = lines.slice(0, MAX_PREVIEW_LINES);
		if (lines.length > MAX_PREVIEW_LINES) {
			truncated = true;
		}

		// Limit line length
		previewLines = previewLines.map(line => {
			if (line.length > MAX_LINE_LENGTH) {
				return line.substring(0, MAX_LINE_LENGTH) + "...";
			}
			return line;
		});

		let result = previewLines.join("\n");
		if (truncated) {
			result += `\n\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`;
		}
		return result;
	}

	async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover> {
		// Check cancellation early
		if (token.isCancellationRequested) {
			return null;
		}

		if (["gdresource", "gdscene"].includes(document.languageId)) {
			const scene = this.parser.parse_scene(document);

			// Check cancellation after potentially expensive parse
			if (token.isCancellationRequested) {
				return null;
			}

			const wordPattern = /(?:Ext|Sub)Resource\(\s?"?(\w+)\s?"?\)/;
			const word = document.getText(document.getWordRangeAtPosition(position, wordPattern));

			if (word.startsWith("ExtResource")) {
				const match = word.match(wordPattern);
				const id = match[1];
				const resource = scene.externalResources.get(id);
				const definition = resource.body;
				const links = await this.get_links(definition);

				// Check cancellation after async operation
				if (token.isCancellationRequested) {
					return null;
				}

				const contents = new MarkdownString();
				contents.appendMarkdown(links);
				const uri = await convert_resource_path_to_uri(resource.path);
				contents.appendMarkdown("\n---\n");
				contents.appendCodeblock(definition, "gdresource");
				if (resource.type === "Texture") {
					contents.appendMarkdown("\n---\n");
					contents.appendMarkdown(`<img src="${uri}" min-width=100px max-width=500px/>\n`);
					contents.supportHtml = true;
					contents.isTrusted = true;
				}
				if (resource.type === "Script") {
					// Check cancellation before loading file
					if (token.isCancellationRequested) {
						return null;
					}
					contents.appendMarkdown("\n---\n");
					const doc = await vscode.workspace.openTextDocument(uri);
					const text = this.truncateForPreview(doc.getText(), "gdscript");
					contents.appendCodeblock(text, "gdscript");
				}
				const hover = new Hover(contents);
				return hover;
			}

			if (word.startsWith("SubResource")) {
				const match = word.match(wordPattern);
				const id = match[1];

				let definition = scene.subResources.get(id).body;
				// don't display contents of giant arrays
				definition = definition?.replace(/Array\([0-9,\.\- ]*\)/, "Array(...)");

				const contents = new MarkdownString();
				contents.appendCodeblock(definition, "gdresource");
				const hover = new Hover(contents);
				return hover;
			}
		}

		// Check cancellation before regex operations
		if (token.isCancellationRequested) {
			return null;
		}

		let link = document.getText(document.getWordRangeAtPosition(position, /res:\/\/[^"^']*/));
		let originalUid = "";
		if (!link.startsWith("res://")) {
			link = document.getText(document.getWordRangeAtPosition(position, /uid:\/\/[0-9a-zA-Z]*/));
			if (link.startsWith("uid://")) {
				originalUid = link;
				const uri = await convert_uid_to_uri(link);

				// Check cancellation after async UID resolution
				if (token.isCancellationRequested) {
					return null;
				}

				link = await convert_uri_to_resource_path(uri);
			}
		}

		if (link.startsWith("res://")) {
			let type = "";
			if (link.endsWith(".gd")) {
				type = "gdscript";
			} else if (link.endsWith(".cs")) {
				type = "csharp";
			} else if (link.endsWith(".tscn")) {
				type = "gdscene";
			} else if (link.endsWith(".tres")) {
				type = "gdresource";
			} else if (link.endsWith(".png") || link.endsWith(".svg")) {
				type = "image";
			} else {
				return;
			}

			// Check cancellation before loading file
			if (token.isCancellationRequested) {
				return null;
			}

			const uri = await convert_resource_path_to_uri(link);
			const contents = new MarkdownString();

			// Show the resolved file path (especially useful for UIDs)
			if (originalUid) {
				contents.appendMarkdown(`**File:** \`${link}\`\n\n`);
			}

			if (type === "image") {
				contents.appendMarkdown(`<img src="${uri}" min-width=100px max-width=500px/>`);
				contents.supportHtml = true;
				contents.isTrusted = true;
			} else {
				const doc = await vscode.workspace.openTextDocument(uri);

				// Check cancellation after loading document
				if (token.isCancellationRequested) {
					return null;
				}

				const text = this.truncateForPreview(doc.getText(), type);
				contents.appendCodeblock(text, type);
			}
			const hover = new Hover(contents);
			return hover;
		}
	}
}
