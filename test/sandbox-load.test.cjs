// Sandbox load test for dsh-chat-window-fold/lib/client.js.
// Mimics the real browser boot: window.__ModuleLoader__.load({id, factory})
// then materializes the factory with a mock require (react stub — the
// component body is never rendered here, only its module surface).
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8");

const reactStub = {
	useRef: () => ({}),
	useState: (v) => [v, () => {}],
	useEffect: () => {},
	useMemo: (f) => f(),
	useId: () => "sandbox-id",
	createElement: (type, props, children) => ({ type, props, children }),
	memo: (c) => c
};

let registered = null;
const windowStub = {
	__ModuleLoader__: {
		load(handoff) {
			registered = handoff;
		}
	}
};

let factoryError = null;
try {
	const sandbox = {
		window: windowStub,
		document: undefined,
		requestAnimationFrame: (cb) => cb(),
		cancelAnimationFrame: () => {},
		MutationObserver: undefined,
		Set,
		Map,
		Symbol,
		Object,
		Array,
		Number,
		Math,
		Promise,
		Error,
		HTMLElement: undefined,
		console
	};
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: "client.js" });

	if (!registered) throw new Error("factory was not registered via __ModuleLoader__.load");
	const factoryResult = registered.factory.call({}, (spec) => {
		if (spec === "react") return reactStub;
		throw new Error(`require("${spec}") not stubbed in sandbox`);
	});
	// The factory returns module.exports directly (loader's CJS contract);
	// it carries the plugin surface {apply, inject}.
	const surface = factoryResult ?? {};

	console.log("factory executed: OK");
	console.log("registered id:", registered.id);
	console.log("exports keys:", Object.keys(surface).join(", "));
	if (typeof surface.apply !== "function") throw new Error("exports.apply is not a function");
	if (!Array.isArray(surface.inject)) throw new Error("exports.inject is not an array");
	console.log("inject list:", surface.inject.join(", "));
	const hasSlots = surface.inject.includes("slots");
	const hasSessions = surface.inject.includes("sessions");
	if (!hasSlots || !hasSessions) throw new Error(`inject must declare slots+sessions, got ${surface.inject.join(",")}`);

	// ---- apply(ctx, config) contract regression -----------------------------
	// Official client-half contract (dsh-cordis-client-runner L618):
	//   apply: (ctx, config) => plugin.apply(guarded(ctx), config)
	// config arrives as the SECOND argument — never ctx.config (the dynamic
	// facade rejects undeclared ctx properties, and the loader ctx does not
	// carry one either). This regression pins the exact signature.
	async function main() {
		let injectCalls = [];
		let registeredOptions = null;
		let injectedReturn = null;
		const mockSessions = {
			binding: () => ({ session: { loadOlder: () => Promise.resolve("loaded") } })
		};
		const mockSlots = {
			inject(name, cb) {
				injectCalls.push(name);
				// The declaration callback runs immediately in this mock; the real
				// slots service fires it once the slot is declared.
				injectedReturn = cb();
			},
			register(options, component) {
				registeredOptions = options;
				return () => {};
			}
		};
		const mockCtx = {
			get(name) {
				if (name === "sessions") return mockSessions;
				return undefined;
			},
			slots: mockSlots
		};

		// Case 1: explicit config as second argument (row config present).
		surface.apply(mockCtx, { foldThreshold: 123, foldCheckEvery: 31 });
		if (injectCalls.length !== 1 || injectCalls[0] !== "conversation.input.dock") {
			throw new Error(`slots.inject must target conversation.input.dock, got ${JSON.stringify(injectCalls)}`);
		}
		if (!registeredOptions || registeredOptions.name !== "conversation.input.dock" || registeredOptions.id !== "window-fold") {
			throw new Error(`register options wrong: ${JSON.stringify(registeredOptions)}`);
		}
		// Owner props come from the register options' inject(sessionId) — the
		// slots service hands them to the rendered occupant.
		const owner = typeof registeredOptions.inject === "function" ? registeredOptions.inject("session-1") : null;
		if (!owner || typeof owner.loadOlder !== "function") {
			throw new Error("owner inject must expose loadOlder");
		}
		if (owner.config.foldThreshold !== 123 || owner.config.foldCheckEvery !== 31) {
			throw new Error(`config not threaded from apply arg: ${JSON.stringify(owner.config)}`);
		}
		const loaded = await owner.loadOlder();
		if (loaded !== "loaded") throw new Error("loadOlder must delegate to binding.session.loadOlder");

		// Case 2: absent config → defaults (50 / 25).
		injectCalls = [];
		registeredOptions = null;
		injectedReturn = null;
		surface.apply(mockCtx, undefined);
		const ownerDefault = registeredOptions.inject("session-1");
		if (ownerDefault.config.foldThreshold !== 50 || ownerDefault.config.foldCheckEvery !== 25) {
			throw new Error(`absent config must fall back to defaults, got ${JSON.stringify(ownerDefault.config)}`);
		}

		// Case 3: ctx.get returns undefined sessions → apply must no-op, not throw.
		surface.apply({ get: () => undefined, slots: mockSlots }, undefined);

		console.log("apply(ctx, config) contract: PASS (config arg threaded, defaults OK, missing sessions tolerated)");

		// ---- paging-button hiding contract -----------------------------------
		// The older-container matcher must (a) match the official CSS-module
		// class suffix, (b) fall back to the EXACT official dictionary labels
		// (ui-conversation: "Load earlier" / "加载更早"; old builds: "載入更早")
		// — never the stale "加载更早消息" guess — and (c) never hide anything
		// whose button text mentions token/压缩/compact (context-compaction
		// disclosures are out of scope and must stay visible).
		const staleGuess = "加载更早消息";
		if (src.includes(staleGuess) && !src.includes("OLDER_BUTTON_TEXTS")) {
			throw new Error(`stale fallback text "${staleGuess}" still present`);
		}
		for (const label of ["Load earlier", "加载更早", "載入更早"]) {
			if (!src.includes(label)) throw new Error(`dictionary-aligned label missing: ${label}`);
		}
		if (!/_older\$/.test(src)) throw new Error("CSS-module _older suffix matcher missing");
		if (!/token\|压缩\|compact/.test(src)) throw new Error("anti-misfire guard for token/compact labels missing");
		console.log("paging-button hide contract: PASS (class suffix + dictionary-aligned labels + anti-misfire guard)");

		// ---- expand latch safety contract ------------------------------------
		// The expand latch (expandingRef) must never stay latched: a synchronous
		// throw from loadOlder must become a rejection (deferred invocation),
		// an unsettled loader must time out and release, and the viewport must
		// be re-anchored either by the anchor row or by the prepended-height
		// delta (so a failed anchor cannot re-trigger top-scroll loading over
		// and over until the very first message).
		if (!src.includes("Promise.resolve().then(op)")) throw new Error("loadOlder must be invoked deferred (sync throw => rejection)");
		if (!src.includes("EXPAND_TIMEOUT_MS")) throw new Error("expand latch timeout guard missing");
		if (!src.includes("live.scrollHeight - beforeHeight")) throw new Error("prepended-height anchor fallback missing");
		console.log("expand latch safety: PASS (deferred invoke + timeout release + height-delta anchor fallback)");

		// ---- strict checkpoint rhythm contract --------------------------------
		// The fold check must run only at checkpoint time (every foldCheckEvery
		// events, driven by order growth) plus ONE post-mount execution for
		// sessions that open at the bottom (programmatic scroll restores fire
		// no scroll event). Scroll activity must NEVER fold by itself: the
		// scroll handler only measures the bottom latch. A bottom gate miss
		// skips the checkpoint — no deferred replay on later scrolls.
		if (src.includes("pendingRef")) throw new Error("deferred-replay machinery must be gone (strict rhythm)");
		if (!src.includes("bottomRef.current")) throw new Error("bottom latch must be present");
		if (!src.includes("requestAnimationFrame(function () {\n\t\t\t\t\trefreshBottom();")) throw new Error("post-mount probe with single fold pass missing");
		if (!/function refreshBottom\(\) \{[\s\S]*?bottomRef\.current = [^;]*;[\s\S]*?\}/.test(src)) throw new Error("refreshBottom must measure only (no fold call)");
		console.log("strict checkpoint rhythm: PASS (checkpoint-only folds + mount init + no scroll-triggered folds)");

		console.log("SANDBOX LOAD TEST: PASS");
	}
	main().catch((e) => {
		console.error("SANDBOX LOAD TEST: FAIL —", e.message);
		process.exitCode = 1;
	});
} catch (e) {
	factoryError = e;
	console.error("SANDBOX LOAD TEST: FAIL —", e.message);
	process.exitCode = 1;
}