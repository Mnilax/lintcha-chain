// The two vendored tables site/launch.js needs, put on the global object before it runs.
//
// This file exists for one reason: ordering. site/launch.js is a UMD factory, and which of its two branches
// runs is the bundler's decision, not ours.
//
//   the require branch   `typeof module === "object" && module.exports` — the bundler hands it module and
//                        exports, and it requires ./launch-skeleton.js and ./launch-links.js itself. This is
//                        the branch Node takes, and it is the branch the collector and the index writer take,
//                        because both of them load the engine with createRequire.
//   the global branch    otherwise it reads root.LaunchSkeleton and root.LaunchLinks off self. This is the
//                        branch the page takes, from three script tags in the template.
//
// A module's imports are evaluated before its own body, so the tables cannot be assigned in the body of the
// file that imports the engine: they would be assigned too late. They are assigned here instead, and this
// module is imported before the engine by bot/src/engine.js.
//
// On the require branch these two assignments are dead weight, and that is the point: whichever branch the
// bundler picks, the engine finds what it needs and not one byte of any vendored file is edited.
//
// The namespace imports are deliberate. A default import would be a link time error on the branch where the
// vendored file has no exports at all; a namespace import never fails to link, and each table is then taken
// from whichever place its own file put it.
import * as SkeletonModule from "../../site/launch-skeleton.js";
import * as LinksModule from "../../site/launch-links.js";

const table = (mod, name) => (mod && mod.default) || globalThis[name] || null;

if (!globalThis.LaunchSkeleton) globalThis.LaunchSkeleton = table(SkeletonModule, "LaunchSkeleton");
if (!globalThis.LaunchLinks) globalThis.LaunchLinks = table(LinksModule, "LaunchLinks");

export const SKELETON_PATH = "site/launch-skeleton.js";
export const LINKS_PATH = "site/launch-links.js";
