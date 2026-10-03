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

	check("the widget answers 200 with the four-stats envelope", () => {
		assert(status === 200, `got ${status}`);
		assert(body.type === "four-stats", `got type ${body.type}`);
		assert(body.link === "", `got link ${JSON.stringify(body.link)}`);
		assert(Array.isArray(body.items), "items must be a list");
	});

	check("it shows the four confidence levels in ascending order", () => {
		assert(body.items.length === 4, `got ${body.items.length} items`);
		const titles = body.items.map((item) => item.title);
		assert(
			titles.join(" | ") === "50% chance | 90% chance | 99% chance | 99.9% chance",
			`got ${titles.join(" | ")}`
		);
	});

	check("each stat carries its feerate in sat/vB", () => {
		const texts = body.items.map((item) => item.text);
		assert(texts.join(",") === "3,5,8,12", `got ${texts.join(",")}`);
		assert(
			body.items.every((item) => item.subtext === "sat/vB"),
			`got ${body.items.map((i) => i.subtext).join(",")}`
		);
	});

	check("the 10% and 20% rates are not shown", () => {
		// Dojo reports six probabilities; a feerate with a one-in-ten shot at
		// the next block is not a fee anyone picks, so it must not appear.
		assert(!text.includes("10% chance"), "10% chance leaked into the widget");
		assert(!text.includes("20% chance"), "20% chance leaked into the widget");
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
				body.items.map((item) => item.text).join(",") === "3,5,8,12",
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
			body.items.every((item) => item.subtext === "starting"),
			`got ${body.items.map((i) => i.subtext).join(",")}`
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
				body.items.map((item) => item.text).join(",") === "3,5,8,12",
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

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length === 0 ? 0 : 1);
