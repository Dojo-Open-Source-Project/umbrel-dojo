/*
 * Umbrel home-screen widget: next-block fee estimates.
 *
 * Dojo already runs the nextblock estimator. estimator/index.js constructs
 * @dojo-tools/next-block-estimator -- the algorithm behind nextblock.is,
 * formerly @samouraiwallet/one-dollar-fee-estimator -- against bitcoind's RPC
 * and pushes each update over pm2 IPC to lib/bitcoind-rpc/fees.js, which
 * accounts/fees-rest-api.js serves at GET /fees/estimator. Nothing in the app
 * read it until this.
 *
 * All this process does is reshape that into the JSON umbrelOS's widget system
 * expects. It exists as its own container rather than as a loop inside nginx
 * or a pm2 app inside the node image for two reasons: Docker's restart policy
 * supervises it on its own (a poller sharing a container with nginx would die
 * quietly and leave the widget showing stale numbers), and it needs no Dojo
 * source change. That is the same shape mempool, transmission and nostr-relay
 * use for their widgets.
 *
 * umbreld fetches the endpoint itself, unauthenticated, bypassing app_proxy --
 * so port 3000 is deliberately not published to the host by the compose file.
 */

import http from "node:http";

const NODE_HOST = process.env.NODE_HOST || "dojo_node_1";
const NODE_PORT = Number(process.env.NODE_PORT || 8080);
const API_KEY = process.env.NODE_API_KEY || "";
const PORT = Number(process.env.WIDGET_PORT || 3000);

const BASE = `http://${NODE_HOST}:${NODE_PORT}`;

// Dojo's estimator recomputes every 20s (estimator/index.js, refresh: 20), so
// asking it more often than this buys nothing. It decouples our poll rate from
// umbreld's: the manifest asks every 30s, but nothing stops a second widget
// instance or a manual curl.
const MIN_REFRESH_MS = 15_000;

const REQUEST_TIMEOUT_MS = 8_000;

// The estimator keys its feerates by the probability that a transaction paying
// that rate makes the NEXT block. 0.1 and 0.2 are omitted deliberately: a
// feerate with a one-in-ten shot at the next block is not a fee anyone picks.
const TARGETS = [
	["0.5", "50% chance"],
	["0.9", "90% chance"],
	["0.99", "99% chance"],
	["0.999", "99.9% chance"],
];

/** @type {string | null} */
let token = null;

/** @type {{ at: number, items: object[] | null }} */
let cache = { at: 0, items: null };

function log(message) {
	process.stdout.write(`Widget : ${message}\n`);
}

/**
 * Exchange the API key for a short-lived JWT.
 *
 * keys.index.js sets auth.mandatory, so /fees/estimator will not answer
 * without one. The API key rather than the admin key on purpose: the route
 * only needs checkAuthentication, not checkHasAdminProfile, so the admin key
 * never has to enter this container.
 */
async function login() {
	const response = await fetch(`${BASE}/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `apikey=${encodeURIComponent(API_KEY)}`,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`);
	const body = await response.json();
	const accessToken = body?.authorizations?.access_token;
	if (!accessToken) throw new Error("login returned no access token");
	return accessToken;
}

/**
 * GET an authenticated route, re-logging in exactly once on a 401.
 *
 * Dojo's access token expires in NODE_JWT_ACCESS_EXPIRES seconds -- 900 in our
 * compose -- so a long-lived process must expect to be told no eventually.
 */
async function authedGet(path, allowRelogin = true) {
	if (!token) token = await login();

	const response = await fetch(`${BASE}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (response.status === 401 && allowRelogin) {
		token = null;
		return authedGet(path, false);
	}

	return response;
}

/**
 * The current feerates, or null when Dojo cannot report any.
 *
 * Fees.getEstimatorFees() throws estimator.NOT_AVAILABLE until bitcoind's
 * mempool is fully loaded and the route answers 503. That is a real state on
 * every restart, and null is how it reaches the widget -- never a stale figure
 * from before the restart and never a fabricated one.
 */
async function fetchFees() {
	const response = await authedGet("/fees/estimator");

	if (response.status === 503) return null;
	if (!response.ok) throw new Error(`fees: HTTP ${response.status}`);

	const body = await response.json();
	// sendOkDataOnly returns the figures bare, but /pushtx/status/ taught us
	// not to assume which helper a Dojo route happens to use: accept either.
	return (body && body.data) || body;
}

function itemsFrom(fees) {
	return TARGETS.map(([key, title]) => {
		const rate = fees == null ? null : fees[key];
		const known = typeof rate === "number" && Number.isFinite(rate);
		return {
			title,
			text: known ? String(rate) : "—",
			subtext: known ? "sat/vB" : "starting",
		};
	});
}

async function items() {
	const now = Date.now();
	if (cache.items && now - cache.at < MIN_REFRESH_MS) return cache.items;

	try {
		const next = itemsFrom(await fetchFees());
		cache = { at: now, items: next };
	} catch (error) {
		// Dojo unreachable, still booting, or refusing the key. Report not
		// knowing rather than the last numbers we happened to see -- the whole
		// point of a fee widget is that the figure is current.
		log(`could not read fee estimates: ${error.message}`);
		cache = { at: now, items: itemsFrom(null) };
	}

	return cache.items;
}

const server = http.createServer((request, response) => {
	const path = (request.url || "").split("?")[0];

	if (request.method !== "GET" || path !== "/widgets/fees") {
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("not found\n");
		return;
	}

	items()
		.then((list) => {
			const body = JSON.stringify({
				type: "four-stats",
				link: "",
				/* Required, and not redundant with the manifest's own refresh.
				 *
				 * umbreld/source/modules/widgets/routes.ts post-processes every
				 * widget response with `widgetData.refresh = ms(widgetData.refresh)`,
				 * outside any try/catch, and ms() throws on anything that is not a
				 * non-empty string or a finite number. Omitting this rejects the
				 * whole tRPC query, and the UI -- which passes retry: false and
				 * falls back to undefined on isError -- then renders four
				 * LOADING_DASH cells. That is a widget showing nothing, from a
				 * fetch that succeeded. It shipped in patch.7.
				 *
				 * The manifest's refresh is only the placeholder the UI holds
				 * until data arrives; this is the value that actually sets the
				 * poll interval.
				 */
				refresh: "30s",
				items: list,
			});
			response.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			});
			response.end(body);
		})
		.catch((error) => {
			// items() swallows its own failures, so this is unreachable today.
			// Without it, a future one would leave the request hanging instead
			// of failing -- and a hung widget fetch looks exactly like a slow
			// one, which is the hardest kind of fault to find.
			log(`failed to build the widget response: ${error.message}`);
			response.writeHead(500, { "Content-Type": "text/plain" });
			response.end("widget unavailable\n");
		});
});

server.listen(PORT, () => {
	// The bound port, not PORT: 0 means "let the kernel pick", which the tests
	// use so they never have to guess a free one.
	log(`serving /widgets/fees on ${server.address().port}, reading ${BASE}/fees/estimator`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}
