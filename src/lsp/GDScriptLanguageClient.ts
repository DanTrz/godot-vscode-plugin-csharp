import EventEmitter from "node:events";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	LanguageClient,
	MessageSignature,
	type LanguageClientOptions,
	type NotificationMessage,
	type RequestMessage,
	type ResponseMessage,
	type ServerOptions,
} from "vscode-languageclient/node";

import { globals } from "../extension";
import { createLogger, get_configuration, get_project_dir, convert_uid_to_uri, convert_uri_to_resource_path } from "../utils";
import { MessageIO } from "./MessageIO";

const log = createLogger("lsp.client", { output: "Godot LSP" });

export enum ClientStatus {
	PENDING = 0,
	DISCONNECTED = 1,
	CONNECTED = 2,
	REJECTED = 3,
}

export enum TargetLSP {
	HEADLESS = 0,
	EDITOR = 1,
}

export type Target = {
	host: string;
	port: number;
	type: TargetLSP;
};

type HoverResult = {
	contents: {
		kind: string;
		value: string;
	};
	range: {
		end: {
			character: number;
			line: number;
		};
		start: {
			character: number;
			line: number;
		};
	};
};

type HoverResponseMesssage = {
	id: number;
	jsonrpc: string;
	result: HoverResult;
};

type ChangeWorkspaceNotification = {
	method: string;
	params: {
		path: string;
	};
};

type DocumentLinkResult = {
	range: {
		end: {
			character: number;
			line: number;
		};
		start: {
			character: number;
			line: number;
		};
	};
	target: string;
	tooltip?: string;
};

type DocumentLinkResponseMessage = {
	id: number;
	jsonrpc: string;
	result: DocumentLinkResult[];
};

export default class GDScriptLanguageClient extends LanguageClient {
	public io: MessageIO = new MessageIO();

	public target: TargetLSP = TargetLSP.EDITOR;

	public port = -1;
	public lastPortTried = -1;
	public sentMessages = new Map<string | number, any>();
	private rejected = false;

	events = new EventEmitter();

	private _status: ClientStatus;

	// Track bound handlers so we can remove them on dispose
	private boundOnConnected: () => void;
	private boundOnDisconnected: () => void;

	public set status(v: ClientStatus) {
		this._status = v;
		this.events.emit("status", this._status);
	}

	constructor() {
		const serverOptions: ServerOptions = () => {
			return new Promise((resolve, reject) => {
				resolve({ reader: this.io.reader, writer: this.io.writer });
			});
		};

		const clientOptions: LanguageClientOptions = {
			documentSelector: [
				{ scheme: "file", language: "gdscript" },
				{ scheme: "untitled", language: "gdscript" },
			],
		};

		super("GDScriptLanguageClient", serverOptions, clientOptions);
		this.status = ClientStatus.PENDING;

		// Store bound handlers so we can remove them later
		this.boundOnConnected = this.on_connected.bind(this);
		this.boundOnDisconnected = this.on_disconnected.bind(this);

		this.io.on("connected", this.boundOnConnected);
		this.io.on("disconnected", this.boundOnDisconnected);
		this.io.requestFilter = this.request_filter.bind(this);
		this.io.responseFilter = this.response_filter.bind(this);
		this.io.notificationFilter = this.notification_filter.bind(this);
	}

	/**
	 * Clean up all internal state before disposal.
	 * This MUST be called before creating a new client to prevent
	 * listener accumulation and stale state issues.
	 */
	public disposeClient(): void {
		// Clear stale sent messages that never got responses
		this.sentMessages.clear();

		// Remove our listeners from MessageIO
		this.io.off("connected", this.boundOnConnected);
		this.io.off("disconnected", this.boundOnDisconnected);

		// Clear filters
		this.io.requestFilter = (msg) => msg;
		this.io.responseFilter = (msg) => msg;
		this.io.notificationFilter = (msg) => msg;

		// Clean up MessageIO's reader listeners
		this.io.reader.disposeListeners();

		// Destroy socket if still connected
		if (this.io.socket) {
			this.io.socket.removeAllListeners();
			this.io.socket.destroy();
			this.io.socket = null;
		}

		// Clear message cache
		this.io.messageCache = [];

		// Remove all listeners from our events emitter
		this.events.removeAllListeners();
	}

	async connect(target: TargetLSP = TargetLSP.EDITOR, tryAlternatePort = false) {
		this.rejected = false;
		this.target = target;
		this.status = ClientStatus.PENDING;

		let port = get_configuration("lsp.serverPort");
		if (this.port !== -1) {
			port = this.port;
		}

		if (this.target === TargetLSP.EDITOR) {
			if (port === 6005 || port === 6008) {
				// Alternate between 6005 and 6008 for Godot 4.x compatibility
				// Godot 4.0-4.2 uses 6005, Godot 4.3+ uses 6008
				if (tryAlternatePort && this.lastPortTried === 6005) {
					port = 6008;
				} else if (tryAlternatePort && this.lastPortTried === 6008) {
					port = 6005;
				} else {
					port = 6005; // Start with 6005
				}
			}
		}

		this.lastPortTried = port;

		const host = get_configuration("lsp.serverHost");
		log.info(`attempting to connect to LSP at ${host}:${port}`);

		try {
			await this.io.connect(host, port);
		} catch (err) {
			// Connection failed (timeout, refused, etc.) - emit disconnected for retry
			log.debug(`Connection failed: ${err.message}`);
			// Status will be set by on_disconnected handler which fires from io.connect failure
		}
	}

	async send_request<R>(method: string, params): Promise<R> {
		try {
			return this.sendRequest(method, params);
		} catch {
			log.warn("sending request failed!");
		}
	}

	handleFailedRequest<T>(
		type: MessageSignature,
		token: vscode.CancellationToken | undefined,
		error: any,
		defaultValue: T,
		showNotification?: boolean,
	): T {
		if (type.method === "textDocument/documentSymbol") {
			if (
				error.message.includes("selectionRange must be contained in fullRange")
			) {
				log.warn(
					`Request failed for method "${type.method}", suppressing notification - see issue #820`
				);
				return super.handleFailedRequest(
					type,
					token,
					error,
					defaultValue,
					false
				);
			}
		}
		return super.handleFailedRequest(
			type,
			token,
			error,
			defaultValue,
			showNotification
		);
	}

	private request_filter(message: RequestMessage) {
		if (this.rejected) {
			if (message.method === "shutdown") {
				return message;
			}
			return false;
		}

		// Store message with timestamp for performance tracking
		this.sentMessages.set(message.id, {
			...message,
			timestamp: Date.now(),
		});

		// Log document sync operations for debugging connection performance issues
		if (message.method?.startsWith("textDocument/did")) {
			log.debug(`TX document sync: ${message.method}`);
		}

		// discard outgoing messages that we know aren't supported
		// if (message.method === "textDocument/didSave") {
		// 	return false;
		// }
		// if (message.method === "textDocument/willSaveWaitUntil") {
		// 	return false;
		// }
		if (message.method === "workspace/didChangeWatchedFiles") {
			return false;
		}
		if (message.method === "workspace/symbol") {
			// Fixed on server side since Godot 4.5
			return false;
		}

		return message;
	}

	private async response_filter(message: ResponseMessage) {
		const sentMessage = this.sentMessages.get(message.id);
		// Clean up processed request to prevent memory leak
		this.sentMessages.delete(message.id);

		// Log slow LSP operations for debugging performance issues
		if (sentMessage?.timestamp) {
			const elapsed = Date.now() - sentMessage.timestamp;
			const method = sentMessage.method || "unknown";

			if (elapsed > 1000) {
				log.warn(`Slow LSP response: ${method} took ${elapsed}ms`);
			}
		}

		if (sentMessage?.method === "textDocument/hover") {
			// fix markdown contents
			let value: string = (message as HoverResponseMesssage).result.contents.value;
			if (value) {
				// this is a dirty hack to fix language server sending us prerendered
				// markdown but not correctly stripping leading #'s, leading to
				// docstrings being displayed as titles
				value = value.replace(/\n[#]+/g, "\n");

				// fix bbcode line breaks
				value = value.replaceAll("`br`", "\n\n");

				// fix bbcode code boxes
				value = value.replace("`codeblocks`", "");
				value = value.replace("`/codeblocks`", "");
				value = value.replace("`gdscript`", "\nGDScript:\n```gdscript");
				value = value.replace("`/gdscript`", "```");
				value = value.replace("`csharp`", "\nC#:\n```csharp");
				value = value.replace("`/csharp`", "```");

				(message as HoverResponseMesssage).result.contents.value = value;
			}
		} else if (sentMessage?.method === "textDocument/documentLink") {
			const results: DocumentLinkResult[] = (
				message as DocumentLinkResponseMessage
			).result;

			if (!results) {
				return message;
			}

			// Collect all UIDs that need resolution
			const uidsToResolve: string[] = [];
			for (const result of results) {
				if (result.target.startsWith("uid://")) {
					uidsToResolve.push(result.target);
				}
			}

			// Batch resolve UIDs (uses caching internally)
			if (uidsToResolve.length > 0) {
				try {
					const { convert_uids_to_uris } = await import("../utils/index.js");
					const resolvedUris = await convert_uids_to_uris(uidsToResolve);

					// Apply resolved URIs to results
					for (const result of results) {
						if (result.target.startsWith("uid://")) {
							const fileUri = resolvedUris.get(result.target);
							if (fileUri) {
								// Get res:// path for tooltip
								const resourcePath = await convert_uri_to_resource_path(fileUri);
								result.target = fileUri.toString();
								result.tooltip = resourcePath || result.target;
							}
						}
					}
				} catch (e) {
					log.warn("Failed to resolve UIDs:", e);
				}
			}
		}

		return message;
	}

	private async check_workspace(message: ChangeWorkspaceNotification) {
		const server_path = path.normalize(message.params.path);
		const client_path = path.normalize(await get_project_dir());
		if (server_path !== client_path) {
			log.warn("Connected LSP is a different workspace");
			this.io.socket.resetAndDestroy();
			this.rejected = true;
		}
	}

	private notification_filter(message: NotificationMessage) {
		if (message.method === "gdscript_client/changeWorkspace") {
			this.check_workspace(message as ChangeWorkspaceNotification);
		}
		if (message.method === "gdscript/capabilities") {
			globals.docsProvider.register_capabilities(message);
			// Signal to the connection manager that LSP is fully initialized
			globals.lsp.onCapabilitiesReceived();
		}

		// if (message.method === "textDocument/publishDiagnostics") {
		// 	for (const diagnostic of message.params.diagnostics) {
		// 		if (diagnostic.code === 6) {
		// 			log.debug("UNUSED_SIGNAL", diagnostic);
		//             return;
		// 		}
		// 		if (diagnostic.code === 2) {
		// 			log.debug("UNUSED_VARIABLE", diagnostic);
		//             return;
		// 		}
		// 	}
		// }

		return message;
	}

	public async get_symbol_at_position(
		uri: vscode.Uri,
		position: vscode.Position
	) {
		const params = {
			textDocument: { uri: uri.toString() },
			position: { line: position.line, character: position.character },
		};
		const response = await this.send_request("textDocument/hover", params);
		return this.parse_hover_result(response as HoverResult);
	}

	private parse_hover_result(message: HoverResult) {
		const contents = message.contents;

		let decl: string;
		if (Array.isArray(contents)) {
			decl = contents[0];
		} else {
			decl = contents.value;
		}
		if (!decl) {
			return "";
		}
		decl = decl.split("\n")[0].trim();

		let match: RegExpMatchArray;
		let result = undefined;
		match = decl.match(/(?:func|const) (@?\w+)\.(\w+)/);
		if (match) {
			result = `${match[1]}.${match[2]}`;
		}

		match = decl.match(/<Native> class (\w+)/);
		if (match) {
			result = `${match[1]}`;
		}

		return result;
	}

	private on_connected() {
		this.status = ClientStatus.CONNECTED;

		const host = get_configuration("lsp.serverHost");
		log.info(`connected to LSP at ${host}:${this.lastPortTried}`);
	}

	private on_disconnected() {
		if (this.rejected) {
			this.status = ClientStatus.REJECTED;
			return;
		}
		// NOTE: Port fallback (6005 -> 6008) is now handled by ClientConnectionManager
		// to avoid duplicate connection attempts when both the client and manager try to reconnect
		this.status = ClientStatus.DISCONNECTED;
	}
}
