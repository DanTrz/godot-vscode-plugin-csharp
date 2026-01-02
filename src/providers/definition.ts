import * as vscode from "vscode";
import {
	Uri,
	Position,
	TextDocument,
	CancellationToken,
	Location,
	Definition,
	DefinitionProvider,
	ExtensionContext,
	TextLine,
} from "vscode";
import { make_docs_uri, createLogger } from "../utils";
import { globals } from "../extension";

const log = createLogger("providers.definitions");

// C# PascalCase method name → Godot class that defines it
const GODOT_VIRTUAL_METHODS = new Map<string, string>([
	// Node
	["_Ready", "Node"],
	["_Process", "Node"],
	["_PhysicsProcess", "Node"],
	["_EnterTree", "Node"],
	["_ExitTree", "Node"],
	["_Input", "Node"],
	["_ShortcutInput", "Node"],
	["_UnhandledInput", "Node"],
	["_UnhandledKeyInput", "Node"],

	// CanvasItem
	["_Draw", "CanvasItem"],

	// Control
	["_GuiInput", "Control"],
	["_GetMinimumSize", "Control"],
	["_HasPoint", "Control"],
	["_GetDragData", "Control"],
	["_CanDropData", "Control"],
	["_DropData", "Control"],
	["_MakeCustomTooltip", "Control"],

	// MainLoop
	["_Initialize", "MainLoop"],
	["_Finalize", "MainLoop"],

	// SceneTree (extends MainLoop)
	["_Initialize", "SceneTree"],
	["_Finalize", "SceneTree"],
]);

// Convert C# PascalCase to GDScript snake_case: "_Ready" → "_ready", "_PhysicsProcess" → "_physics_process"
function toSnakeCase(word: string): string {
	return word.replace(/([A-Z])/g, (match, p1, offset) =>
		offset === 0 || word[offset - 1] === "_" ? p1.toLowerCase() : "_" + p1.toLowerCase()
	);
}

export class GDDefinitionProvider implements DefinitionProvider {
	constructor(private context: ExtensionContext) {
		const selector = [
			{ language: "gdresource", scheme: "file" },
			{ language: "gdscene", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
			{ language: "csharp", scheme: "file" },
		];

		context.subscriptions.push(
			vscode.languages.registerDefinitionProvider(selector, this), //
		);
	}

	async provideDefinition(document: TextDocument, position: Position, token: CancellationToken): Promise<Definition> {
		// Handle C# files - check classInfo and virtual methods, let C# LSP handle non-Godot symbols
		if (document.languageId === "csharp") {
			const range = document.getWordRangeAtPosition(position, /(_?\w+)/);
			if (range) {
				const word = document.getText(range);

				// Check if it's a Godot class
				if (globals.docsProvider.classInfo.has(word)) {
					const uri = make_docs_uri(word);
					return new Location(uri, new Position(0, 0));
				}

				// Check if it's a Godot virtual method
				const methodClass = GODOT_VIRTUAL_METHODS.get(word);
				if (methodClass) {
					const snakeCase = toSnakeCase(word);
					const uri = make_docs_uri(methodClass, snakeCase);
					return new Location(uri, new Position(0, 0));
				}
			}
			return null;
		}

		if (["gdresource", "gdscene"].includes(document.languageId)) {
			const range = document.getWordRangeAtPosition(position, /(\w+)/);
			if (range) {
				const word = document.getText(range);
				if (globals.docsProvider.classInfo.has(word)) {
					const uri = make_docs_uri(word);
					return new Location(uri, new Position(0, 0));
				} else {
					let i = 0;
					let line: TextLine;
					let match: RegExpMatchArray | null;

					do {
						line = document.lineAt(position.line - i++);
						match = line.text.match(/(?<=type)="(\w+)"/);
					} while (!match && line.lineNumber > 0);

					if (globals.docsProvider.classInfo.has(match[1])) {
						const uri = make_docs_uri(match[1], word);
						return new Location(uri, new Position(0, 0));
					}
				}
			}

			return null;
		}

		const target = await globals.lsp.client.get_symbol_at_position(document.uri, position);

		if (!target) {
			return null;
		}

		const parts = target.split(".");
		const uri = make_docs_uri(parts[0], parts[1]);

		return new Location(uri, new Position(0, 0));
	}
}
