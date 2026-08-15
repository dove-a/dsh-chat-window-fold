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
	foldCheckEvery: z.natural().min(5).max(500).default(25)
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