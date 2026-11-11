import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** Temp plus rename: a reader in another process must never see a torn file. */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
	const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, content, mode === undefined ? {} : { mode });
	renameSync(temp, path);
}

/**
 * Runs `run` while holding `lock`, a file only one process can create at a time, and removes it afterwards.
 * The lock is meant for a synchronous read and write, so one older than `staleMs` belongs to a process that died
 * holding it and is broken.
 */
export async function withFileLock<T>(lock: string, staleMs: number, run: () => T): Promise<T> {
	for (;;) {
		try {
			writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A lock that vanished since the failed create reads as fresh, and the next pass takes it.
			const heldSince = statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
			if (Date.now() - heldSince > staleMs) rmSync(lock, { force: true });
			await new Promise((resolve) => setTimeout(resolve, 5));
			continue;
		}
		try {
			return run();
		} finally {
			rmSync(lock, { force: true });
		}
	}
}
