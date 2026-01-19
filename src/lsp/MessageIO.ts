import {
	AbstractMessageReader,
	type MessageReader,
	type DataCallback,
	type Disposable,
	type RequestMessage,
	type ResponseMessage,
	type NotificationMessage,
	AbstractMessageWriter,
	type MessageWriter,
} from "vscode-jsonrpc";
import { EventEmitter } from "node:events";
import { Socket } from "net";
import MessageBuffer from "./MessageBuffer";
import { createLogger } from "../utils";

const log = createLogger("lsp.io", { output: "Godot LSP" });

export type Message = RequestMessage | ResponseMessage | NotificationMessage;

export class MessageIO extends EventEmitter {
	reader = new MessageIOReader(this);
	writer = new MessageIOWriter(this);

	requestFilter: (msg: RequestMessage) => RequestMessage | false = (msg) => msg;
	responseFilter: (msg: ResponseMessage) => Promise<ResponseMessage | false> | ResponseMessage | false = (msg) => msg;
	notificationFilter: (msg: NotificationMessage) => NotificationMessage | false = (msg) => msg;

	socket: Socket = null;
	messageCache: string[] = [];
	private draining = false;

	// Connection timeout in milliseconds (10 seconds - allows time for Godot to reload)
	private static readonly CONNECTION_TIMEOUT = 10000;
	// Keepalive interval in milliseconds (30 seconds)
	private static readonly KEEPALIVE_INTERVAL = 30000;
	// Maximum cached messages to prevent memory bloat
	private static readonly MAX_MESSAGE_CACHE = 100;

	async connect(host: string, port: number): Promise<void> {
		log.debug(`connecting to ${host}:${port}`);

		// Clean up existing socket before creating new one
		// This prevents socket leaks and ensures clean state on reconnection
		if (this.socket) {
			log.debug("Cleaning up existing socket before reconnect");
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}

		// Clear stale cached messages from previous failed connection attempts
		// These messages were intended for the old connection and should not be
		// sent to a fresh LSP server, as they may cause confusion or slowdowns
		if (this.messageCache.length > 0) {
			log.debug(`Clearing ${this.messageCache.length} stale cached messages`);
			this.messageCache = [];
		}

		return new Promise((resolve, reject) => {
			const socket = new Socket();

			// Set connection timeout - prevents hanging indefinitely if LSP is unresponsive
			const connectionTimeout = setTimeout(() => {
				log.warn(`Connection timeout after ${MessageIO.CONNECTION_TIMEOUT}ms`);
				socket.removeAllListeners();
				socket.destroy();
				reject(new Error(`Connection timeout after ${MessageIO.CONNECTION_TIMEOUT}ms`));
			}, MessageIO.CONNECTION_TIMEOUT);

			socket.connect(port, host);

			socket.on("connect", () => {
				clearTimeout(connectionTimeout);
				this.socket = socket;

				// Enable TCP keepalive to detect half-open connections
				// This allows detection of silent Godot crashes
				socket.setKeepAlive(true, MessageIO.KEEPALIVE_INTERVAL);

				// Set socket timeout for read/write operations
				socket.setTimeout(MessageIO.CONNECTION_TIMEOUT * 6); // 30 seconds for ongoing operations

				while (this.messageCache.length > 0) {
					const msg = this.messageCache.shift();
					this.socket.write(msg);
				}

				this.emit("connected");
				resolve();
			});

			socket.on("timeout", () => {
				log.warn("Socket timeout - connection may be stalled");
				// Don't destroy on timeout, just log it - keepalive will handle dead connections
			});

			socket.on("data", (chunk: Buffer) => {
				this.emit("data", chunk);
			});

			// Handle backpressure - resume when socket drains
			socket.on("drain", () => {
				this.draining = false;
			});

			socket.on("error", (err) => {
				clearTimeout(connectionTimeout);
				log.warn(`Socket error: ${err.message}`);
				// CRITICAL FIX: Destroy the LOCAL socket object, not this.socket
				// Previously, on connection error, this.socket was null (connect callback hadn't run)
				// so the new socket was never destroyed, causing socket leaks during retry cycles
				socket.removeAllListeners();
				socket.destroy();
				if (this.socket === socket) {
					this.socket = null;
				}
				this.emit("disconnected");
				reject(err);
			});

			socket.on("close", (hadError) => {
				clearTimeout(connectionTimeout);
				// CRITICAL FIX: Same as error handler - destroy the LOCAL socket
				socket.removeAllListeners();
				socket.destroy();
				if (this.socket === socket) {
					this.socket = null;
				}
				this.emit("disconnected");
				// Only reject if we never connected (resolve wasn't called)
				if (!this.socket) {
					reject(new Error("Connection closed before established"));
				}
			});
		});
	}

	write(message: string) {
		if (this.socket) {
			// Check for backpressure - if socket buffer is full, wait for drain
			if (this.draining) {
				// Still draining from previous write, queue the message
				if (this.messageCache.length < MessageIO.MAX_MESSAGE_CACHE) {
					this.messageCache.push(message);
				} else {
					log.warn("Message cache full, dropping message to prevent memory bloat");
				}
				return;
			}

			const canContinue = this.socket.write(message);
			if (!canContinue) {
				// Socket buffer is full, mark as draining
				this.draining = true;
			}
		} else {
			// Not connected, cache message (with limit)
			if (this.messageCache.length < MessageIO.MAX_MESSAGE_CACHE) {
				this.messageCache.push(message);
			} else {
				log.warn("Message cache full while disconnected, dropping message");
			}
		}
	}
}

export class MessageIOReader extends AbstractMessageReader implements MessageReader {
	callback: DataCallback;
	private buffer = new MessageBuffer(this);
	private listeners: { event: string; handler: (...args: any[]) => void }[] = [];

	constructor(public io: MessageIO) {
		super();
	}

	listen(callback: DataCallback): Disposable {
		// Clean up any existing listeners first
		this.disposeListeners();
		this.buffer.reset();

		this.callback = callback;

		// Track listeners for cleanup
		const dataHandler = this.on_data.bind(this);
		const errorHandler = this.fireError.bind(this);
		const closeHandler = this.fireClose.bind(this);

		this.io.on("data", dataHandler);
		this.io.on("error", errorHandler);
		this.io.on("close", closeHandler);

		this.listeners = [
			{ event: "data", handler: dataHandler },
			{ event: "error", handler: errorHandler },
			{ event: "close", handler: closeHandler },
		];

		// Return proper Disposable
		return {
			dispose: () => {
				this.disposeListeners();
			},
		};
	}

	public disposeListeners() {
		for (const { event, handler } of this.listeners) {
			this.io.off(event, handler);
		}
		this.listeners = [];
	}

	private on_data(data: Buffer | string): void {
		this.buffer.append(data);
		this.processMessages();
	}

	private async processMessages(): Promise<void> {
		while (true) {
			const msg = this.buffer.ready();
			if (!msg) {
				return;
			}
			const json = JSON.parse(msg);
			// allow message to be modified
			let modified: ResponseMessage | NotificationMessage | false;
			if ("id" in json) {
				modified = await this.io.responseFilter(json);
			} else if ("method" in json) {
				modified = this.io.notificationFilter(json);
			} else {
				log.warn("rx [unhandled]:", json);
			}

			if (modified === false) {
				log.debug("rx [discarded]:", json);
				return;
			}
			log.debug("rx:", modified);
			this.callback(json);
		}
	}
}

export class MessageIOWriter extends AbstractMessageWriter implements MessageWriter {
	private errorCount: number;

	constructor(public io: MessageIO) {
		super();
	}

	async write(msg: RequestMessage) {
		const modified = this.io.requestFilter(msg);
		if (modified === false) {
			log.debug("tx [discarded]:", msg);
			return;
		}
		log.debug("tx:", modified);
		const json = JSON.stringify(modified);

		const contentLength = Buffer.byteLength(json, "utf-8").toString();
		const message = `Content-Length: ${contentLength}\r\n\r\n${json}`;
		try {
			this.io.write(message);
			this.errorCount = 0;
		} catch (error) {
			this.errorCount++;
			this.fireError(error, modified, this.errorCount);
		}
	}

	end(): void {}
}
