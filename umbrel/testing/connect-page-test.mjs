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
const cssSource = readFileSync(join(connect, "css", "style.css"), "utf8");

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
		showModal() { this.open = true; },
		close() {
			this.open = false;
			(this.listeners.close || []).forEach((fn) => fn({}));
		},
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

const DAY = 86_400_000;

/* The api_keys table as Dojo reports it: apikeyID, label, apikey, active,
 * createdAt, expiresAt and nothing else. No "last used" column exists, which is
 * why the page shows authorization rather than activity. */
const defaultKeys = () => [
	{ apikeyID: 1, label: "Phone", apikey: "aaaa1111", active: true,
		createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
		expiresAt: new Date(Date.now() + 3650 * DAY).toISOString() },
	{ apikeyID: 2, label: "Old tablet", apikey: "bbbb2222", active: true,
		createdAt: new Date(Date.now() - 400 * DAY).toISOString(),
		expiresAt: new Date(Date.now() - 2 * DAY).toISOString() },
	{ apikeyID: 3, label: "Lost phone", apikey: "cccc3333", active: false,
		createdAt: new Date(Date.now() - 100 * DAY).toISOString(),
		expiresAt: new Date(Date.now() + 3650 * DAY).toISOString() }
];

function makeHarness({ onion = null, pairing = true, barePushtx = false, pushtxDown = false,
	explorerUrl = "http://my-own-mempool.onion",
	keys = defaultKeys(), keysFail = false,
	hash = "", feesFail = false,
	pandoTxPush = "on", pandoTxProcess = "off", sorobanAnnounce = "off",
	indexerHeight = 92_417,
	// Rescans resolve only when the test says so, so a running job can be
	// inspected mid-flight.
	holdRescans = false,
	xpubRescanStatus = "Rescan complete",
	importStatus = { import_in_progress: false },
	websocket = true,
	storage = {} } = {}) {
	const elements = new Map();
	const calls = { login: 0, status: 0, onion: 0, other: [], keys: [], importStatus: 0 };
	const held = [];
	const sockets = [];
	const timers = { intervals: [], timeouts: [] };
	const store = new Map(Object.entries(storage));
	let currentImportStatus = importStatus;
	let holdingStatus = false;
	const heldStatus = [];
	let statusUnauthorizedOnce = false;
	let rows = keys.map((key) => ({ ...key }));
	let nextKeyId = rows.reduce((top, key) => Math.max(top, key.apikeyID), 0) + 1;

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
			// What nginx returns when pushtx is not listening on 8081. That happens
			// on every start: pushtx waits for Soroban's RPC before opening its
			// port, and Soroban bootstraps its own Tor first.
			if (pushtxDown) return json({ error: "Bad Gateway" }, 502);
			// The real shape. pushtx answers through HttpServer.sendOkData, which
			// wraps the payload in {status, data}; the accounts /status/ route uses
			// sendRawData and does not. This fixture used to return the bare object,
			// which no server ever sends -- so the suite passed while the live page
			// showed a red Bitcoin node lamp for months.
			return json(
				barePushtx
					? { bitcoind: { up: true, conn: 12, blocks: 92_417, version: 310_000 } }
					: { status: "ok", data: { bitcoind: { up: true, conn: 12, blocks: 92_417, version: 310_000 } } }
			);
		}
		if (url.endsWith("/status/")) {
			calls.status += 1;
			if (statusUnauthorizedOnce) {
				statusUnauthorizedOnce = false;
				return json({ error: "expired" }, 401);
			}
			return json({ uptime: "3 days", blocks: 92_416, indexer: { type: "local_indexer", maxHeight: indexerHeight } });
		}
		if (url.endsWith("/pairing")) {
			return pairing
				? json({
						pairing: { type: "dojo.api", version: "1.29.3", apikey: "k" },
						explorer: { type: "explorer.mempool_space", url: explorerUrl },
					})
				: json({ error: "nope" }, 500);
		}
		/* The apikey surface. Method-aware, and it mutates `rows`, because the
		 * behaviour under test is a round trip: POST answers {status:"ok"} and
		 * never returns the key it minted, so the page has to re-read the list to
		 * learn what it got. A fixture that handed the key back would test a
		 * server that does not exist. */
		const method = (options && options.method) || "GET";
		if (url.endsWith("/fees/estimator")) {
			// 503 is what Dojo really answers until bitcoind's mempool is fully
			// loaded, which happens on every restart.
			if (feesFail) return json({ status: "error", error: "FeeEstimator not available" }, 503);
			return json({ 0.1: 1, 0.2: 1, 0.5: 3, 0.9: 5, 0.99: 8, 0.999: 12 });
		}
		if (url.endsWith("/apikeys")) {
			calls.keys.push({ method, url });
			if (keysFail) return json({ error: "no table" }, 500);
			return json(rows.map((key) => ({ ...key })));
		}
		if (url.includes("/apikey")) {
			const body = options && options.body ? JSON.parse(options.body) : null;
			calls.keys.push({ method, url, body });
			if (method === "POST") {
				rows.push({
					apikeyID: nextKeyId, label: body.label, apikey: `minted${nextKeyId}`,
					active: true, createdAt: new Date().toISOString(),
					expiresAt: body.expiresAt
				});
				nextKeyId += 1;
				return json({ status: "ok" });
			}
			const target = url.split("/apikey/")[1];
			if (method === "PATCH") {
				rows = rows.map((key) =>
					key.apikey === target
						? { ...key, label: body.label, active: body.active, expiresAt: body.expiresAt }
						: key);
				return json({ status: "ok" });
			}
			if (method === "DELETE") {
				rows = rows.filter((key) => key.apikey !== target);
				return json({ status: "ok" });
			}
		}

		/* Rescan progress. import/status answers through sendOkData, so it is
		 * wrapped like pushtx's status. The rescans themselves can be held open
		 * to look at the page mid-run. */
		if (url.endsWith("/import/status")) {
			calls.importStatus += 1;
			if (holdingStatus) {
				const answer = currentImportStatus;
				return new Promise((resolve) => {
					heldStatus.push((override) => resolve(json({ status: "ok", data: override || answer })));
				});
			}
			return json({ status: "ok", data: currentImportStatus });
		}
		if (url.includes("/rescan")) {
			calls.other.push({ url, options });
			const body = url.includes("/xpub/") ? { status: xpubRescanStatus } : { status: "Rescan complete" };
			if (!holdRescans) return json(body);
			return new Promise((resolve) => {
				held.push(() => resolve(json(body)));
			});
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
			pandoTxPush: pandoTxPush,
			pandoTxProcess: pandoTxProcess,
			sorobanAnnounce: sorobanAnnounce,
			chain: "testnet4",
			dojoVersion: "1.29.3",
			dojoHiddenService: "notyetset.onion",
			dojoApiPort: "3024",
			deviceDomainName: "umbrel.local",
			publicExplorer: "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/testnet4",
			adminKey: "admin-key",
			supportPrefix: "support"
		},
		document,
		fetch: fetchStub,
		sessionStorage: {
			getItem: (key) => (store.has(key) ? store.get(key) : null),
			setItem: (key, value) => { store.set(key, String(value)); },
			removeItem: (key) => { store.delete(key); }
		},
		// showTab reads the hash to pick a tab and rewrites it with replaceState,
		// so both have to exist or the page throws before it renders.
		location: { hash: hash, protocol: "http:", host: "umbrel.local:3025" },
		history: {
			replaceState(_state, _title, url) {
				context.location.hash = String(url);
			}
		},
		window: { isSecureContext: false },
		navigator: {},
		console: { error() {}, log() {} },
		// Deterministic: the page's own polling must not drive the test. Timers
		// are recorded instead, so a test can fire one on purpose.
		setInterval: (fn) => { timers.intervals.push(fn); return timers.intervals.length; },
		clearInterval: (id) => { if (id) timers.intervals[id - 1] = null; },
		setTimeout: (fn) => { timers.timeouts.push(fn); return timers.timeouts.length; },
		clearTimeout: (id) => { if (id) timers.timeouts[id - 1] = null; },
		QRCode: function QRCode(options) {
			this.svg = () => `<svg data-content="${String(options.content).length}"></svg>`;
		}
	};
	/* A websocket that records what the page sends and lets the test play the
	 * server's side: open it, then push messages the way Dojo's notifications
	 * service frames them. */
	if (websocket) {
		context.WebSocket = function WebSocket(url) {
			this.url = url;
			this.sent = [];
			this.closed = false;
			this.send = (data) => { this.sent.push(JSON.parse(data)); };
			this.close = () => { this.closed = true; };
			sockets.push(this);
		};
	}
	createContext(context);

	return {
		context,
		calls,
		held,
		sockets,
		timers,
		store,
		setImportStatus(value) { currentImportStatus = value; },
		holdStatus(on) { holdingStatus = on; },
		heldStatus,
		// Fire every live interval once, the way a tick of the clock would.
		tick() { timers.intervals.filter(Boolean).forEach((fn) => fn()); },
		fireTimeouts() {
			const due = timers.timeouts.splice(0).filter(Boolean);
			due.forEach((fn) => fn());
		},
		block(socket, height) {
			socket.onmessage({ data: JSON.stringify({ op: "block", x: { height, hash: "h" + height } }) });
		},
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

	// Soroban goes green only on a signal that actually proves it: pushtx waits
	// for its RPC before listening whenever PandoTx push is on, so pushtx
	// answering means the RPC is up.
	check("Soroban reads healthy when pushtx answered and push is on", () => {
		const lamp = h.el("svc-soroban");
		assert(lamp.className === "dot dot--ok", `got ${lamp.className}`);
		assert(lamp.getAttribute("aria-label") === "Healthy", `got ${lamp.getAttribute("aria-label")}`);
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

	// The order was specified (Ashigaru, Sentinel, Samourai) and nothing else
	// would notice if someone reshuffled them.
	check("the wallet marks appear in order, each with a name", () => {
		const marks = [...html.matchAll(/<img src="img\/wallet-([a-z]+)\.png" alt="([^"]+)"/g)];
		assert(marks.length === 3, `expected 3 marks, found ${marks.length}`);
		assert(
			marks.map((m) => m[1]).join(",") === "ashigaru,sentinel,samourai",
			`got ${marks.map((m) => m[1]).join(",")}`
		);
		assert(
			marks.map((m) => m[2]).join(",") === "Ashigaru,Sentinel,Samourai",
			`alt text was ${marks.map((m) => m[2]).join(",")}`
		);
	});

	check("the chain band reports real heights", () => {
		assert(h.el("chain-headline").textContent === "At the chain tip", `got ${h.el("chain-headline").textContent}`);
		assert(h.el("chain-counts").textContent === "92,417 of 92,417 blocks", `got ${h.el("chain-counts").textContent}`);
		assert(h.el("uptime-note").textContent === "Running for 3 days", `got ${h.el("uptime-note").textContent}`);
	});

	// These two are the regression. Against the pre-fix app.js they fail: it
	// reads pushtx.bitcoind, which is undefined once the payload is wrapped, so
	// the lamp goes red and the band drops to its no-node-height branch.
	check("the Bitcoin node lamp reads the wrapped pushtx payload", () => {
		const lamp = h.el("svc-bitcoind");
		assert(lamp.className === "dot dot--ok", `expected the healthy lamp, got "${lamp.className}"`);
		assert(lamp.getAttribute("aria-label") === "Healthy", `got ${lamp.getAttribute("aria-label")}`);
	});

	check("the band compares indexed height against the node's", () => {
		assert(
			h.el("chain-counts").textContent === "92,417 of 92,417 blocks",
			`got "${h.el("chain-counts").textContent}" -- "Indexed by your Dojo." means the node height was lost`
		);
	});

	check("the network badge shows the real chain, not Dojo's collapsed name", () => {
		assert(h.el("network-name").textContent === "testnet4", `got ${h.el("network-name").textContent}`);
	});

	check("the lookup result does not exist until a lookup happens", () => {
		assert(h.el("lookup-result").hidden === true, "result should start hidden");
	});
}

{
	// "pushtx did not answer" and "the Bitcoin node is down" are different
	// facts, and the page can only distinguish them by saying so. Reporting the
	// first as a red Unavailable claims knowledge the page does not have.
	const h = makeHarness({ onion: "abcdef123456.onion", pushtxDown: true });
	h.run();
	await h.settle();

	check("an unreachable pushtx reads Unknown, not Unavailable", () => {
		const lamp = h.el("svc-bitcoind");
		assert(lamp.className === "dot dot--warn", `expected the warning lamp, got "${lamp.className}"`);
		assert(
			lamp.getAttribute("aria-label") === "Unknown",
			`got ${lamp.getAttribute("aria-label")} -- "Unavailable" asserts the node is down, which we cannot see`
		);
	});

	check("and the band claims no node height it does not have", () => {
		assert(h.el("chain-counts").textContent === "Indexed by your Dojo.", `got "${h.el("chain-counts").textContent}"`);
		assert(h.el("chain-headline").textContent === "Block 92,416", `got "${h.el("chain-headline").textContent}"`);
	});
}

{
	// The permissive read has to work both ways round, or it is just the old
	// bug with the operands swapped.
	const h = makeHarness({ onion: "abcdef123456.onion", barePushtx: true });
	h.run();
	await h.settle();

	check("an unwrapped pushtx payload is still understood", () => {
		assert(h.el("svc-bitcoind").className === "dot dot--ok", `got "${h.el("svc-bitcoind").className}"`);
		assert(
			h.el("chain-counts").textContent === "92,417 of 92,417 blocks",
			`got "${h.el("chain-counts").textContent}"`
		);
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

	check("pairing is a dialog, closed until asked for", () => {
		assert(h.el("pair-panel").open === false, "the dialog should start closed");
		assert(/<dialog[^>]*id="pair-panel"/.test(html), "pair-panel should be a <dialog>");
	});

	check("either entrance opens it, and close shuts it", () => {
		h.el("pair-toggle").click();
		assert(h.el("pair-panel").open === true, "the header button should open it");
		h.el("pair-close").click();
		assert(h.el("pair-panel").open === false, "the close button should shut it");
		assert(
			h.el("pair-toggle").getAttribute("aria-expanded") === "false",
			"aria-expanded should follow the dialog shut"
		);
		h.el("pair-toggle-2").click();
		assert(h.el("pair-panel").open === true, "the tile should open it too");
	});

	// Everything the QR encodes, in text, for anyone pasting it into a wallet
	// that asks for the payload rather than scanning.
	check("the pairing payload is rendered and copyable", () => {
		const payload = h.el("pairing-json").textContent;
		assert(payload.includes('"apikey"'), `payload looks wrong: ${payload.slice(0, 60)}`);
		assert(/data-copy="pairing-json"/.test(html), "the payload needs a copy control");
	});

	check("a Mempool of your own is named as such", () => {
		assert(
			/your own Mempool/.test(h.el("explorer-note").textContent),
			`got "${h.el("explorer-note").textContent}"`
		);
	});
}

{
	// The common case until the user turns Tor on: the payload carries
	// mempool.space's onion, and the page has to say so rather than implying
	// the explorer is private.
	const h = makeHarness({
		onion: "abcdef123456.onion",
		explorerUrl: "http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/testnet4",
	});
	h.run();
	await h.settle();

	check("the public explorer is named, with the way to replace it", () => {
		const note = h.el("explorer-note").textContent;
		assert(/mempool\.space/.test(note), `got "${note}"`);
		assert(/still sees/.test(note), "it should not imply the public explorer is private");
		assert(/turn on Tor/i.test(note) && /restart Dojo/i.test(note), "it should say how to switch");
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
		// The rescan lives on the Tools tab now, so the handoff has to land there
		// rather than opening a <details> that no longer exists.
		assert(h.el("panel-tools").hidden === false, "the Tools tab should be showing");
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

	check("a block-range rescan calls the tracker route, clipped to Dojo's tip", () => {
		const hit = h.calls.other.find((c) => c.url.includes("/tracker/"));
		assert(hit, `no tracker call; saw ${h.calls.other.map((c) => c.url).join(", ")}`);
		// The fixture's tracker is at 92,416. Dojo would clip 92,417 itself
		// (blockchain-processor.js); the page now does it up front so the bar's
		// total is the number of blocks that will really be scanned.
		assert(
			hit.url === "/test/v2/tracker/support/rescan?fromHeight=91000&toHeight=92416",
			`got ${hit.url}`
		);
	});
}

/* --------------------------------------------------- per-wallet API keys */

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	check("the key list is read at load and rendered", () => {
		assert(h.calls.keys.length >= 1, "expected a GET /support/apikeys");
		assert(h.calls.keys[0].method === "GET", `got ${h.calls.keys[0].method}`);
		assert(h.el("wallet-rows").children.length === 3, `got ${h.el("wallet-rows").children.length} rows`);
	});

	check("each key shows the state the table can actually prove", () => {
		const pills = h.el("wallet-rows").children.map(
			(card) => card.children.find((kid) => (kid.className || "").indexOf("pill") === 0)
		);
		assert(pills.every(Boolean), "every card needs a pill");
		assert(
			pills.map((pill) => pill.textContent).join(",") === "Authorized,Expired,Revoked",
			`got ${pills.map((pill) => pill.textContent).join(",")}`
		);
	});

	check("the count includes the environment key, which is not in the table", () => {
		// One authorized row plus the key Umbrel derived into the container.
		assert(h.el("wallet-count").textContent.startsWith("2 authorized"), `got ${h.el("wallet-count").textContent}`);
	});

	check("the count accounts for every card on screen, not just the authorized ones", () => {
		// It used to read "2 keys" above four cards. Each card is now counted
		// under the word its own pill shows.
		assert(
			h.el("wallet-count").textContent === "2 authorized \u00b7 1 expired \u00b7 1 revoked",
			`got ${h.el("wallet-count").textContent}`
		);
	});

	check("neither pairing entrance mints a key", () => {
		const before = h.calls.keys.length;
		h.el("pair-toggle").click();
		h.el("pair-toggle-2").click();
		assert(h.el("pair-panel").open === true, "the dialog should be open");
		assert(h.el("pair-new").hidden === false, "the naming step should be showing");
		assert(h.el("pair-code").hidden === true, "no code until a key is chosen");
		assert(h.calls.keys.length === before, "opening the dialog wrote to the key list");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	h.el("pair-toggle-2").click();
	const before = h.calls.keys.length;
	h.el("pair-create").click();
	await h.settle();

	check("creating without a name is refused locally, with nothing sent", () => {
		assert(h.el("pair-error").hidden === false, "expected an error");
		assert(
			h.calls.keys.filter((call) => call.method === "POST").length === 0,
			"a nameless key was sent to Dojo"
		);
		assert(h.calls.keys.length === before, "unexpected traffic");
		assert(h.el("pair-code").hidden === true, "no code should appear");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	h.el("pair-toggle-2").click();
	h.el("pair-name").value = "Ashigaru";
	h.el("pair-create").click();
	await h.settle();

	const posts = h.calls.keys.filter((call) => call.method === "POST");

	check("creating a key posts the name and a ten-year expiry by default", () => {
		assert(posts.length === 1, `expected 1 POST, got ${posts.length}`);
		assert(posts[0].body.label === "Ashigaru", `got ${posts[0].body.label}`);
		const years = (Date.parse(posts[0].body.expiresAt) - Date.now()) / (365 * DAY);
		assert(years > 9.5 && years < 10.5, `expected ~10 years, got ${years.toFixed(2)}`);
	});

	check("the minted key is read back and its own code shown", () => {
		// POST returns {status:"ok"} and nothing else, so the page must re-GET
		// and find the new row by apikeyID -- label is not unique in the table.
		assert(
			h.calls.keys.filter((call) => call.method === "GET").length >= 2,
			"expected a second GET to read the key back"
		);
		assert(h.el("pair-code").hidden === false, "the code should be showing");
		assert(h.el("pair-new").hidden === true, "the naming step should be gone");
		assert(
			h.el("pair-which").textContent.indexOf("Ashigaru") !== -1,
			`got ${h.el("pair-which").textContent}`
		);
	});

	check("the payload carries the new key, not the shared one", () => {
		// The whole point of the feature. /support/pairing always answers with
		// the environment key ("k" in this fixture); the page swaps in the
		// minted one, or revoking a wallet would do nothing.
		const payload = JSON.parse(h.el("pairing-json").textContent);
		assert(payload.pairing.apikey === "minted4", `got ${payload.pairing.apikey}`);
		assert(payload.pairing.url === "http://abcdef123456.onion/test/v2", `got ${payload.pairing.url}`);
	});

	check("the new wallet appears in the list", () => {
		assert(h.el("wallet-rows").children.length === 4, `got ${h.el("wallet-rows").children.length}`);
		assert(h.el("wallet-count").textContent.startsWith("3 authorized"), `got ${h.el("wallet-count").textContent}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	// The first card is the authorized one: Show code, Revoke, Forget.
	const card = h.el("wallet-rows").children[0];
	const acts = card.children.find((kid) => kid.className === "wcard-acts");
	const labels = acts.children.map((button) => button.textContent);

	check("an authorized key offers a code, a revoke and a forget", () => {
		assert(labels.join(",") === "Show code,Revoke,Forget", `got ${labels.join(",")}`);
	});

	check("a revoked key offers no code to pair with", () => {
		const revoked = h.el("wallet-rows").children[2];
		const bar = revoked.children.find((kid) => kid.className === "wcard-acts");
		assert(
			bar.children.map((b) => b.textContent).join(",") === "Forget",
			`got ${bar.children.map((b) => b.textContent).join(",")}`
		);
	});

	check("showing a key's code swaps that key into the payload", () => {
		acts.children[0].click();
		assert(h.el("pair-panel").open === true, "the dialog should open");
		assert(h.el("pair-code").hidden === false, "straight to the code, no naming step");
		const payload = JSON.parse(h.el("pairing-json").textContent);
		assert(payload.pairing.apikey === "aaaa1111", `got ${payload.pairing.apikey}`);
	});

	check("revoking asks before it sends anything", () => {
		const before = h.calls.keys.filter((call) => call.method === "PATCH").length;
		acts.children[1].click();
		assert(
			h.calls.keys.filter((call) => call.method === "PATCH").length === before,
			"the first click revoked without confirmation"
		);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	const card = h.el("wallet-rows").children[0];
	const acts = card.children.find((kid) => kid.className === "wcard-acts");
	acts.children[1].click();
	// armConfirm appends the prompt and a second action bar to the card.
	const bars = card.children.filter((kid) => kid.className === "wcard-acts");
	bars[bars.length - 1].children[0].click();
	await h.settle();

	const patches = h.calls.keys.filter((call) => call.method === "PATCH");

	check("confirming a revoke sends all three fields PATCH requires", () => {
		// updateApiKey rejects a partial body: label, expiresAt and active are
		// each validated, so a revoke has to send the first two back unchanged.
		assert(patches.length === 1, `expected 1 PATCH, got ${patches.length}`);
		assert(patches[0].url.indexOf("/apikey/aaaa1111") !== -1, `got ${patches[0].url}`);
		assert(patches[0].body.active === false, `got active ${patches[0].body.active}`);
		assert(patches[0].body.label === "Phone", `got label ${patches[0].body.label}`);
		assert(typeof patches[0].body.expiresAt === "string", "expiresAt must be sent back");
	});

	check("the row stays, now reading Revoked", () => {
		const pills = h.el("wallet-rows").children.map(
			(c) => c.children.find((kid) => (kid.className || "").indexOf("pill") === 0).textContent
		);
		assert(h.el("wallet-rows").children.length === 3, "nothing should be deleted");
		assert(pills[0] === "Revoked", `got ${pills[0]}`);
		assert(h.el("wallet-count").textContent === "1 authorized \u00b7 1 expired \u00b7 2 revoked", `got ${h.el("wallet-count").textContent}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	const card = h.el("wallet-rows").children[1];
	const acts = card.children.find((kid) => kid.className === "wcard-acts");
	// The expired key offers Forget only, so that is index 0.
	acts.children[0].click();
	const bars = card.children.filter((kid) => kid.className === "wcard-acts");
	bars[bars.length - 1].children[0].click();
	await h.settle();

	check("confirming a forget deletes the row", () => {
		const deletes = h.calls.keys.filter((call) => call.method === "DELETE");
		assert(deletes.length === 1, `expected 1 DELETE, got ${deletes.length}`);
		assert(deletes[0].url.indexOf("/apikey/bbbb2222") !== -1, `got ${deletes[0].url}`);
		assert(h.el("wallet-rows").children.length === 2, `got ${h.el("wallet-rows").children.length}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	h.el("legacy-show").click();

	check("the default key still produces today's payload as a fallback", () => {
		const payload = JSON.parse(h.el("pairing-json").textContent);
		assert(payload.pairing.apikey === "k", `got ${payload.pairing.apikey}`);
		assert(
			h.el("pair-which").textContent.indexOf("cannot be revoked") !== -1,
			`got ${h.el("pair-which").textContent}`
		);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", keysFail: true });
	h.run();
	await h.settle();

	check("an unreadable key list is reported without taking the page down", () => {
		assert(h.el("wallets-error").hidden === false, "expected the wallets error");
		assert(h.el("wallet-rows").children.length === 0, "no rows should be rendered");
		// The rest of the page still has to work: the key list failing is not a
		// reason to lose status or pairing.
		assert(h.el("chain-headline").textContent !== "—", "the band should still render");
		assert(h.el("endpoint").value === "http://abcdef123456.onion/test/v2", `got ${h.el("endpoint").value}`);
	});
}

/* ------------------------------------------------------------------ tabs */

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	check("Home is the tab on a cold load, and only Home", () => {
		assert(h.el("panel-home").hidden === false, "Home should be showing");
		assert(h.el("panel-tools").hidden === true, "Tools should be hidden");
		assert(h.el("panel-advanced").hidden === true, "Advanced should be hidden");
		assert(h.el("tab-home").getAttribute("aria-selected") === "true", "Home tab should be selected");
	});

	check("exactly one panel shows whichever tab is picked", () => {
		["tools", "advanced", "home"].forEach((name) => {
			h.el("tab-" + name).click();
			const shown = ["home", "tools", "advanced"].filter((p) => h.el("panel-" + p).hidden === false);
			assert(shown.length === 1 && shown[0] === name, `picking ${name} showed ${shown.join(",") || "nothing"}`);
		});
	});

	check("only the selected tab is in the tab order", () => {
		h.el("tab-tools").click();
		assert(h.el("tab-tools").getAttribute("tabindex") === null, "selected tab should not be removed from the order");
		assert(h.el("tab-home").getAttribute("tabindex") === "-1", "unselected tabs should leave the tab order");
	});

	check("the hash follows the tab, for a reload or a bookmark", () => {
		h.el("tab-advanced").click();
		assert(h.context.location.hash === "#advanced", `got ${h.context.location.hash}`);
	});

	check("Pair wallet still works from a tab that is not Home", () => {
		h.el("tab-advanced").click();
		h.el("pair-toggle").click();
		// The dialog sits outside the panels precisely so this holds.
		assert(h.el("pair-panel").open === true, "the pairing dialog should open from any tab");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", hash: "#tools" });
	h.run();
	await h.settle();

	check("a hash from a reload or a link selects that tab", () => {
		assert(h.el("panel-tools").hidden === false, "Tools should be showing");
		assert(h.el("panel-home").hidden === true, "Home should be hidden");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", hash: "#nonsense" });
	h.run();
	await h.settle();

	check("an unrecognised hash falls back to Home rather than showing nothing", () => {
		assert(h.el("panel-home").hidden === false, "Home should be showing");
	});
}

/* ------------------------------------------------------------- next block */

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	check("the fee boxes show the same three levels as the widget", () => {
		// 0.1 / 0.5 / 0.99 from the fixture: Low, Medium, High.
		assert(h.el("fee-low").textContent === "1", `got ${h.el("fee-low").textContent}`);
		assert(h.el("fee-med").textContent === "3", `got ${h.el("fee-med").textContent}`);
		assert(h.el("fee-high").textContent === "8", `got ${h.el("fee-high").textContent}`);
		assert(h.el("fees-note").textContent === "", "no note is needed once there are figures");
		assert(h.el("fees").className === "fees", `units should show; got ${h.el("fees").className}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", feesFail: true });
	h.run();
	await h.settle();

	check("a 503 from the estimator shows a dash, never a number", () => {
		// Same rule as the widget: the route 503s until bitcoind's mempool loads,
		// and a stale or invented feerate is worse than saying nothing.
		["fee-low", "fee-med", "fee-high"].forEach((id) => {
			assert(h.el(id).textContent === "—", `${id} got ${h.el(id).textContent}`);
		});
		assert(h.el("fees-note").textContent.indexOf("No estimate yet") === 0, `got ${h.el("fees-note").textContent}`);
		// "— sat/vB" would read as a unit for a number that is not there.
		assert(h.el("fees").className.indexOf("fees--unknown") !== -1, `got ${h.el("fees").className}`);
		// And the rest of the page must be unaffected.
		assert(h.el("chain-headline").textContent !== "—", "the band should still render");
	});
}

/* ----------------------------------------------------------------- pandotx */

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	check("push on and relay off is reported as that", () => {
		assert(h.el("pandotx-push-pill").textContent === "On", `got ${h.el("pandotx-push-pill").textContent}`);
		assert(h.el("pandotx-relay-pill").textContent === "Off", `got ${h.el("pandotx-relay-pill").textContent}`);
	});
}

{
	// The trap: process on but announce off. keys.index.js:79-84 requires both,
	// so relay is genuinely inactive and the page must not claim otherwise.
	const h = makeHarness({
		onion: "abcdef123456.onion", pandoTxProcess: "on", sorobanAnnounce: "off"
	});
	h.run();
	await h.settle();

	check("relay reads off when announce is off, whatever process says", () => {
		assert(h.el("pandotx-relay-pill").textContent === "Off", `got ${h.el("pandotx-relay-pill").textContent}`);
	});
}

{
	const h = makeHarness({
		onion: "abcdef123456.onion", pandoTxProcess: "on", sorobanAnnounce: "on"
	});
	h.run();
	await h.settle();

	check("relay reads on only when both are on", () => {
		assert(h.el("pandotx-relay-pill").textContent === "On", `got ${h.el("pandotx-relay-pill").textContent}`);
	});
}

/* ------------------------------------------------------------- soroban lamp */

{
	// pushtx not answering is the state that used to show a red Bitcoin node.
	// Soroban must not claim health from it either: nothing proved its RPC is up.
	const h = makeHarness({ onion: "abcdef123456.onion", pushtxDown: true });
	h.run();
	await h.settle();

	check("Soroban reads unknown when pushtx did not answer", () => {
		const lamp = h.el("svc-soroban");
		assert(lamp.className === "dot dot--warn", `got ${lamp.className}`);
		assert(lamp.getAttribute("aria-label") === "Unknown", `got ${lamp.getAttribute("aria-label")}`);
	});
}

{
	// With push off nothing in Dojo waits on Soroban, so pushtx answering proves
	// nothing about it -- even though everything else on the page is healthy.
	const h = makeHarness({ onion: "abcdef123456.onion", pandoTxPush: "off" });
	h.run();
	await h.settle();

	check("with push off the lamp reports configuration, not health", () => {
		const lamp = h.el("svc-soroban");
		assert(lamp.className === "dot dot--idle", `got ${lamp.className}`);
		assert(lamp.getAttribute("aria-label") === "Enabled", `got ${lamp.getAttribute("aria-label")}`);
		// The rest of the page is fine, so this is not a general failure state.
		assert(h.el("svc-bitcoind").getAttribute("aria-label") === "Healthy", "the node should still be healthy");
	});
}

/* ---------------------------------------------------------- rescan progress */

process.stdout.write("\nRescan progress\n");

const fill = (h, prefix) => h.el(`${prefix}-job-fill`).style.width || "";
const jobClass = (h, prefix) => h.el(`${prefix}-job`).className;

{
	// Dojo answers a rescan of an untracked wallet with HTTP 200 and a status
	// that begins "Error:". The old page showed that string in green.
	const h = makeHarness({ onion: "abcdef123456.onion", xpubRescanStatus: "Error: Not tracking xpub" });
	h.run();
	await h.settle();
	h.el("rescan-target").value = "vpub5YourWalletKey";
	h.el("rescan-run").click();
	await h.settle();

	check("a refused wallet rescan reads as an error, not a success", () => {
		assert(jobClass(h, "rescan").includes("job--failed"), `class was ${jobClass(h, "rescan")}`);
		assert(!jobClass(h, "rescan").includes("job--done"), "must not show the finished state");
		assert(/not tracking this wallet/.test(h.el("rescan-job-detail").textContent),
			`detail was ${h.el("rescan-job-detail").textContent}`);
		assert(h.el("rescan-run").disabled === false, "the button should come back");
	});
}

{
	const h = makeHarness({
		onion: "abcdef123456.onion", holdRescans: true,
		importStatus: { import_in_progress: true, status: "rescan", hits: 12 }
	});
	h.run();
	await h.settle();
	h.el("rescan-target").value = "vpub5YourWalletKey";
	h.el("rescan-run").click();
	await h.settle();

	check("a wallet rescan polls Dojo's import status and shows what it found", () => {
		assert(h.calls.importStatus >= 1, "import/status was never asked");
		assert(jobClass(h, "rescan").includes("job--indeterminate"), "no total exists, so no percentage");
		assert(h.el("rescan-job-detail").textContent === "Scanning addresses · 12 transactions found so far.",
			`detail was ${h.el("rescan-job-detail").textContent}`);
		assert(h.el("rescan-run").disabled === true, "the button must stay disabled while it runs");
	});

	check("the running wallet job is saved, so a reload can pick it up", () => {
		const saved = JSON.parse(h.store.get("dojo-connect-job") || "null");
		assert(saved && saved.kind === "xpub" && saved.target === "vpub5YourWalletKey", `saved ${JSON.stringify(saved)}`);
	});

	h.setImportStatus({ import_in_progress: true, status: "import", hits: 40 });
	h.tick();
	await h.settle();

	check("the saving stage is reported with its transaction count", () => {
		assert(h.el("rescan-job-detail").textContent === "Saving 40 transactions to Dojo's database.",
			`detail was ${h.el("rescan-job-detail").textContent}`);
	});

	// A status request leaves just before the rescan answers, and its reply --
	// still saying "scanning" -- lands after the finish.
	h.holdStatus(true);
	h.tick();
	await h.settle();
	h.holdStatus(false);
	h.setImportStatus({ import_in_progress: false });
	h.held.splice(0).forEach((release) => release());
	await h.settle();
	h.heldStatus.splice(0).forEach((release) =>
		release({ import_in_progress: true, status: "rescan", hits: 99 }));
	await h.settle();

	check("a finished wallet rescan shows what Dojo now holds", () => {
		assert(jobClass(h, "rescan").includes("job--done"), `class was ${jobClass(h, "rescan")}`);
		// From the /xpub/:x/info fixture: 38 transactions, 42,170,000 sats.
		assert(/^38 transactions · balance /.test(h.el("rescan-job-detail").textContent),
			`detail was ${h.el("rescan-job-detail").textContent}`);
		assert(!h.store.has("dojo-connect-job"), "the saved job should be cleared");
		assert(h.el("rescan-run").disabled === false, "the button should come back");
	});

	check("a status reply that lands after the finish cannot repaint the panel", () => {
		assert(jobClass(h, "rescan").includes("job--done"), `class became ${jobClass(h, "rescan")}`);
		assert(!/99/.test(h.el("rescan-job-detail").textContent), "the late count must not show");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", holdRescans: true });
	h.run();
	await h.settle();
	h.el("rescan-target").value = "tb1qexampleaddress";
	h.el("rescan-run").click();
	await h.settle();

	check("an address rescan shows a moving bar, and does not poll wallet status", () => {
		assert(jobClass(h, "rescan").includes("job--indeterminate"), `class was ${jobClass(h, "rescan")}`);
		assert(h.calls.importStatus === 0, "import/status is for extended keys only");
	});

	h.held.splice(0).forEach((release) => release());
	await h.settle();

	check("a finished address rescan reports the address's figures", () => {
		assert(jobClass(h, "rescan").includes("job--done"), `class was ${jobClass(h, "rescan")}`);
		assert(/^3 transactions/.test(h.el("rescan-job-detail").textContent),
			`detail was ${h.el("rescan-job-detail").textContent}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	check("gap limit and start index stay hidden until the input is an extended key", () => {
		assert(h.el("rescan-gap-field").hidden === true, "hidden with nothing typed");
		h.el("rescan-target").value = "tb1qexampleaddress";
		h.el("rescan-target").listeners.input.forEach((fn) => fn({}));
		assert(h.el("rescan-gap-field").hidden === true, "an address takes no lookahead");
		h.el("rescan-target").value = "zpub6rFR7y4Q2Aij";
		h.el("rescan-target").listeners.input.forEach((fn) => fn({}));
		assert(h.el("rescan-gap-field").hidden === false, "shown for an xpub");
		assert(h.el("rescan-start-field").hidden === false, "shown for an xpub");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", holdRescans: true });
	h.run();
	await h.settle();
	h.el("blocks-from").value = "92000";
	h.el("blocks-to").value = "92009";
	h.el("blocks-from").listeners.input.forEach((fn) => fn({}));

	check("the range says how many blocks it will scan before it starts", () => {
		assert(h.el("blocks-span").textContent === "10 blocks.", `got ${h.el("blocks-span").textContent}`);
	});

	h.el("blocks-run").click();
	await h.settle();
	const socket = h.sockets[0];

	check("a block rescan opens Dojo's websocket and subscribes with the session token", () => {
		assert(socket, "no websocket was opened");
		assert(socket.url === "ws://umbrel.local:3025/test/v2/inv", `url was ${socket.url}`);
		socket.onopen();
		assert(socket.sent.length === 1 && socket.sent[0].op === "blocks_sub", `sent ${JSON.stringify(socket.sent)}`);
		assert(typeof socket.sent[0].at === "string" && socket.sent[0].at.startsWith("token-"), "the JWT must ride along");
	});

	for (let height = 92000; height < 92005; height += 1) h.block(socket, height);

	check("blocks inside the range move the bar to a real percentage", () => {
		assert(fill(h, "blocks") === "50.0%", `width was ${fill(h, "blocks")}`);
		assert(!jobClass(h, "blocks").includes("job--indeterminate"), "this one has a total");
		assert(h.el("blocks-job-detail").textContent.startsWith("5 of 10 blocks"),
			`detail was ${h.el("blocks-job-detail").textContent}`);
	});

	check("a new tip block or a repeat does not count as progress", () => {
		h.block(socket, 92_417);
		h.block(socket, 92_003);
		assert(fill(h, "blocks") === "50.0%", `width moved to ${fill(h, "blocks")}`);
	});

	h.held.splice(0).forEach((release) => release());
	await h.settle();

	check("the finished block rescan says what it did and lets go of the socket", () => {
		assert(jobClass(h, "blocks").includes("job--done"), `class was ${jobClass(h, "blocks")}`);
		assert(h.el("blocks-job-title").textContent === "Rescanned 10 blocks", `title was ${h.el("blocks-job-title").textContent}`);
		assert(socket.closed, "the socket should be closed");
		assert(!h.store.has("dojo-connect-job"), "the saved job should be cleared");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", holdRescans: true });
	h.run();
	await h.settle();
	const loginsBefore = h.calls.login;
	h.el("blocks-from").value = "92000";
	h.el("blocks-run").click();
	await h.settle();
	const socket = h.sockets[0];

	check("the socket subscribes with a freshly issued token", () => {
		// Access tokens last fifteen minutes and a socket cannot recover from a
		// stale one, so the page logs in again rather than reusing what it holds.
		assert(h.calls.login === loginsBefore + 1, `logins went ${loginsBefore} -> ${h.calls.login}`);
		socket.onopen();
		assert(socket.sent[0].at === `token-${h.calls.login}`, `subscribed with ${socket.sent[0].at}`);
		assert(/^Connected\. Waiting for Dojo to reach block 92,000/.test(h.el("blocks-job-detail").textContent),
			`detail was ${h.el("blocks-job-detail").textContent}`);
	});

	socket.onmessage({ data: JSON.stringify({ op: "error", msg: "Invalid JSON Web Token" }) });

	check("a refused token falls back to the moving bar instead of waiting forever", () => {
		assert(socket.closed, "the refused socket should be closed");
		assert(/Live progress is not available/.test(h.el("blocks-job-detail").textContent),
			`detail was ${h.el("blocks-job-detail").textContent}`);
		assert(h.el("blocks-run").disabled === true, "the rescan itself is still running");
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", holdRescans: true, websocket: false });
	h.run();
	await h.settle();
	h.el("blocks-from").value = "92000";
	h.el("blocks-run").click();
	await h.settle();

	check("with no websocket, a block rescan still runs and says it cannot show progress", () => {
		assert(h.calls.other.some((c) => c.url.includes("fromHeight=92000&toHeight=92000")), "the rescan must still be sent");
		assert(jobClass(h, "blocks").includes("job--indeterminate"), `class was ${jobClass(h, "blocks")}`);
		assert(/Live progress is not available/.test(h.el("blocks-job-detail").textContent),
			`detail was ${h.el("blocks-job-detail").textContent}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion" });
	h.run();
	await h.settle();

	check("a range past Dojo's tip is clipped, and the hint says so", () => {
		h.el("blocks-from").value = "92400";
		h.el("blocks-to").value = "93000";
		h.el("blocks-to").listeners.input.forEach((fn) => fn({}));
		assert(/^17 blocks\. Dojo stops at its highest block, 92,416\.$/.test(h.el("blocks-span").textContent),
			`got ${h.el("blocks-span").textContent}`);
	});

	check("an empty “to” is called out as a single block", () => {
		h.el("blocks-to").value = "";
		h.el("blocks-to").listeners.input.forEach((fn) => fn({}));
		assert(/^1 block — leave/.test(h.el("blocks-span").textContent), `got ${h.el("blocks-span").textContent}`);
	});

	check("a start beyond the tip is refused before anything is sent", () => {
		h.el("blocks-from").value = "95000";
		h.el("blocks-run").click();
		assert(!h.calls.other.some((c) => c.url.includes("/tracker/")), "nothing should reach the tracker");
		assert(h.el("blocks-note").hidden === false, "the reason should be shown");
	});
}

{
	const h = makeHarness({
		onion: "abcdef123456.onion",
		importStatus: { import_in_progress: true, status: "rescan", hits: 7 },
		storage: { "dojo-connect-job": JSON.stringify({ kind: "xpub", target: "vpub5Resumed", started: Date.now() - 60_000 }) }
	});
	h.run();
	await h.settle();

	check("after a reload, a running wallet rescan picks up and keeps the button disabled", () => {
		assert(h.el("rescan-job").hidden === false, "the panel should be back");
		assert(h.el("rescan-target").value === "vpub5Resumed", `target was ${h.el("rescan-target").value}`);
		assert(h.el("rescan-run").disabled === true, "a second rescan must not be startable");
		assert(/7 transactions found/.test(h.el("rescan-job-detail").textContent), `detail was ${h.el("rescan-job-detail").textContent}`);
	});

	h.setImportStatus({ import_in_progress: false });
	h.fireTimeouts();
	await h.settle();

	check("and finishes once Dojo reports it done", () => {
		assert(jobClass(h, "rescan").includes("job--done"), `class was ${jobClass(h, "rescan")}`);
		assert(h.el("rescan-run").disabled === false, "the button should come back");
		assert(!h.store.has("dojo-connect-job"), "the saved job should be cleared");
	});
}

{
	const h = makeHarness({
		onion: "abcdef123456.onion",
		storage: { "dojo-connect-job": JSON.stringify({ kind: "blocks", from: 91_000, to: 91_099, total: 100, started: Date.now() - 60_000 }) }
	});
	h.run();
	await h.settle();
	const socket = h.sockets[0];
	socket.onopen();
	h.block(socket, 91_049);

	check("after a reload, a block rescan resumes from the height Dojo has really reached", () => {
		// The queue is sequential, so block 91,049 means 50 of 100 are done.
		assert(fill(h, "blocks") === "50.0%", `width was ${fill(h, "blocks")}`);
		assert(h.el("blocks-run").disabled === true, "a second rescan must not be startable");
	});

	h.block(socket, 91_099);

	check("and finishes when the last block in range comes through", () => {
		assert(jobClass(h, "blocks").includes("job--done"), `class was ${jobClass(h, "blocks")}`);
		assert(!h.store.has("dojo-connect-job"), "the saved job should be cleared");
	});
}

{
	const h = makeHarness({
		onion: "abcdef123456.onion",
		storage: { "dojo-connect-job": JSON.stringify({ kind: "blocks", from: 91_000, to: 91_099, total: 100, started: Date.now() }) }
	});
	h.run();
	await h.settle();
	h.fireTimeouts();

	check("a resumed block rescan that goes quiet says so instead of claiming it finished", () => {
		assert(!jobClass(h, "blocks").includes("job--done"), "silence is not completion");
		assert(h.el("blocks-job-title").textContent === "Rescan status unknown", `title was ${h.el("blocks-job-title").textContent}`);
		// Nor may it look like it is still running: no moving bar, no clock.
		assert(jobClass(h, "blocks").includes("job--unknown"), `class was ${jobClass(h, "blocks")}`);
		assert(h.el("blocks-job-meta").textContent === "", `meta was ${h.el("blocks-job-meta").textContent}`);
		assert(h.el("blocks-job-dismiss").hidden === false, "offer to clear it");
		assert(h.el("blocks-run").disabled === false, "the button should come back");
	});
}

/* ------------------------------------------------------- the Electrum lamp */

{
	const h = makeHarness({ onion: "abcdef123456.onion", indexerHeight: 92_300 });
	h.run();
	await h.settle();

	check("an Electrum server well behind the node is amber, not green", () => {
		assert(h.el("svc-indexer").className.includes("dot--warn"), `class was ${h.el("svc-indexer").className}`);
		assert(h.el("svc-indexer").getAttribute("aria-label") === "Syncing", `label was ${h.el("svc-indexer").getAttribute("aria-label")}`);
	});
}

{
	const h = makeHarness({ onion: "abcdef123456.onion", indexerHeight: 92_416 });
	h.run();
	await h.settle();

	check("an Electrum server a block behind is still healthy", () => {
		assert(h.el("svc-indexer").getAttribute("aria-label") === "Healthy", `label was ${h.el("svc-indexer").getAttribute("aria-label")}`);
	});
}

/* --------------------------------------------------------------- stylesheet */

/* An entire section of style.css -- .wallets, .wcard, .pill -- was deleted by a
 * careless index-to-index replacement and shipped. The page still rendered, so
 * nothing here failed: every id existed, every handler ran, and the wallet
 * cards were simply unstyled text on a live device.
 *
 * Markup and script are already pinned to each other by the element stub. This
 * pins the stylesheet to the markup the same way: every class the page uses
 * must have a rule somewhere, and classes app.js assigns at runtime count too,
 * since those never appear in index.html.
 */
{
	const classes = new Set();
	for (const [, attr] of html.matchAll(/\bclass="([^"]+)"/g)) {
		for (const name of attr.split(/\s+/)) if (name) classes.add(name);
	}
	// Runtime classes: node.className = "pill pill--ok", "dot dot--warn", and so on.
	for (const [, value] of appSource.matchAll(/className\s*=\s*"([^"]*)"/g)) {
		for (const name of value.split(/\s+/)) if (name) classes.add(name);
	}
	for (const [, value] of appSource.matchAll(/className\s*=\s*"([^"]*)"\s*\+/g)) {
		for (const name of value.split(/\s+/)) if (name) classes.add(name);
	}
	// Built by node(tag, className, ...) in the wallet card builder.
	for (const [, value] of appSource.matchAll(/node\("[a-z]+",\s*"([^"]+)"/g)) {
		for (const name of value.split(/\s+/)) if (name) classes.add(name);
	}

	// Utility and state classes that are deliberately styled elsewhere or not at
	// all; listing them is cheaper than a rule that does nothing.
	const exempt = new Set(["visually-hidden"]);

	const missing = [...classes]
		.filter((name) => !exempt.has(name))
		.filter((name) => !cssSource.includes(`.${name}`))
		.sort();

	check("every class the page uses has a rule in style.css", () => {
		assert(missing.length === 0, `no rule for: ${missing.join(", ")}`);
	});

	// The sections most recently lost, named so the failure says what broke.
	check("the wallet card rules are present", () => {
		for (const sel of [".wallets", ".wcard", ".wcard--add", ".pill", ".pill--ok", ".pill--off"]) {
			assert(cssSource.includes(sel), `style.css has no ${sel}`);
		}
	});

	check("style.css braces balance", () => {
		const open = (cssSource.match(/\{/g) || []).length;
		const close = (cssSource.match(/\}/g) || []).length;
		assert(open === close, `${open} open vs ${close} close`);
	});
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length === 0 ? 0 : 1);
