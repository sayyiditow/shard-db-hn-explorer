import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { read, write, STATE_PATH } from './state';

describe('refresh state', () => {
    beforeEach(() => {
        if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    });
    afterEach(() => {
        if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    });

    test('read() returns 0 when state file is absent', async () => {
        expect(await read()).toBe(0);
    });

    test('write() then read() round-trips the id', async () => {
        await write(123456);
        expect(await read()).toBe(123456);
    });

    test('read() returns 0 on corrupted file', async () => {
        writeFileSync(STATE_PATH, 'not json at all', 'utf8');
        expect(await read()).toBe(0);
    });
});
