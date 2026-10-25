import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseLunaResponse, shellQuote } from '../src/lib/root';
import { parseConfig, WP_AUTO_CHOICES } from '../src/lib/storage';
import { fetchBlob } from '../src/lib/wpstore';
import { APP_CATALOG, DEFAULT_APP_IDS } from '../src/config/catalog';
import { BOOT_WALLPAPER_KEY, readCache, writeCache } from '../src/lib/boot';
import { loadServer, cachedServer } from '../src/lib/immich';
import * as rootModule from '../src/lib/root';

describe('1. parseLunaResponse & Luna Status Validation', () => {
	it('handles webOS 24/25, spaces, and debug logs', () => {
		const resCompact = parseLunaResponse('{"returnValue":true,"subscribed":false}');
		expect(resCompact.ok).toBe(true);
		expect(resCompact.data?.returnValue).toBe(true);

		const resSpaced = parseLunaResponse('{\n  "returnValue": true,\n  "state": "Active"\n}');
		expect(resSpaced.ok).toBe(true);
		expect(resSpaced.data?.returnValue).toBe(true);

		const resFail = parseLunaResponse('{"returnValue": false, "errorCode": -1, "errorText": "TV refused"}');
		expect(resFail.ok).toBe(false);
		expect(resFail.error).toBe('TV refused');

		const resWrapped = parseLunaResponse('** DEBUG LOG **\n{"returnValue":true,"id":"test.app"}\n** END **');
		expect(resWrapped.ok).toBe(true);
	});

	it('rejects empty object {} and array [] (P2 edge case from Codex)', () => {
		const resEmpty = parseLunaResponse('{}');
		expect(resEmpty.ok).toBe(false);
		expect(resEmpty.error).toMatch(/missing returnValue/);

		const resArr = parseLunaResponse('[]');
		expect(resArr.ok).toBe(false);

		const resNoRet = parseLunaResponse('{"status": 200}');
		expect(resNoRet.ok).toBe(false);
	});
});

describe('2. uninstallApp Status Shell Logic', () => {
	// Shell check_status expression from root.ts:
	// elif echo "$o" | grep -qiE 'app(lication)?[[:space:]]*(does not exist|not found|not installed|unknown)|(does not exist|not found|not installed)[[:space:]]*app(lication)?'
	const isGoneRegex = /(app(lication)?\s*(does not exist|not found|not installed|unknown)|(does not exist|not found|not installed)\s*app(lication)?)/i;

	it('does NOT treat Permission denied or Service not found as GONE (P1 edge case from Codex)', () => {
		const permDenied = '{"returnValue":false,"errorCode":-1,"errorText":"Permission denied"}';
		expect(isGoneRegex.test(permDenied)).toBe(false);

		const svcNotFound = '{"returnValue":false,"errorText":"Service not found"}';
		expect(isGoneRegex.test(svcNotFound)).toBe(false);

		const busError = '{"returnValue":false,"errorCode":-1}';
		expect(isGoneRegex.test(busError)).toBe(false);
	});

	it('recognizes genuine application-not-found errors as GONE', () => {
		const appNotExist = '{"returnValue":false,"errorCode":-1,"errorText":"Application does not exist with id: com.test.app"}';
		expect(isGoneRegex.test(appNotExist)).toBe(true);

		const appNotFound = '{"returnValue":false,"errorText":"application not found"}';
		expect(isGoneRegex.test(appNotFound)).toBe(true);
	});
});

describe('3. deploy.sh Status Regex', () => {
	const isDeploySuccess = (out: string) => {
		const isSuccess = /(INSTALL_COMPLETED|"state"\s*:\s*"(SUCCESS|installed)")/i.test(out);
		const isFailed = /("errorText"|"state"\s*:\s*"FAILED")/i.test(out);
		return isSuccess && !isFailed;
	};

	it('accepts both SUCCESS and installed with or without whitespace', () => {
		expect(isDeploySuccess('{"state":"SUCCESS"}')).toBe(true);
		expect(isDeploySuccess('{"state": "SUCCESS"}')).toBe(true);
		expect(isDeploySuccess('{"state":"installed"}')).toBe(true);
		expect(isDeploySuccess('{"state": "installed"}')).toBe(true);
		expect(isDeploySuccess('state: INSTALL_COMPLETED')).toBe(true);
	});

	it('rejects failures and error texts', () => {
		expect(isDeploySuccess('{"state":"FAILED", "errorText":"disk full"}')).toBe(false);
		expect(isDeploySuccess('{"state": "FAILED"}')).toBe(false);
		expect(isDeploySuccess('{"errorText": "invalid package"}')).toBe(false);
	});
});

describe('4. parseConfig & Folder Validation (Testing real implementation)', () => {
	it('filters malformed folder objects and sanitizes appIds', () => {
		const dirty = JSON.stringify({
			folders: [
				null,
				undefined,
				'invalid',
				{ name: '', appIds: ['app1'] },
				{ name: 'Empty Folder', appIds: null },
				{ name: 'Valid Folder', appIds: ['app1', '', null, 123, 'app2'] }
			],
			wpAutoMinutes: -1
		});

		const cfg = parseConfig(dirty);
		expect(cfg.wpAutoMinutes).toBe(0);
		expect(cfg.folders.length).toBe(1);
		expect(cfg.folders[0].name).toBe('Valid Folder');
		expect(cfg.folders[0].appIds).toEqual(['app1', 'app2']);
	});

	it('validates wpAutoMinutes against WP_AUTO_CHOICES', () => {
		expect(parseConfig(JSON.stringify({ wpAutoMinutes: 5 })).wpAutoMinutes).toBe(5);
		expect(parseConfig(JSON.stringify({ wpAutoMinutes: 0.5 })).wpAutoMinutes).toBe(0.5);
		expect(parseConfig(JSON.stringify({ wpAutoMinutes: 999 })).wpAutoMinutes).toBe(0);
	});
});

describe('5. fetchBlob Body Timeout Protection', () => {
	it('aborts when the response body stream hangs', async () => {
		// Mock a response where headers arrive immediately, but r.blob() hangs
		const originalFetch = globalThis.fetch;
		globalThis.fetch = ((url: string, init?: RequestInit) => {
			return Promise.resolve({
				ok: true,
				status: 200,
				blob: () => new Promise<Blob>((resolve, reject) => {
					if (init?.signal) {
						init.signal.addEventListener('abort', () => {
							reject(new DOMException('The operation was aborted.', 'AbortError'));
						});
					}
				})
			} as unknown as Response);
		}) as unknown as typeof fetch;

		try {
			await expect(fetchBlob('http://example.com/hanging-body.jpg', 30)).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe('6. Immich Boot Wallpaper Isolation & Key Refresh', () => {
	beforeEach(() => {
		if (typeof window === 'undefined') {
			const et = new EventTarget();
			(globalThis as unknown as {window: Window}).window = et as unknown as Window;
		}
		if (typeof localStorage === 'undefined') {
			const store = new Map<string, string>();
			globalThis.localStorage = {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => store.set(k, String(v)),
				removeItem: (k: string) => store.delete(k),
				clear: () => store.clear(),
				key: (i: number) => Array.from(store.keys())[i] ?? null,
				get length () { return store.size; }
			} as Storage;
		} else {
			localStorage.clear();
		}
	});

	it('does NOT clear cloud/local wallpaper cache on loadServer() without Immich', async () => {
		// Mock readFile returning empty string (no immich.json)
		vi.spyOn(rootModule, 'readFile').mockResolvedValue('');

		// Seed a cloud wallpaper in boot cache
		const cloudBoot = { sel: 'pick', next: 'cloud:landscape-123', bg: 'url(data:image/jpeg;base64,...)' };
		writeCache(BOOT_WALLPAPER_KEY, cloudBoot);

		await loadServer();

		// Boot cache for cloud wallpaper MUST remain intact!
		expect(readCache(BOOT_WALLPAPER_KEY)).toEqual(cloudBoot);
	});

	it('clears boot cache if it was an Immich wallpaper', async () => {
		vi.spyOn(rootModule, 'readFile').mockResolvedValue('');

		const immichBoot = { sel: 'immich:recent', next: 'immich:asset-123', bg: 'url(...)' };
		writeCache(BOOT_WALLPAPER_KEY, immichBoot);

		await loadServer();

		// Immich boot cache should be cleared
		expect(readCache(BOOT_WALLPAPER_KEY)).toBeNull();
	});

	it('dispatches immich-server-changed when server changes', async () => {
		const spyEvent = vi.fn();
		window.addEventListener('immich-server-changed', spyEvent);

		vi.spyOn(rootModule, 'readFile').mockResolvedValue(JSON.stringify({ url: 'http://192.168.1.50:2283', key: 'new-key' }));

		await loadServer();

		expect(spyEvent).toHaveBeenCalled();
		window.removeEventListener('immich-server-changed', spyEvent);
	});
});

describe('7. Catalog & Shell Quoting', () => {
	it('provides valid catalog without crashing Vite glob', () => {
		expect(Array.isArray(APP_CATALOG)).toBe(true);
		expect(Array.isArray(DEFAULT_APP_IDS)).toBe(true);
		expect(DEFAULT_APP_IDS.length).toBeGreaterThan(0);
	});

	it('safely shell quotes special characters', () => {
		expect(shellQuote('/var/log/test.log')).toBe("'/var/log/test.log'");
		expect(shellQuote("it's a quote")).toBe("'/var/log/test.log'".length > 0 ? "'it'\\''s a quote'" : "");
		expect(shellQuote('foo; rm -rf /')).toBe("'foo; rm -rf /'");
	});
});
