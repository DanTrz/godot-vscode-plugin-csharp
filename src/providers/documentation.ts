import * as vscode from "vscode";
import type {
	CancellationToken,
	CustomDocument,
	CustomDocumentOpenContext,
	CustomReadonlyEditorProvider,
	ExtensionContext,
	Uri,
	WebviewPanel,
} from "vscode";
import type { NotificationMessage } from "vscode-jsonrpc";
import type {
	NativeSymbolInspectParams,
	GodotNativeSymbol,
	GodotNativeClassInfo,
	GodotCapabilities,
} from "./documentation_types";
import { make_html_content } from "./documentation_builder";
import { createLogger, get_configuration, get_extension_uri, make_docs_uri } from "../utils";
import { globals } from "../extension";

const log = createLogger("providers.docs");

export class GDDocumentationProvider implements CustomReadonlyEditorProvider {
	public classInfo = new Map<string, GodotNativeClassInfo>();
	public symbolDb = new Map<string, GodotNativeSymbol>();
	public htmlDb = new Map<string, string>();

	private ready = false;

	/**
	 * Resets the provider state. Called when LSP disconnects to clear stale data.
	 */
	public reset() {
		this.ready = false;
		this.classInfo.clear();
		this.symbolDb.clear();
		this.htmlDb.clear();
		log.info("Documentation provider reset");
	}

	constructor(private context: ExtensionContext) {
		const options = {
			webviewOptions: {
				enableScripts: true,
				retainContextWhenHidden: true,
				enableFindWidget: true,
			},
			supportsMultipleEditorsPerDocument: true,
		};
		context.subscriptions.push(vscode.window.registerCustomEditorProvider("gddoc", this, options));
	}

	public register_capabilities(message: NotificationMessage) {
		for (const gdclass of (message.params as GodotCapabilities).native_classes) {
			this.classInfo.set(gdclass.name, gdclass);
		}
		for (const gdclass of this.classInfo.values()) {
			if (gdclass.inherits) {
				if (!this.classInfo.has(gdclass.inherits)) {
					this.classInfo.set(gdclass.inherits, {
						name: gdclass.inherits,
						inherits: "",
					});
				}
				const extended_classes = this.classInfo.get(gdclass.inherits).extended_classes || [];
				extended_classes.push(gdclass.name);
				this.classInfo.get(gdclass.inherits).extended_classes = extended_classes;
			}
		}
		this.ready = true;
	}

	public async list_native_classes() {
		const classname = await vscode.window.showQuickPick([...this.classInfo.keys()].sort(), {
			placeHolder: "Type godot class name here",
			canPickMany: false,
		});
		if (classname) {
			vscode.commands.executeCommand("vscode.open", make_docs_uri(classname));
		}
	}

	public openCustomDocument(
		uri: Uri,
		openContext: CustomDocumentOpenContext,
		token: CancellationToken,
	): CustomDocument {
		return { uri: uri, dispose: () => {} };
	}

	/**
	 * Fallback page shown when class documentation can't be loaded because the
	 * Godot language server hasn't delivered its class capabilities (LSP down,
	 * still connecting, or in a degraded state). Avoids hanging the editor on a
	 * blank/spinning panel forever.
	 */
	private make_unavailable_html(className: string): string {
		const safeClassName = className.replace(/[&<>"']/g, (c) => {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
		});
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 2rem; line-height: 1.5; }
		h2 { margin-top: 0; }
		code { background: var(--vscode-textCodeBlock-background); padding: 0.1rem 0.3rem; border-radius: 3px; }
		.hint { color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<h2>Documentation unavailable</h2>
	<p>Godot documentation for <code>${safeClassName}</code> isn't available yet because the
	GDScript language server hasn't sent its class data.</p>
	<p class="hint">This usually means the language server is still connecting, is offline, or
	connected without class capabilities. Reopen this page once the LSP is connected
	(check the Godot LSP status in the status bar).</p>
</body>
</html>`;
	}

	public async resolveCustomEditor(
		document: CustomDocument,
		panel: WebviewPanel,
		token: CancellationToken,
	): Promise<void> {
		const className = document.uri.path.split(".")[0];
		const target = document.uri.fragment;
		let symbol: GodotNativeSymbol = null;

		panel.webview.options = {
			enableScripts: true,
		};

		// Wait for LSP class capabilities to be available, but never block forever.
		// The manager settles early if the connection is degraded/disconnected (so we
		// don't sit through the full timeout for capabilities that will never arrive),
		// and honors the cancellation token (e.g. the user closes this tab).
		if (!this.ready) {
			// Keep this in line with the LSP capabilities window in ClientConnectionManager.
			const ready = await globals.lsp.waitForCapabilitiesReady(30000, token);
			if (!ready || !this.ready) {
				if (!token.isCancellationRequested) {
					panel.webview.html = this.make_unavailable_html(className);
				}
				return;
			}
		}

		symbol = this.symbolDb.get(className);

		if (!symbol && this.classInfo.has(className)) {
			const params: NativeSymbolInspectParams = {
				native_class: className,
				symbol_name: className,
			};

			const response = await globals.lsp.client.send_request("textDocument/nativeSymbol", params);

			symbol = response as GodotNativeSymbol;
			symbol.class_info = this.classInfo.get(symbol.name);
			this.symbolDb.set(symbol.name, symbol);
		}
		if (!this.htmlDb.has(className)) {
			this.htmlDb.set(className, make_html_content(panel.webview, symbol, target));
		}

		const scaleFactor = get_configuration("documentation.pageScale");
		panel.webview.html = this.htmlDb.get(className).replaceAll("scaleFactor", scaleFactor);

		const displayMinimap = get_configuration("documentation.displayMinimap");
		if (displayMinimap) {
			panel.webview.html = this.htmlDb.get(className).replace("displayMinimap", "initial;");
			panel.webview.html = this.htmlDb.get(className).replace("bodyMargin", "200px;");
		} else {
			panel.webview.html = this.htmlDb.get(className).replace("bodyMargin", "0px;");
			panel.webview.html = this.htmlDb.get(className).replace("displayMinimap", "none;");
		}

		panel.iconPath = get_extension_uri("resources/godot_icon.svg");
		panel.webview.onDidReceiveMessage((msg) => {
			if (msg.type === "INSPECT_NATIVE_SYMBOL") {
				const uri = make_docs_uri(msg.data.native_class, msg.data.symbol_name);
				vscode.commands.executeCommand("vscode.open", uri);
			}
		});

		if (target) {
			panel.webview.postMessage({
				command: "focus",
				target: target,
			});
		}
	}
}
