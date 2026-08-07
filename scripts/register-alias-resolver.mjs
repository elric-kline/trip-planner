import { register } from "node:module";

// The entry point passed to `node --import` -- module customization hooks
// (resolve/load) only take effect via module.register(), not by exporting
// them from an --import'd file directly (that's the older, deprecated
// --experimental-loader shape). See alias-resolver-hooks.mjs for what this
// actually does.
register("./alias-resolver-hooks.mjs", import.meta.url);
