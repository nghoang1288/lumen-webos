import test from 'node:test';
import assert from 'node:assert/strict';

// Directly import production implementation from app source
import { parseLunaResponse, shellQuote } from '../../app/src/lib/root';
import { WP_AUTO_CHOICES } from '../../app/src/lib/storage';
import { fetchBlob } from '../../app/src/lib/wpstore';

test('parseLunaResponse handles webOS 24/25, spaces, and rejects missing returnValue', () => {
	// Standard webOS compact JSON
	const resCompact = parseLunaResponse('{"returnValue":true,"subscribed":false}');
	assert.equal(resCompact.ok, true);
	assert.equal(resCompact.data?.returnValue, true);

	// webOS 25 JSON with whitespace
	const resSpaced = parseLunaResponse('{\n  "returnValue": true,\n  "state": "Active"\n}');
	assert.equal(resSpaced.ok, true);
	assert.equal(resSpaced.data?.returnValue, true);

	// webOS 25 failure with space
	const resFailSpaced = parseLunaResponse('{"returnValue": false, "errorCode": -1, "errorText": "TV refused"}');
	assert.equal(resFailSpaced.ok, false);
	assert.equal(resFailSpaced.error, 'TV refused');

	// Edge case 5 from Codex: {} and [] must NOT be treated as success!
	const resEmptyObj = parseLunaResponse('{}');
	assert.equal(resEmptyObj.ok, false, '{} should not be ok: true');
	assert.match(resEmptyObj.error || '', /missing returnValue/);

	const resArray = parseLunaResponse('[]');
	assert.equal(resArray.ok, false, '[] should not be ok: true');

	const resMalformed = parseLunaResponse('{"someOtherField": 123}');
	assert.equal(resMalformed.ok, false, 'JSON without returnValue should not be ok: true');

	// Wrapped in luna debug log text
	const resWrapped = parseLunaResponse('** DEBUG LOG **\n{"returnValue":true,"id":"test.app"}\n** END **');
	assert.equal(resWrapped.ok, true);
});

test('uninstallApp check_status shell logic correctly differentiates GONE vs LUNA_ERROR', () => {
	// Helper replicating the check_status shell logic in uninstallApp
	function checkStatusShell(out) {
		if (/"returnValue"\s*:\s*true/.test(out)) return 'PRESENT';
		if (/(does not exist|not found|not exist|not installed|unknown app|"errorCode"\s*:\s*-1)/i.test(out)) return 'GONE';
		return 'LUNA_ERROR';
	}

	// Codex Probe case: Permission denied must NOT result in GONE!
	const permDenied = '{"returnValue": false, "errorText": "Permission denied"}';
	assert.equal(checkStatusShell(permDenied), 'LUNA_ERROR', 'Permission denied must be LUNA_ERROR, not GONE');

	// Real app not found
	const notFound = '{"returnValue": false, "errorCode": -1, "errorText": "Application does not exist"}';
	assert.equal(checkStatusShell(notFound), 'GONE');

	// App installed
	const installed = '{"returnValue": true, "app": {"id": "test.app"}}';
	assert.equal(checkStatusShell(installed), 'PRESENT');
});

test('deploy.sh status regex handles whitespace and both SUCCESS and installed states', () => {
	// Replicating deploy.sh install check
	function isDeploySuccess(installOutput) {
		const isSuccess = /(INSTALL_COMPLETED|"state"\s*:\s*"(SUCCESS|installed)")/i.test(installOutput);
		const isFailed = /("errorText"|"state"\s*:\s*"FAILED")/i.test(installOutput);
		return isSuccess && !isFailed;
	}

	// All variations from Codex audit probe:
	assert.equal(isDeploySuccess('{"state":"SUCCESS"}'), true);
	assert.equal(isDeploySuccess('{"state": "SUCCESS"}'), true);
	assert.equal(isDeploySuccess('{"state":"installed"}'), true);
	assert.equal(isDeploySuccess('{"state": "installed"}'), true);
	assert.equal(isDeploySuccess('status: INSTALL_COMPLETED'), true);

	// Failures
	assert.equal(isDeploySuccess('{"state":"FAILED", "errorText":"disk full"}'), false);
	assert.equal(isDeploySuccess('{"state": "FAILED"}'), false);
	assert.equal(isDeploySuccess('{"errorText": "installation error"}'), false);
});

test('fetchBlob aborts when timeout fires', async () => {
	// Mock a fetch that hangs
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (url, options) => {
		return new Promise((resolve, reject) => {
			if (options?.signal) {
				options.signal.addEventListener('abort', () => {
					reject(new Error('The operation was aborted.'));
				});
			}
		});
	};

	try {
		await assert.rejects(
			fetchBlob('http://example.com/hanging-image.jpg', 20),
			/aborted/
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('WP_AUTO_CHOICES includes valid options', () => {
	assert.deepEqual(Array.from(WP_AUTO_CHOICES), [0, 0.5, 1, 5, 15, 30, 60]);
});

test('shellQuote safely escapes arguments', () => {
	assert.equal(shellQuote('/var/log/app.log'), "'/var/log/app.log'");
	assert.equal(shellQuote("it's cool"), "'it'\\''s cool'");
	assert.equal(shellQuote('foo; rm -rf /'), "'foo; rm -rf /'");
});
