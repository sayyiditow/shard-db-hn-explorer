import { describe, expect, test } from 'bun:test';
import { bulkInsert } from './bulk-load';

describe('bulkInsert', () => {
	test('continues after isolating a dropped record and logs its details', async () => {
		const valid = { key: 'valid', value: { title: 'accepted' } };
		const failing = { key: 'failing', value: { title: 'rejected', nested: { id: 7 } } };
		const queries: { records: typeof valid[] }[] = [];
		const logs: string[] = [];

		const stats = await bulkInsert('stories', [valid, failing], {
			query: async (body) => {
				const records = body.records as typeof valid[];
				queries.push({ records });
				if (records.length === 2 || records[0]?.key === failing.key) {
					return { error: 'some_records_dropped' };
				}
				return { inserted: records.length };
			},
			close: () => {}
		}, (message) => logs.push(message));

		expect(stats).toEqual({ inserted: 1, dropped: 1 });
		expect(queries.map(({ records }) => records.map(({ key }) => key))).toEqual([
			['valid', 'failing'],
			['valid'],
			['failing']
		]);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('object=stories');
		expect(logs[0]).toContain('key=failing');
		expect(logs[0]).toContain(JSON.stringify(failing));
		expect(logs[0]).toContain('error=some_records_dropped');
	});

	test('re-throws infrastructure errors instead of dropping records', async () => {
		await expect(bulkInsert('comments', [{ key: '1', value: {} }], {
			query: async () => ({ error: 'connection timeout' }),
			close: () => {}
		})).rejects.toThrow('bulk-insert comments failed: connection timeout');
	});
});
