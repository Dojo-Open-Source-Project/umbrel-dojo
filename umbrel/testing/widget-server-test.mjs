#!/usr/bin/env node
/*
 * Widget server tests.
 *
 *   node umbrel/testing/widget-server-test.mjs
 *
 * umbrel/images/widget/server.mjs is run as a real child process against a
 * stub standing in for Dojo's accounts API, so the contract that matters --
 * the exact JSON umbreld will parse -- is asserted end to end over HTTP. No
 * Docker, no Bitcoin node.
 *
 * The cases are the ones that will actually happen on a device: a cold Dojo
 * whose estimator is not ready, a Dojo that is not up yet, and a JWT that has
 * expired out from under a long-lived process.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "images", "widget", "server.mjs");

const API_KEY = "test-api-key";

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

/**
 * What umbreld does to every widget response before the UI ever sees it.
 *
 * umbreld/source/modules/widgets/routes.ts, the `data` procedure:
 *
 *     widgetData = await ctx.apps.getApp(appId).getWidgetData(widgetName)
 *     // Parse refresh time from human-readable string to milliseconds
 *     widgetData.refresh = ms(widgetData.refresh)
 *
 * There is no try/catch, and `ms()` throws on anything that is not a non-empty
 * string or a finite number. So a response without a `refresh` field fails the
 * whole tRPC query, and because the UI passes `retry: false` and falls back to
 * `undefined` on `isError`, the widget renders LOADING_DASH
 * cells -- a widget that displays nothing. That shipped in patch.7.
 *
 * It is reproduced here rather than asserted as "has a refresh key" because
 * the lesson of that bug is that our fixtures modelled our own contract
 * instead of our consumer's.
 */
function umbreldParseRefresh(body) {
	const value = body.refresh;
	if (typeof value === "string" && value.length > 0) {
		const match = /^(-?\d*\.?\d+) *(ms|s|m|h|d|w|y)?$/i.exec(value);
		if (!match) throw new Error(`ms() cannot parse refresh ${JSON.stringify(value)}`);
		const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
		return Number(match[1]) * (scale[(match[2] || "ms").toLowerCase()] ?? 1);
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new Error(
		`ms() throws: refresh is not a non-empty string or a valid number. refresh=${JSON.stringify(value)}`
	);
}

/* ------------------------------------------------------------- the stub Dojo */

/**
 * A stand-in for the accounts API on :8080.
 *
 * `fees` decides what GET /fees/estimator does on each call; it receives the
 * call index so a case can fail once and then succeed. Returning a number
 * means "answer with this status and no body", which is how the 503 the real
 * route sends while the mempool loads is reproduced.
 */
function startDojo({ fees }) {
	const calls = { login: 0, fees: 0, tokens: [] };
	let issued = 0;

	const server = createServer((request, response) => {
		const path = (request.url || "").split("?")[0];

		if (request.method === "POST" && path === "/auth/login") {
			calls.login += 1;
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				if (body !== `apikey=${encodeURIComponent(API_KEY)}`) {
					response.writeHead(401).end();
					return;
				}
				issued += 1;
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({ authorizations: { access_token: `jwt-${issued}` } })
				);
			});
			return;
		}

		if (request.method === "GET" && path === "/fees/estimator") {
			calls.fees += 1;
			calls.tokens.push(request.headers.authorization || null);
			const outcome = fees(calls.fees);
			if (typeof outcome === "number") {
				response.writeHead(outcome).end();
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(outcome));
			return;
		}

		response.writeHead(404).end();
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ port: server.address().port, calls, stop: () => server.close() });
		});
	});
}

/* ------------------------------------------------------------- the subject */

async function startWidget(nodePort) {
	const child = spawn(process.execPath, [serverPath], {
		env: {
			...process.env,
			NODE_HOST: "127.0.0.1",
			NODE_PORT: String(nodePort),
			NODE_API_KEY: API_KEY,
			WIDGET_PORT: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	// WIDGET_PORT=0 lets the kernel pick, and the server announces what it got
	// on its first log line. Parsing that beats guessing a free port.
	const port = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("widget never announced a port")), 10_000);
		let seen = "";
		child.stdout.on("data", (chunk) => {
			seen += chunk;
			const match = seen.match(/serving \/widgets\/fees on (\d+)/);
			if (match) {
				clearTimeout(timer);
				resolve(Number(match[1]));
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`widget exited early with ${code}`));
		});
	});

	return {
		get: async (path) => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`);
			const text = await response.text();
			// Every successful widget response goes through umbreld's refresh
			// parse, so the harness does too -- including the not-ready and
			// unreachable paths, which are exactly where a missing field would
			// otherwise hide.
			if (response.status === 200 && path === "/widgets/fees") {
				umbreldParseRefresh(JSON.parse(text));
			}
			return { status: response.status, text };
		},
		stop: () => child.kill("SIGKILL"),
	};
}

/**
 * Run one case with both halves torn down whatever happens, so a failing
 * assertion cannot leave a listener behind and wedge the rest of the run.
 */
async function withStack(options, fn) {
	const dojo = options.dojoPort === undefined ? await startDojo(options) : null;
	const nodePort = dojo ? dojo.port : options.dojoPort;
	const widget = await startWidget(nodePort);
	try {
		await fn({ widget, dojo });
	} finally {
		widget.stop();
		if (dojo) dojo.stop();
	}
}

const READY = { 0.1: 1, 0.2: 1, 0.5: 3, 0.9: 5, 0.99: 8, 0.999: 12 };

/* -------------------------------------------------------------- happy path */

await withStack({ fees: () => READY }, async ({ widget }) => {
	const { status, text } = await widget.get("/widgets/fees");
	const body = JSON.parse(text);

	check("the widget answers 200 with the three-stats envelope", () => {
		assert(status === 200, `got ${status}`);
		assert(body.type === "three-stats", `got type ${body.type}`);
		assert(body.link === "", `got link ${JSON.stringify(body.link)}`);
		assert(Array.isArray(body.items), "items must be a list");
	});

	check("the response carries the refresh umbreld insists on", () => {
		// Not redundant with the manifest's refresh: the manifest value is only
		// the placeholder the UI holds before data arrives, while this one is
		// what umbreld feeds to ms() and what then drives the poll interval.
		assert(umbreldParseRefresh(body) === 30_000, `got ${JSON.stringify(body.refresh)}`);
	});

	check("it shows the three levels with their probabilities, in order", () => {
		assert(body.items.length === 3, `got ${body.items.length} items`);
		// three-stats renders subtext above text, so the level is the subtext,
		// and it has no title field at all.
		const levels = body.items.map((item) => item.subtext);
		assert(levels.join(" | ") === "Low 10% | Med 50% | High 99%", `got ${levels.join(" | ")}`);
		assert(body.items.every((item) => item.title === undefined), "three-stats has no title");
	});

	check("each level carries its feerate with the unit", () => {
		// No separate unit field in three-stats, so it rides with the figure.
		const texts = body.items.map((item) => item.text);
		assert(
			texts.join(" | ") === "1 sat/vB | 3 sat/vB | 8 sat/vB",
			`got ${texts.join(" | ")}`
		);
	});

	check("the levels the page does not publish stay out of the widget", () => {
		// Dojo reports six probabilities. Only three are published, and the two
		// surfaces must not disagree about which.
		assert(!text.includes("5 sat/vB"), "the 90% rate leaked into the widget");
		assert(!text.includes("12 sat/vB"), "the 99.9% rate leaked into the widget");
	});
});

/* --------------------------------------------- the wrapped response shape */

await withStack(
	{ fees: () => ({ status: "ok", data: READY }) },
	async ({ widget }) => {
		const body = JSON.parse((await widget.get("/widgets/fees")).text);
		check("a {status, data} wrapped payload is read the same way", () => {
			// /fees/estimator answers through sendOkDataOnly today, but
			// /pushtx/status/ went red for a year because the page assumed which
			// helper a route used. Tolerating both costs one expression.
			assert(
				body.items.map((item) => item.text).join(" | ") === "1 sat/vB | 3 sat/vB | 8 sat/vB",
				`got ${body.items.map((item) => item.text).join(",")}`
			);
		});
	}
);

/* ----------------------------------------- the estimator is not ready yet */

await withStack({ fees: () => 503 }, async ({ widget }) => {
	const { status, text } = await widget.get("/widgets/fees");
	const body = JSON.parse(text);

	check("a 503 from the estimator shows an honest unknown, not a number", () => {
		assert(status === 200, `the widget itself must still answer; got ${status}`);
		assert(
			body.items.every((item) => item.text === "—"),
			`got ${body.items.map((i) => i.text).join(",")}`
		);
		assert(
			body.items.map((item) => item.subtext).join(" | ") === "Low 10% | Med 50% | High 99%",
			`the levels stay labelled; got ${body.items.map((i) => i.subtext).join(" | ")}`
		);
		assert(!/\d/.test(body.items.map((i) => i.text).join("")), "a digit got through");
	});
});

/* ------------------------------------------------- Dojo is not up at all */

{
	// A port nothing is listening on: the state on every app start, before the
	// node container answers.
	const dead = await startDojo({ fees: () => READY });
	const deadPort = dead.port;
	dead.stop();
	await new Promise((resolve) => setTimeout(resolve, 50));

	await withStack({ dojoPort: deadPort }, async ({ widget }) => {
		const body = JSON.parse((await widget.get("/widgets/fees")).text);
		check("an unreachable Dojo shows unknown rather than failing the request", () => {
			assert(
				body.items.every((item) => item.text === "—"),
				`got ${body.items.map((i) => i.text).join(",")}`
			);
		});
	});
}

/* ------------------------------------------------------- the JWT expires */

await withStack(
	{ fees: (call) => (call === 1 ? 401 : READY) },
	async ({ widget, dojo }) => {
		const body = JSON.parse((await widget.get("/widgets/fees")).text);

		check("a 401 triggers exactly one re-login and then succeeds", () => {
			assert(dojo.calls.login === 2, `expected 2 logins, got ${dojo.calls.login}`);
			assert(dojo.calls.fees === 2, `expected 2 fee calls, got ${dojo.calls.fees}`);
			assert(
				body.items.map((item) => item.text).join(" | ") === "1 sat/vB | 3 sat/vB | 8 sat/vB",
				`got ${body.items.map((item) => item.text).join(",")}`
			);
		});

		check("the retry uses a freshly minted token", () => {
			assert(
				dojo.calls.tokens.join(",") === "Bearer jwt-1,Bearer jwt-2",
				`got ${dojo.calls.tokens.join(",")}`
			);
		});
	}
);

/* ----------------------------------------------------------- the 401 loop */

await withStack({ fees: () => 401 }, async ({ widget, dojo }) => {
	const body = JSON.parse((await widget.get("/widgets/fees")).text);

	check("a key Dojo keeps rejecting does not retry forever", () => {
		// Without the once-only guard this is an unbounded recursion that takes
		// the container down with it.
		assert(dojo.calls.fees === 2, `expected 2 fee calls, got ${dojo.calls.fees}`);
		assert(
			body.items.every((item) => item.text === "—"),
			`got ${body.items.map((i) => i.text).join(",")}`
		);
	});
});

/* ----------------------------------------------------------- the cache */

await withStack({ fees: () => READY }, async ({ widget, dojo }) => {
	await widget.get("/widgets/fees");
	await widget.get("/widgets/fees");
	await widget.get("/widgets/fees");

	check("repeat polls inside the refresh window hit Dojo once", () => {
		// Dojo's estimator only recomputes every 20s, so asking it per request
		// would be pure load for an identical answer.
		assert(dojo.calls.fees === 1, `expected 1 fee call, got ${dojo.calls.fees}`);
	});
});

/* --------------------------------------------------------- nothing else */

await withStack({ fees: () => READY }, async ({ widget }) => {
	const root = await widget.get("/");
	const other = await widget.get("/widgets/anything");
	check("unknown paths 404", () => {
		assert(root.status === 404, `/ gave ${root.status}`);
		assert(other.status === 404, `/widgets/anything gave ${other.status}`);
	});
});

{
	const h = await startDojo({ fees: () => READY });
	const w = await startWidget(h.port);
	const body = JSON.parse((await w.get("/widgets/fees")).text);
	check("the labels stay short enough not to truncate", () => {
		// three-stats applies `truncate` to both lines and gives each item about
		// a third of a small widget. There is no way to measure that from here,
		// so the guard is a length ceiling rather than a rendered check.
		body.items.forEach((item) => {
			assert(item.subtext.length <= 9, `subtext too long: ${item.subtext}`);
			assert(item.text.length <= 12, `text too long: ${item.text}`);
		});
	});
	w.stop(); h.stop();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length === 0 ? 0 : 1);
