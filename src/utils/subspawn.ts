/* 
Copied from https://github.com/craigwardman/subspawn
Original library copyright (c) 2022 Craig Wardman

I had to vendor this library to fix the API in a couple places.
*/

import { ChildProcess, execSync, spawn, SpawnOptions } from "node:child_process";
import { createLogger } from ".";

const log = createLogger("subspawn");

interface DictionaryOfStringChildProcessSet {
	[key: string]: Set<ChildProcess>;
}
const children: DictionaryOfStringChildProcessSet = {};

export function killSubProcesses(owner: string) {
	if (!(owner in children)) {
		return;
	}

	for (const c of Array.from(children[owner])) {
		try {
			if (c.pid) {
				if (process.platform === "win32") {
					execSync(`taskkill /pid ${c.pid} /T /F`);
				} else if (process.platform === "darwin") {
					execSync(`kill -9 ${c.pid}`);
				} else {
					process.kill(-c.pid);
				}
			}
		} catch {
			log.error(`couldn't kill task ${owner}`);
		}
	}

	children[owner].clear();
}

process.on("exit", () => {
	for (const owner of Object.keys(children)) {
		killSubProcesses(owner);
	}

	// Object.keys(children).forEach((owner) => killSubProcesses(owner));
});

function gracefulExitHandler() {
	process.exit();
}

process.on("SIGINT", gracefulExitHandler);
process.on("SIGTERM", gracefulExitHandler);
process.on("SIGQUIT", gracefulExitHandler);

export function subProcess(owner: string, command: string, options?: SpawnOptions) {
	const childProcess = spawn(command, options);

	children[owner] = children[owner] || new Set<ChildProcess>();
	children[owner].add(childProcess);

	const cleanup = () => {
		children[owner]?.delete(childProcess);
	};
	childProcess.once("exit", cleanup);
	childProcess.once("close", cleanup);

	return childProcess;
}
