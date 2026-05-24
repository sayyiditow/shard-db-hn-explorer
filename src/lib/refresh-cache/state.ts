/** Persist last_seen_id between process restarts. A single JSON file
 *  at the project root keeps things simple — the systemd unit just
 *  needs WorkingDirectory= set so the file lands consistently.
 *
 *  Uses node:fs/promises rather than Bun.* APIs so it runs in both
 *  the Bun test runtime AND SvelteKit's Vite dev server (Node.js). */

import { readFile, writeFile } from 'node:fs/promises';

export const STATE_PATH = '.hn-refresh-state.json';

interface StateFile {
    last_seen_id: number;
}

export async function read(): Promise<number> {
    try {
        const text = await readFile(STATE_PATH, 'utf8');
        const parsed = JSON.parse(text) as StateFile;
        return typeof parsed.last_seen_id === 'number' ? parsed.last_seen_id : 0;
    } catch {
        // Missing file (ENOENT) or unparseable JSON → start from 0.
        return 0;
    }
}

export async function write(last_seen_id: number): Promise<void> {
    await writeFile(STATE_PATH, JSON.stringify({ last_seen_id }), 'utf8');
}
