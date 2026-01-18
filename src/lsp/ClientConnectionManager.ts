import * as vscode from "vscode";

import {
	createLogger,
	get_configuration,
	get_free_port,
	get_project_dir,
	get_project_version,
	register_command,
	set_configuration,
	set_context,
	verify_godot_version,
} from "../utils";
import { prompt_for_godot_executable, prompt_for_reload, select_godot_executable } from "../utils/prompts";
import { killSubProcesses, subProcess } from "../utils/subspawn";
import GDScriptLanguageClient, { ClientStatus, TargetLSP } from "./GDScriptLanguageClient";
import { EventEmitter } from "vscode";

const log = createLogger("lsp.manager", { output: "Godot LSP" });

export enum ManagerStatus {
	INITIALIZING = 0,
	INITIALIZING_LSP = 1,
	PENDING = 2,
	PENDING_LSP = 3,
	DISCONNECTED = 4,
	CONNECTED = 5,
	RETRYING = 6,
	WRONG_WORKSPACE = 7,
	INITIALIZING_CLIENT = 8,  // After socket connect, before LSP handshake completes
}

export class ClientConnectionManager {
	public client: GDScriptLanguageClient = null;

	private statusChanged = new EventEmitter<ManagerStatus>();
	onStatusChanged = this.statusChanged.event;

	// Lifecycle events for providers to listen to
	private lspReady = new EventEmitter<void>();
	onLSPReady = this.lspReady.event;

	private lspDisconnected = new EventEmitter<void>();
	onLSPDisconnected = this.lspDisconnected.event;

	// Flag to track if capabilities have been received
	private capabilitiesReceived = false;
	private capabilitiesResolver: (() => void) | null = null;

	private reconnectionAttempts = 0;

	private target: TargetLSP = TargetLSP.EDITOR;
	private status: ManagerStatus = ManagerStatus.INITIALIZING;
	private statusWidget: vscode.StatusBarItem = null;

	private connectedVersion = "";
	private retryIntervalId: ReturnType<typeof setInterval> | null = null;

	constructor(private context: vscode.ExtensionContext) {
		this.create_new_client();

		this.retryIntervalId = setInterval(() => {
			this.retry_callback();
		}, get_configuration("lsp.autoReconnect.cooldown"));

		set_context("connectedToLSP", false);

		this.statusWidget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
		this.statusWidget.command = "godotTools.checkStatus";
		this.statusWidget.show();
		this.update_status_widget();

		context.subscriptions.push(
			register_command("startLanguageServer", () => {
				// TODO: this might leave the manager in a wierd state
				this.start_language_server();
				this.reconnectionAttempts = 0;
				this.target = TargetLSP.HEADLESS;
				this.client.connect(this.target);
			}),
			register_command("stopLanguageServer", this.stop_language_server.bind(this)),
			register_command("checkStatus", this.on_status_item_click.bind(this)),
			this.statusWidget,
			// Clean up interval on extension deactivation
			{ dispose: () => {
				if (this.retryIntervalId) {
					clearInterval(this.retryIntervalId);
					this.retryIntervalId = null;
				}
			}},
		);

		this.connect_to_language_server();
	}

	private async create_new_client() {
		const port = this.client?.port ?? -1;

		// CRITICAL: Clean up the old client BEFORE creating a new one
		// This ensures vscode-languageclient properly disposes internal handlers
		// and the new client's needsStart() returns true for proper initialization
		if (this.client) {
			// First, clean up all internal state (sentMessages, io handlers, filters, socket)
			// This prevents listener accumulation and stale state that causes slow performance
			this.client.disposeClient();

			// Use dispose() instead of stop() - dispose() properly marks the client
			// as disposed and prevents any lingering state from affecting new clients
			// dispose() internally calls stop() but also sets _disposed flag
			try {
				await this.client.dispose();
				log.info("Old LSP client disposed");
			} catch (e) {
				// Log error but continue - the client might be in a bad state
				log.warn("Error disposing old LSP client (may be in unexpected state):", e);
			}
		}

		this.client = new GDScriptLanguageClient();
		this.client.port = port;
		this.client.events.on("status", this.on_client_status_changed.bind(this));
	}

	private async connect_to_language_server() {
		this.client.port = -1;
		this.target = TargetLSP.EDITOR;
		this.connectedVersion = undefined;

		if (get_configuration("lsp.headless")) {
			this.target = TargetLSP.HEADLESS;
			await this.start_language_server();
		}

		this.reconnectionAttempts = 0;
		this.client.connect(this.target);
	}

	private stop_language_server() {
		killSubProcesses("LSP");
	}

	private async start_language_server() {
		this.stop_language_server();

		const projectDir = await get_project_dir();
		if (!projectDir) {
			vscode.window.showErrorMessage("Current workspace is not a Godot project");
			return;
		}

		const projectVersion = await get_project_version();
		let minimumVersion = "6";
		let targetVersion = "3.6";
		if (projectVersion.startsWith("4")) {
			minimumVersion = "2";
			targetVersion = "4.2";
		}
		const settingName = `editorPath.godot${projectVersion[0]}`;
		let godotPath = get_configuration(settingName);

		const result = verify_godot_version(godotPath, projectVersion[0]);
		godotPath = result.godotPath;

		switch (result.status) {
			case "WRONG_VERSION": {
				const message = `Cannot launch headless LSP: The current project uses Godot v${projectVersion}, but the specified Godot executable is v${result.version}`;
				prompt_for_godot_executable(message, settingName);
				return;
			}
			case "INVALID_EXE": {
				const message = `Cannot launch headless LSP: '${godotPath}' is not a valid Godot executable`;
				prompt_for_godot_executable(message, settingName);
				return;
			}
		}
		this.connectedVersion = result.version;

		if (result.version[2] < minimumVersion) {
			const message = `Cannot launch headless LSP: Headless LSP mode is only available on v${targetVersion} or newer, but the specified Godot executable is v${result.version}.`;
			vscode.window
				.showErrorMessage(message, "Select Godot executable", "Open Settings", "Disable Headless LSP", "Ignore")
				.then((item) => {
					if (item === "Select Godot executable") {
						select_godot_executable(settingName);
					} else if (item === "Open Settings") {
						vscode.commands.executeCommand("workbench.action.openSettings", settingName);
					} else if (item === "Disable Headless LSP") {
						set_configuration("lsp.headless", false);
						prompt_for_reload();
					}
				});
			return;
		}

		this.client.port = await get_free_port();

		log.info(`starting headless LSP on port ${this.client.port}`);

		const headlessFlags = "--headless --no-window";
		const command = `"${godotPath}" --path "${projectDir}" --editor ${headlessFlags} --lsp-port ${this.client.port}`;
		const lspProcess = subProcess("LSP", command, { shell: true, detached: true });

		const lspStdout = createLogger("lsp.stdout");
		lspProcess.stdout.on("data", (data) => {
			const out = data.toString().trim();
			if (out) {
				lspStdout.debug(out);
			}
		});

		// const lspStderr = createLogger("lsp.stderr");
		lspProcess.stderr.on("data", (data) => {
			// const out = data.toString().trim();
			// if (out) {
			// 	lspStderr.debug(out);
			// }
		});

		lspProcess.on("close", (code) => {
			log.info(`LSP process exited with code ${code}`);
		});
	}

	private get_lsp_connection_string() {
		const host = get_configuration("lsp.serverHost");
		let port = get_configuration("lsp.serverPort");
		if (this.client.port !== -1) {
			port = this.client.port;
		}
		return `${host}:${port}`;
	}

	private on_status_item_click() {
		const lspTarget = this.get_lsp_connection_string();
		// TODO: fill these out with the ACTIONS a user could perform in each state
		switch (this.status) {
			case ManagerStatus.INITIALIZING:
				// vscode.window.showInformationMessage("Initializing extension");
				break;
			case ManagerStatus.INITIALIZING_LSP:
				// vscode.window.showInformationMessage("Initializing LSP");
				break;
			case ManagerStatus.PENDING:
				// vscode.window.showInformationMessage(`Connecting to the GDScript language server at ${lspTarget}`);
				break;
			case ManagerStatus.CONNECTED: {
				const message = `Connected to the GDScript language server at ${lspTarget}.`;

				let options = ["Ok"];
				if (this.target === TargetLSP.HEADLESS) {
					options = ["Restart LSP", ...options];
				}
				vscode.window.showInformationMessage(message, ...options).then((item) => {
					if (item === "Restart LSP") {
						this.connect_to_language_server();
					}
				});
				break;
			}
			case ManagerStatus.DISCONNECTED:
				this.retry_connect_client();
				break;
			case ManagerStatus.RETRYING:
				this.show_retrying_prompt();
				break;
			case ManagerStatus.WRONG_WORKSPACE:
				this.retry_connect_client();
				break;
		}
	}

	private update_status_widget() {
		const lspTarget = this.get_lsp_connection_string();
		const maxAttempts = get_configuration("lsp.autoReconnect.attempts");
		let text = "";
		let tooltip = "";
		switch (this.status) {
			case ManagerStatus.INITIALIZING:
				text = "$(sync~spin) Initializing";
				tooltip = "Initializing extension...";
				break;
			case ManagerStatus.INITIALIZING_LSP:
				text = `$(sync~spin) Initializing LSP ${this.reconnectionAttempts}/${maxAttempts}`;
				tooltip = `Connecting to headless GDScript language server.\n${lspTarget}`;
				if (this.connectedVersion) {
					tooltip += `\n${this.connectedVersion}`;
				}
				break;
			case ManagerStatus.PENDING:
				text = "$(sync~spin) Connecting";
				tooltip = `Connecting to the GDScript language server at ${lspTarget}`;
				break;
			case ManagerStatus.CONNECTED:
				text = "$(check) Connected";
				tooltip = `Connected to the GDScript language server.\n${lspTarget}`;
				if (this.connectedVersion) {
					tooltip += `\nGodot version: ${this.connectedVersion}`;
				}
				break;
			case ManagerStatus.DISCONNECTED:
				text = "$(x) Disconnected";
				tooltip = "Disconnected from the GDScript language server.";
				break;
			case ManagerStatus.RETRYING:
				text = `$(sync~spin) Connecting ${this.reconnectionAttempts}/${maxAttempts}`;
				tooltip = `Connecting to the GDScript language server.\n${lspTarget}`;
				if (this.connectedVersion) {
					tooltip += `\n${this.connectedVersion}`;
				}
				break;
			case ManagerStatus.WRONG_WORKSPACE:
				text = "$(x) Wrong Project";
				tooltip = "Disconnected from the GDScript language server.";
				break;
			case ManagerStatus.INITIALIZING_CLIENT:
				text = "$(sync~spin) Initializing...";
				tooltip = `Initializing LSP connection to ${lspTarget}`;
				if (this.connectedVersion) {
					tooltip += `\nGodot version: ${this.connectedVersion}`;
				}
				break;
		}
		this.statusWidget.text = text;
		this.statusWidget.tooltip = tooltip;
	}

	private async on_client_status_changed(status: ClientStatus) {
		switch (status) {
			case ClientStatus.PENDING:
				this.status = ManagerStatus.PENDING;
				break;
			case ClientStatus.CONNECTED:
				// Reset capabilities flag for new connection
				this.capabilitiesReceived = false;
				this.capabilitiesResolver = null;

				// Show initializing status while we start the client
				this.status = ManagerStatus.INITIALIZING_CLIENT;
				this.statusChanged.fire(this.status);
				this.update_status_widget();

				if (this.client.needsStart()) {
					try {
						// Await the client start - this does the LSP initialize handshake
						await this.client.start();
						log.info("LSP Client started, waiting for capabilities...");

						// Wait for capabilities with 30 second timeout
						await this.waitForCapabilities(30000);
						log.info("LSP capabilities received");

						// Now we're fully connected
						this.retry = false;
						this.reconnectionAttempts = 0;
						set_context("connectedToLSP", true);
						this.status = ManagerStatus.CONNECTED;
						this.lspReady.fire();
					} catch (error) {
						log.warn(`LSP initialization issue: ${error.message}`);
						// Still set connected but some features may be limited
						this.retry = false;
						this.reconnectionAttempts = 0;
						set_context("connectedToLSP", true);
						this.status = ManagerStatus.CONNECTED;
						this.lspReady.fire();
					}
				} else {
					// Client already started, just update status
					this.retry = false;
					this.reconnectionAttempts = 0;
					set_context("connectedToLSP", true);
					this.status = ManagerStatus.CONNECTED;
				}
				break;
			case ClientStatus.DISCONNECTED:
				// Fire disconnected event BEFORE creating new client so providers can reset
				set_context("connectedToLSP", false);
				this.lspDisconnected.fire();

				// Disconnection is unrecoverable, since the server will not know that the reconnected client is the same.
				// Create a new client with a clean state to prevent de-sync e.g. of client managed files.
				await this.create_new_client();

				// Reset capabilities state
				this.capabilitiesReceived = false;
				this.capabilitiesResolver = null;

				if (this.retry) {
					if (this.client.port !== -1) {
						this.status = ManagerStatus.INITIALIZING_LSP;
					} else {
						this.status = ManagerStatus.RETRYING;
					}
				} else {
					this.status = ManagerStatus.DISCONNECTED;
				}
				this.retry = true;
				break;
			case ClientStatus.REJECTED:
				this.status = ManagerStatus.WRONG_WORKSPACE;
				this.retry = false;
				break;
			default:
				break;
		}
		this.statusChanged.fire(this.status);
		this.update_status_widget();
	}

	private retry = false;

	/**
	 * Called by the documentation provider when LSP capabilities are received.
	 * This signals that the LSP is fully initialized.
	 */
	public onCapabilitiesReceived() {
		this.capabilitiesReceived = true;
		if (this.capabilitiesResolver) {
			this.capabilitiesResolver();
			this.capabilitiesResolver = null;
		}
	}

	/**
	 * Waits for LSP capabilities to be received, with a timeout.
	 * @param timeoutMs Timeout in milliseconds (default 30 seconds)
	 */
	private waitForCapabilities(timeoutMs = 30000): Promise<void> {
		return new Promise((resolve, reject) => {
			// If already received, resolve immediately
			if (this.capabilitiesReceived) {
				resolve();
				return;
			}

			// Set up timeout
			const timeoutId = setTimeout(() => {
				this.capabilitiesResolver = null;
				reject(new Error(`LSP capabilities timeout after ${timeoutMs}ms`));
			}, timeoutMs);

			// Set up resolver
			this.capabilitiesResolver = () => {
				clearTimeout(timeoutId);
				resolve();
			};
		});
	}

	private retry_callback() {
		if (this.retry) {
			this.retry_connect_client();
		}
	}

	private retry_connect_client() {
		const autoRetry = get_configuration("lsp.autoReconnect.enabled");
		const maxAttempts = get_configuration("lsp.autoReconnect.attempts");
		if (autoRetry && this.reconnectionAttempts <= maxAttempts - 1) {
			this.reconnectionAttempts++;
			// Alternate ports on each retry attempt (6005 <-> 6008) for Godot version compatibility
			const tryAlternatePort = this.reconnectionAttempts % 2 === 0;
			this.client.connect(this.target, tryAlternatePort);
			this.retry = true;
			return;
		}

		this.retry = false;
		this.status = ManagerStatus.DISCONNECTED;
		this.update_status_widget();

		this.show_retrying_prompt();
	}

	private show_retrying_prompt() {
		const lspTarget = this.get_lsp_connection_string();
		const message = `Couldn't connect to the GDScript language server at ${lspTarget}. Is the Godot editor or language server running?`;

		let options = ["Retry", "Ignore"];
		if (this.target === TargetLSP.EDITOR) {
			options = ["Open workspace with Godot Editor", ...options];
		}

		vscode.window.showErrorMessage(message, ...options).then((item) => {
			if (item === "Retry") {
				this.connect_to_language_server();
			}
			if (item === "Open workspace with Godot Editor") {
				vscode.commands.executeCommand("godotTools.openEditor");
				this.connect_to_language_server();
			}
		});
	}
}
