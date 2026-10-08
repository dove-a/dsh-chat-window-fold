// dsh-chat-window-fold — host half.
// The host half carries the row-config schema so the loader applies defaults
// and validation, and the announcement-free apply is a no-op: this plugin's
// whole capability lives in the browser half (exports "./client").
import z from "schemastery";

/** Row-config schema shared by the host loader; the client half also defense-in-depth validates its own numbers. */
export const Config = z.object({
	/** Event count above which a checkpoint decides to fold (keep the recent N rows). */
	foldThreshold: z.natural().min(10).max(2000).default(50),
	/** Session-event interval between fold checkpoints. */
	foldCheckEvery: z.natural().min(5).max(500).default(25),
	/**
	 * Opt-in memory guard: maximum number of older pages the plugin itself
	 * pulls into the session window while the user scrolls to the top.
	 * 0 (default) keeps the frozen behavior — pull until `hasMore` is false.
	 *
	 * The loaded window is append-only in this DSH version (the client event
	 * feed exposes prepend/append and no trim), so every auto-loaded page
	 * stays resident for the life of the session. On very long sessions a
	 * bounded value keeps the plugin's own contribution finite; pages loaded
	 * by the system's own "Load earlier" affordance are unaffected.
	 */
	maxExpandPages: z.natural().min(0).max(1000).default(0)
});

/**
 * No host-side behavior is required: the feature is purely a browser
 * rendering concern. The schema above still normalizes row config.
 * @param ctx - host plugin context (unused).
 */
export function apply(ctx) {
	// Intentionally empty — config normalization is performed by the loader.
	void ctx;
}