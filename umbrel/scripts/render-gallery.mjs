#!/usr/bin/env node
/*
 * Render the community store's gallery screenshots from the real page.
 *
 *   npm i --no-save playwright          # once, anywhere on NODE_PATH
 *   pip install Pillow                  # for the final resize
 *   CHROMIUM=/path/to/chrome node umbrel/scripts/render-gallery.mjs
 *
 * Writes umbrel/assets/gallery/{1,2,3,4}.jpg at 1920x1080. The store
 * generator copies them into the store repo; the official package ships
 * `gallery: []` because Umbrel's team produces its own.
 *
 * Fixtures, never a device. A real pairing QR encodes a live API key and the
 * onion address, so a screenshot of a real install publishes a credential.
 * Every value below is an obvious placeholder.
 *
 * The page is served from umbrel/images/nginx/connect/ as it is, with fetch
 * and WebSocket replaced in the browser before app.js runs -- nothing on disk
 * is copied or edited, so what is rendered is exactly what ships.
 *
 * Dark, through the browser's own prefers-color-scheme rather than a
 * rewritten stylesheet, so the screenshots use the page's real dark tokens.
 * Each is one viewport, not a full-page capture: full-page captures misplace
 * the fixed tab bar and can leave an unpainted band at the bottom.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const connect = join(repo, "umbrel", "images", "nginx", "connect");
const out = join(repo, "umbrel", "assets", "gallery");

// 1600 x 900 CSS pixels at 1.2x is exactly 1920 x 1080. A taller viewport
// than the old 1.4x set, so both rescan panels fit above the tab bar. Pillow
// still runs, for the JPEG encode and as a guard on the final size.
const VIEWPORT = { width: 1600, height: 900 };
const SCALE = 1.2;

// An install in the repo root resolves through the normal ESM walk up from
// this file. ESM ignores NODE_PATH, so that is tried by hand as a fallback for
// a Playwright installed somewhere else.
async function loadPlaywright() {
	try {
		return await import("playwright");
	} catch { /* fall through */ }
	const require = createRequire(import.meta.url);
	for (const dir of (process.env.NODE_PATH || "").split(":").filter(Boolean)) {
		try {
			return require(require.resolve("playwright", { paths: [dir] }));
		} catch { /* next */ }
	}
	return null;
}

const playwright = await loadPlaywright();
if (!playwright) {
	console.error("needs Playwright:  npm i --no-save playwright");
	process.exit(1);
}
const { chromium } = playwright;

const ONION = "dojoexampleonionaddressforscreenshotsonlyxxxxxxxxxxxxx.onion";

const CONF = `var conf = ${JSON.stringify({
	network: "bitcoin",
	chain: "bitcoin",
	dojoVersion: "1.29.3",
	dojoHiddenService: ONION,
	publicExplorer: "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion",
	dojoApiPort: "3024",
	deviceDomainName: "umbrel.local",
	adminKey: "example-admin-key-for-screenshots",
	supportPrefix: "support",
	pandoTxPush: "on",
	pandoTxProcess: "off",
	sorobanAnnounce: "off"
})};`;

/* Runs in the page before app.js. Shapes match what Dojo really sends --
 * pushtx's status and import/status are wrapped by sendOkData, the rest are
 * bare -- so the page takes the same code paths it does on a device. */
function fixtures(onion) {
	const day = 86_400_000;
	const now = Date.now();
	const keys = [
		{ apikeyID: 1, label: "Ashigaru", apikey: "example1", active: true,
			createdAt: new Date(now - 41 * day).toISOString(), expiresAt: new Date(now + 3609 * day).toISOString() },
		{ apikeyID: 2, label: "Sentinel watch-only", apikey: "example2", active: true,
			createdAt: new Date(now - 12 * day).toISOString(), expiresAt: new Date(now + 353 * day).toISOString() },
		{ apikeyID: 3, label: "Old phone", apikey: "example3", active: false,
			createdAt: new Date(now - 300 * day).toISOString(), expiresAt: new Date(now + 3350 * day).toISOString() }
	];
	const answer = (body, status = 200) => Promise.resolve({
		ok: status < 400, status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body))
	});
	window.__importStatus = { import_in_progress: true, status: "rescan", hits: 1284 };
	window.fetch = (url) => {
		if (url === "/onion") return answer(onion + "\n");
		if (/auth\/login$/.test(url)) return answer({ authorizations: { access_token: "example-token" } });
		if (/pushtx\/status\/$/.test(url)) return answer({ status: "ok", data: { bitcoind: { up: true, conn: 10, blocks: 917_284 } } });
		if (/fees\/estimator$/.test(url)) return answer({ 0.1: 2, 0.2: 3, 0.5: 4, 0.9: 7, 0.99: 11, 0.999: 18 });
		if (/import\/status$/.test(url)) return answer({ status: "ok", data: window.__importStatus });
		// Rescans never answer: the Tools shot is of jobs in flight.
		if (/\/rescan/.test(url)) return new Promise(() => {});
		if (/\/status\/$/.test(url)) return answer({ uptime: "12 days", blocks: 917_284, indexer: { type: "local_indexer", maxHeight: 917_284 } });
		if (/apikeys$/.test(url)) return answer(keys);
		if (/pairing$/.test(url)) return answer({ pairing: { type: "dojo.api", version: "1.29.3", apikey: "example-api-key" }, explorer: { type: "explorer.mempool_space", url: "http://mempoolexample.onion" } });
		return answer({}, 404);
	};
	window.__sockets = [];
	window.WebSocket = function (url) {
		this.url = url;
		this.send = () => {};
		this.close = () => {};
		window.__sockets.push(this);
		setTimeout(() => this.onopen && this.onopen(), 0);
	};
	window.__block = (height) => {
		for (const socket of window.__sockets) {
			socket.onmessage && socket.onmessage({ data: JSON.stringify({ op: "block", x: { height, hash: "" } }) });
		}
	};
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const server = createServer((req, res) => {
	const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
	if (path === "/js/conf.js") {
		res.writeHead(200, { "Content-Type": "text/javascript" });
		return res.end(CONF);
	}
	const file = normalize(join(connect, path === "/" ? "index.html" : path));
	if (!file.startsWith(connect) || !existsSync(file)) {
		res.writeHead(404);
		return res.end();
	}
	res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
	res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const scratch = mkdtempSync(join(tmpdir(), "dojo-gallery-"));
const errors = [];

async function open(hash) {
	const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "dark" });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(fixtures, ONION);
	await page.goto(`${base}/${hash}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(700);
	return page;
}

async function shoot(page, name) {
	await page.evaluate(() => document.fonts && document.fonts.ready);
	const png = join(scratch, name.replace(".jpg", ".png"));
	await page.screenshot({ path: png });
	execFileSync("python3", ["-c", `
import sys
from PIL import Image
Image.open(sys.argv[1]).convert("RGB").resize((1920, 1080), Image.LANCZOS).save(sys.argv[2], quality=88, optimize=True)
`, png, join(out, name)]);
	await page.close();
	console.log(`  ${name}`);
}

// 1. Home: chain state, fees, paired wallets, the tab bar.
await shoot(await open("#home"), "1.jpg");

// 2. Pairing: the dialog over Home, opened on a minted wallet's code.
{
	const page = await open("#home");
	// nth(0) is the default key's; nth(1) is the first minted wallet.
	await page.getByRole("button", { name: "Show code" }).nth(1).click();
	await page.waitForTimeout(500);
	await shoot(page, "2.jpg");
}

// 3. Tools: a block-range rescan part-way through, above a wallet rescan
//    counting the transactions it has found.
{
	const page = await open("#tools");
	await page.fill("#rescan-target", "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs");
	await page.dispatchEvent("#rescan-target", "input");
	await page.click("#rescan-run");
	await page.fill("#blocks-from", "916800");
	await page.fill("#blocks-to", "917284");
	await page.dispatchEvent("#blocks-to", "input");
	await page.click("#blocks-run");
	await page.waitForTimeout(200);
	// Enough blocks, spread over enough time, for the page to quote a rate.
	for (let i = 0; i < 300; i += 1) {
		await page.evaluate((height) => window.__block(height), 916_800 + i);
		if (i % 30 === 0) await page.waitForTimeout(300);
	}
	await page.waitForTimeout(1200);
	// Top of the wallet card near the top of the frame, unless that would
	// leave the block panel under the tab bar -- then whatever it takes to
	// clear it.
	// The page ends just below the block panel, so the browser clamps the
	// scroll and a sliver of the lookup card shows at the top. Extra bottom
	// padding for this one capture gives it the room; nothing else is touched.
	await page.evaluate(() => {
		document.body.style.paddingBottom = "260px";
		const wallet = document.getElementById("rescan-target").closest(".card");
		const blocks = document.getElementById("blocks-job").closest(".card");
		const tabbar = document.querySelector(".tabbar").getBoundingClientRect();
		const y = window.scrollY;
		// 8px: inside the 14px gap between cards, so no sliver of the card above.
		let target = wallet.getBoundingClientRect().top + y - 8;
		const clear = tabbar.top - 16;
		const bottom = blocks.getBoundingClientRect().bottom + y;
		if (bottom - target > clear) target = bottom - clear;
		window.scrollTo(0, target);
	});
	await page.waitForTimeout(300);
	await shoot(page, "3.jpg");
}

// 4. Advanced: transaction relay and the Maintenance Tool.
await shoot(await open("#advanced"), "4.jpg");

await browser.close();
server.close();
rmSync(scratch, { recursive: true, force: true });

if (errors.length) {
	console.error("page errors:\n  " + errors.join("\n  "));
	process.exit(1);
}
console.log(`written to ${out}`);
