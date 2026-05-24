/** Persist last_seen_id between process restarts. A single JSON file
 *  at the project root keeps things simple — the systemd unit just
 *  needs WorkingDirectory= set so the file lands consistently. */

export const STATE_PATH = '.hn-refresh-state.json';

interface StateFile {
    last_seen_id: number;
}

export async function read(): Promise<number> {
    try {
        const f = Bun.file(STATE_PATH);
        if (!(await f.exists())) return 0;
        const parsed = JSON.parse(await f.text()) as StateFile;
        return typeof parsed.last_seen_id === 'number' ? parsed.last_seen_id : 0;
    } catch {
        return 0;
    }
}

export async function write(last_seen_id: number): Promise<void> {
    await Bun.write(STATE_PATH, JSON.stringify({ last_seen_id }));
}
