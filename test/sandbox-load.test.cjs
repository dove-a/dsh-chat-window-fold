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
	console.log("SANDBOX LOAD TEST: PASS");
} catch (e) {
	factoryError = e;
	console.error("SANDBOX LOAD TEST: FAIL —", e.message);
	process.exitCode = 1;
}