import test from 'node:test';
import assert from 'node:assert/strict';

// 1. Helper function replicating parseLunaResponse logic from root.ts
function parseLunaResponse (text) {
	if (!text || !text.trim()) return {ok: false, data: null, error: 'empty response'};
	const clean = text.trim();
	try {
		const data = JSON.parse(clean);
		if (data && typeof data === 'object') {
			if (data.returnValue === false) return {ok: false, data, error: data.errorText || `error ${data.errorCode ?? 'unknown'}`};
			return {ok: true, data};
		}
	} catch {
		const match = clean.match(/\{[\s\S]*\}/);
		if (match) {
			try {
				const data = JSON.parse(match[0]);
				if (data && typeof data === 'object') {
					if (data.returnValue === false) return {ok: false, data, error: data.errorText || `error ${data.errorCode ?? 'unknown'}`};
					return {ok: true, data};
				}
			} catch { /* ignore */ }
		}
	}
	return {ok: false, data: null, error: 'invalid json response'};
}

// 2. Helper replicating parseConfig storage folder & wpAutoMinutes sanitization
const WP_AUTO_CHOICES = [0, 0.5, 1, 5, 15, 30, 60];

function sanitizeConfig (parsed) {
	return {
		wpAutoMinutes: WP_AUTO_CHOICES.indexOf(Number(parsed.wpAutoMinutes)) !== -1 ? Number(parsed.wpAutoMinutes) : 0,
		folders: Array.isArray(parsed.folders)
			? parsed.folders
				.filter((f) =>
					typeof f === 'object' && f !== null &&
					typeof f.name === 'string' && f.name.trim().length > 0 &&
					Array.isArray(f.appIds)
				)
				.map((f) => ({
					name: f.name.trim(),
					appIds: f.appIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
				}))
			: []
	};
}

// 3. Helper replicating Ambient.tsx cache sanitizer
function sanitizeAmbientCache (cached) {
	if (!cached) return null;
	if (cached.urls || JSON.stringify(cached).indexOf('apiKey=') !== -1) {
		return null; // purge old cache containing apiKey
	}
	return typeof cached.id === 'string' ? {id: cached.id, serverUrl: cached.serverUrl} : null;
}

// 4. Helper replicating shellQuote from root.ts
function shellQuote (s) {
	return `'${String(s).replace(/'/g, "'\\''")}'`;
}

test('parseLunaResponse handles webOS 24 and webOS 25 formats correctly', () => {
	// Standard webOS compact JSON
	const resCompact = parseLunaResponse('{"returnValue":true,"subscribed":false}');
	assert.equal(resCompact.ok, true);
	assert.equal(resCompact.data.returnValue, true);

	// webOS 25 JSON with whitespace
	const resSpaced = parseLunaResponse('{\n  "returnValue": true,\n  "state": "Active"\n}');
	assert.equal(resSpaced.ok, true);
	assert.equal(resSpaced.data.state, 'Active');

	// webOS 25 failure with space
	const resFailSpaced = parseLunaResponse('{"returnValue": false, "errorCode": -1, "errorText": "TV refused"}');
	assert.equal(resFailSpaced.ok, false);
	assert.equal(resFailSpaced.error, 'TV refused');

	// Wrapped in luna debug log text
	const resWrapped = parseLunaResponse('** DEBUG LOG **\n{"returnValue":true,"id":"test.app"}\n** END **');
	assert.equal(resWrapped.ok, true);
	assert.equal(resWrapped.data.id, 'test.app');

	// Empty and invalid
	assert.equal(parseLunaResponse('').ok, false);
	assert.equal(parseLunaResponse('not a json').ok, false);
});

test('sanitizeConfig validates folders and filters invalid entries', () => {
	const dirtyInput = {
		wpAutoMinutes: -1,
		folders: [
			null,
			undefined,
			'invalid',
			{name: '', appIds: ['app1']},
			{name: 'Empty Folder', appIds: null},
			{name: 'Valid Folder', appIds: ['app1', '', null, 123, 'app2']},
		]
	};

	const cleaned = sanitizeConfig(dirtyInput);
	assert.equal(cleaned.wpAutoMinutes, 0); // invalid -1 reset to 0
	assert.equal(cleaned.folders.length, 1);
	assert.equal(cleaned.folders[0].name, 'Valid Folder');
	assert.deepEqual(cleaned.folders[0].appIds, ['app1', 'app2']);

	// Valid wpAutoMinutes
	assert.equal(sanitizeConfig({wpAutoMinutes: 5}).wpAutoMinutes, 5);
	assert.equal(sanitizeConfig({wpAutoMinutes: 0.5}).wpAutoMinutes, 0.5);
	assert.equal(sanitizeConfig({wpAutoMinutes: 99}).wpAutoMinutes, 0);
});

test('sanitizeAmbientCache strips apiKey and purges old cache structure', () => {
	// Old cache format containing urls with apiKey
	const oldCache = {
		id: 'asset-123',
		urls: ['http://192.168.1.10:2283/api/assets/asset-123/thumbnail?size=preview&apiKey=secret123']
	};
	assert.equal(sanitizeAmbientCache(oldCache), null);

	// Malicious or leaked object
	const leakedObj = {id: 'asset-123', meta: 'apiKey=supersecret'};
	assert.equal(sanitizeAmbientCache(leakedObj), null);

	// New clean cache
	const cleanCache = {id: 'asset-123', serverUrl: 'http://192.168.1.10:2283'};
	const result = sanitizeAmbientCache(cleanCache);
	assert.deepEqual(result, cleanCache);
});

test('shellQuote safely wraps arguments', () => {
	assert.equal(shellQuote('/var/log/app.log'), "'/var/log/app.log'");
	assert.equal(shellQuote("it's cool"), "'it'\\''s cool'");
	assert.equal(shellQuote('foo; rm -rf /'), "'foo; rm -rf /'");
});
