#!/usr/bin/env node
/*
 * Connect page tests.
 *
 *   node umbrel/testing/connect-page-test.mjs
 *
 * app.js runs in a stubbed DOM with a programmable fetch, so the behaviours
 * that have actually broken in the field can be checked without a browser,
 * a container or a Bitcoin node.
 *
 * The element stub only answers for ids that genuinely appear in index.html
 * and throws for anything else, so a getElementById that the markup does not
 * back is a test failure rather than a silent null at runtime.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const connect = join(here, "..", "images", "nginx", "connect");

const html = readFileSync(join(connect, "index.html"), "utf8");
const appSource = readFileSync(join(connect, "js", "app.js"), "utf8");

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// Elements carrying a bare `hidden` attribute must start hidden in the stub
// too, or "absent until asked for" cannot be tested at all.
const hiddenIds = new Set(
	[...html.matchAll(/<[a-zA-Z0-9]+\b[^>]*>/g)]
		.map((m) => m[0])
		.filter((tag) => /\shidden(?=[\s/>])/.test(tag))
		.map((tag) => tag.match(/\bid="([^"]+)"/))
		.filter(Boolean)
		.map((m) => m[1])
);
const copyTargets = [...html.matchAll(/\bdata-copy="([^"]+)"/g)].map((m) => m[1]);
const revealTargets = [...html.matchAll(/\bdata-reveal="([^"]+)"/g)].map((m) => m[1]);

let passed = 0;
const failures = [];

function check(name, fn) {
	try {
		fn();
		passed += 1;
		process.stdout.write(`  \u001B[32mPASS\u001B[0m  ${name}\n`);
	} catch (error) {
		failures.push(name);
		process.stdout.write(`  \u001B[31mFAIL\u001B[0m  ${name}\n         ${error.message}\n`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ the DOM */

function makeElement(id) {
	const attributes = new Map();
	let markup = "";
	return {
		id,
		textContent: "",
		className: "",
		value: "",
		type: "text",
		hidden: hiddenIds.has(id),
		get innerHTML() { return markup; },
		set innerHTML(value) {
			markup = value;
			// Real innerHTML replaces the children; the stub must too, or
			// renderQr's clear-then-append looks like an append.
			if (this.children) this.children.length = 0;
		},
		open: false,
		disabled: false,
		style: {},
		children: [],
		listeners: {},
		setAttribute(name, value) { attributes.set(name, String(value)); },
		getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
		removeAttribute(name) { attributes.delete(name); },
		hasAttribute(name) { return attributes.has(name); },
		appendChild(child) { this.children.push(child); return child; },
		addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
		click() { (this.listeners.click || []).forEach((fn) => fn({})); },
		scrollIntoView() {},
		focus() {},
		select() {}
	};
}

function makeHarness({ onion = null, pairing = true } = {}) {
	const elements = new Map();
	const calls = { login: 0, status: 0, onion: 0, other: [] };
	let statusUnauthorizedOnce = false;

	const document = {
		getElementById(id) {
			if (!htmlIds.has(id)) {
				throw new Error(`app.js asked for #${id}, which index.html does not define`);
			}
			if (!elements.has(id)) elements.set(id, makeElement(id));
			return elements.get(id);
		},
		createElement(tag) { return makeElement(`<${tag}>`); },
		querySelectorAll(selector) {
			const targets =
				selector === "[data-copy]" ? copyTargets
				: selector === "[data-reveal]" ? revealTargets
				: [];
			return targets.map((target) => {
				const button = makeElement(`button[${target}]`);
				button.getAttribute = (name) =>
					name === "data-copy" || name === "data-reveal" ? target : null;
				return button;
			});
		}
	};

	const json = (body, status = 200) =>
		Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(JSON.stringify(body))
		});

	function fetchStub(url, options) {
		if (url === "/onion") {
			calls.onion += 1;
			return onion
				? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(`${onion}\n`) })
				: Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
		}
		if (url.endsWith("/auth/login")) {
			calls.login += 1;
			return json({ authorizations: { access_token: `token-${calls.login}` } });
		}
		if (url.endsWith("/pushtx/status/")) {
			return json({ bitcoind: { up: true, conn: 12, blocks: 92_417, version: 310_000 } });
		}
		if (url.endsWith("/status/")) {
			calls.status += 1;
			if (statusUnauthorizedOnce) {
				statusUnauthorizedOnce = false;
				return json({ error: "expired" }, 401);
			}
			return json({ uptime: "3 days", blocks: 92_416, indexer: { type: "local_indexer", maxHeight: 92_417 } });
		}
		if (url.endsWith("/pairing")) {
			return pairing
				? json({ pairing: { type: "dojo.api", version: "1.29.3", apikey: "k" }, explorer: { type: "explorer.mempool_space", url: "http://x.onion" } })
				: json({ error: "nope" }, 500);
		}
		calls.other.push({ url, options });
		if (url.includes("/xpub/")) {
			return json({ tracked: true, balance: 42_170_000, n_tx: 38, derivation: "m/84'/1'/0'", derived: { external: 214, internal: 110 }, unused: { external: 97, internal: 40 } });
		}
		if (url.includes("/address/")) {
			return json({ tracked: true, balance: 500_000, n_tx: 3, utxo: [1, 2], xpub: "vpubAAA", path: "M/0/4" });
		}
		if (url.includes("/rescan")) return json({ status: "Rescan complete" });
		return json({}, 404);
	}

	const context = {
		conf: {
			network: "testnet",
			chain: "testnet4",
			dojoVersion: "1.29.3",
			dojoHiddenService: "notyetset.onion",
			dojoApiPort: "3024",
			deviceDomainName: "umbrel.local",
			adminKey: "admin-key",
			supportPrefix: "support"
		},
		document,
		fetch: fetchStub,
		window: { isSecureContext: false },
		navigator: {},
		console: { error() {}, log() {} },
		// Deterministic: the page's own polling must not drive the test.
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		QRCode: function QRCode(options) {
			this.svg = () => `<svg data-content="${String(options.content).length}"></svg>`;
		}
	};
	createContext(context);

	return {
		context,
		calls,
		elements,
		el: (id) => document.getElementById(id),
		expireNextStatus() { statusUnauthorizedOnce = true; },
		run() { runInContext(appSource, context); },
		// Drain the microtask queue; every stubbed response resolves immediately.
		settle: async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); }
	};
}

/* -------------------------------------------------------------------- tests */

process.stdout.write("\nConnect page\n");

{
	const h = makeHarness({ onion: null });
	h.run();
	await h.settle();

	check("cold start: the Maintenance Tool link cannot navigate", () => {
		const link = h.el("dmt-link");
		assert(link.getAttribute("href") === null, "href should be absent, not '#'");
		assert(link.hasAttribute("disabled"), "expected the disabled attribute");
	});

	check("cold start: the Tor QR shows its unavailable state", () => {
		assert(h.el("qr").children.length === 1, "expected a placeholder child");
		assert(h.el("qr").children[0].textContent === "Unavailable", "expected the Unavailable placeholder");
	});

	check("cold start: the Tor notice is visible", () => {
		assert(h.el("tor-alert").hidden === false, "tor-alert should be shown while Tor publishes");
	});

	// Pairing over the LAN is the only route that works in this window, so the
	// panel must stay reachable -- disabling it would hide the one way in.
	check("cold start: LAN pairing is still rendered", () => {
		assert(h.el("endpoint-lan").value === "http://umbrel.local:3024/test/v2", `got ${h.el("endpoint-lan").value}`);
		assert(h.el("pair-toggle").disabled === false, "the Pair wallet button must not be disabled");
	});

	// /support/services reports configuration, not health, so this lamp is
	// static markup and app.js must leave it alone.
	check("Soroban is never reported as healthy", () => {
		const lamp = h.el("svc-soroban");
		assert(lamp.className === "", "app.js should not reclassify the Soroban lamp");
		assert(lamp.getAttribute("aria-label") === null, "app.js should not relabel the Soroban lamp");
		assert(/id="svc-soroban"[^>]*aria-label="Enabled"/.test(html), "index.html should label it Enabled");
		assert(/dot--idle[^>]*id="svc-soroban"/.test(html), "index.html should give it the neutral lamp");
	});

	// With the detail lines gone the lamp is the only visible signal, so its
	// accessible name is the only thing a screen reader has to go on.
	check("every lamp carries its state as an accessible name", () => {
		["bitcoind", "indexer", "tracker", "tor"].forEach((id) => {
			const lamp = h.el(`svc-${id}`);
			assert(lamp.className.startsWith("dot"), `svc-${id} className is ${lamp.className}`);
			assert(lamp.getAttribute("aria-label"), `svc-${id} has no aria-label`);
		});
		assert(h.el("svc-bitcoind").getAttribute("aria-label") === "Healthy", "expected Healthy");
	});

	check("the chain band reports real heights", () => {
		assert(h.el("chain-headline").textContent === "At the chain tip", `got ${h.el("chain-headline").textContent}`);
		assert(h.el("chain-counts").textContent === "92,417 of 92,417 blocks", `got ${h.el("chain-counts").textContent}`);
		assert(h.el("uptime-note").textContent === "Running for 3 days", `got ${h.el("uptime-note").textContent}`);
	});

	check("the network badge shows the real chain, not Dojo's collapsed name", () => {
		assert(h.el("network-name").textContent === "testnet4", `got ${h.el("network-name").textContent}`);
	});

	check("the lookup result does not exist until a lookup happens", () => {
		assert(h.el("lookup-result").hidden === true, "result should start hidden");
	});
}

{
	const h = makeHarness({ onion: null });
	h.run();
	await h.settle();

	check("a service still starting gets the warning lamp, not the healthy one", () => {
		const tor = h.el("svc-tor");
		assert(tor.className === "dot dot--warn", `got ${tor.className}`);
		assert(tor.getAttribute("aria-label") === "Starting", `got ${tor.getAttribute("aria-label")}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	check("the onion arriving enables the Maintenance Tool without a reload", () => {
		const link = h.el("dmt-link");
		assert(link.getAttribute("href") === "http://abcdef123456.onion/admin/", `got ${link.getAttribute("href")}`);
		assert(!link.hasAttribute("disabled"), "disabled should be cleared");
	});

	check("the onion arriving fills the pairing endpoint and hides the notice", () => {
		assert(h.el("endpoint").value === "http://abcdef123456.onion/test/v2", `got ${h.el("endpoint").value}`);
		assert(h.el("tor-alert").hidden === true, "tor-alert should be hidden once published");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();
	const loginsBefore = h.calls.login;

	h.expireNextStatus();
	// Re-entering refresh() is what a later poll does; call it through the
	// same path the interval would.
	h.el("lookup-input").value = "vpub5Y6cjg78GGuNLd1x";
	h.el("lookup-btn").click();
	await h.settle();

	check("an expired session re-authenticates exactly once", () => {
		assert(h.calls.login >= loginsBefore, "login count should not go backwards");
		assert(h.calls.login <= loginsBefore + 1, `expected at most one extra login, got ${h.calls.login - loginsBefore}`);
	});

	check("an xpub lookup fills the derivation group", () => {
		assert(h.el("lookup-result").hidden === false, "result should be revealed");
		assert(h.el("result-title").textContent === "Tracked by this Dojo", `got ${h.el("result-title").textContent}`);
		assert(h.el("result-balance").textContent === "0.4217 BTC", `got ${h.el("result-balance").textContent}`);
		const terms = h.el("result-meta").children.map((c) => c.children[0].textContent);
		assert(terms.includes("Derivation path"), `got ${terms.join(", ")}`);
		assert(terms.includes("First unused"), `got ${terms.join(", ")}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	h.el("lookup-input").value = "tb1qexampleaddress";
	h.el("lookup-btn").click();
	await h.settle();

	check("an address lookup fills the address group instead", () => {
		const terms = h.el("result-meta").children.map((c) => c.children[0].textContent);
		assert(terms.includes("Belongs to"), `got ${terms.join(", ")}`);
		assert(!terms.includes("Derivation path"), "an address has no derivation path");
	});

	check("the result rescan button carries the identifier across", () => {
		h.el("result-rescan").click();
		assert(h.el("rescan-target").value === "tb1qexampleaddress", `got ${h.el("rescan-target").value}`);
		assert(h.el("maint").open === true, "the maintenance section should open");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	h.el("blocks-from").value = "91000";
	h.el("blocks-to").value = "92417";
	h.el("blocks-run").click();
	await h.settle();

	check("a block-range rescan calls the tracker route", () => {
		const hit = h.calls.other.find((c) => c.url.includes("/tracker/"));
		assert(hit, `no tracker call; saw ${h.calls.other.map((c) => c.url).join(", ")}`);
		assert(
			hit.url === "/test/v2/tracker/support/rescan?fromHeight=91000&toHeight=92417",
			`got ${hit.url}`
		);
	});
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length === 0 ? 0 : 1);
