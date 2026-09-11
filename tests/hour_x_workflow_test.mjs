// Static security contract for the manual Hour-X workflow. This test never invokes git, GitHub, an RPC endpoint or
// the activation itself; it makes the workflow's authority, secret boundary, exact changed-file set and review
// sequence explicit enough that a casual YAML edit cannot quietly weaken them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, ".github", "workflows", "hour-x.yml");
let checks = 0, failures = 0;
const ok = (condition, what) => {
  checks++;
  if (!condition) { failures++; console.log("  FAIL " + what); }
};
const count = (text, value) => text.split(value).length - 1;
const sorted = values => [...values].sort();
const same = (actual, expected) => JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
const between = (text, start, end) => {
  const from = text.indexOf(start);
  if (from < 0) return "";
  const to = text.indexOf(end, from + start.length);
  return to < 0 ? text.slice(from) : text.slice(from, to);
};

const workflow = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "";
const code = workflow.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");
const trigger = /^on:\n([\s\S]*?)^permissions:/m.exec(code)?.[1] || "";
const permissionBlock = /^permissions:\n((?:  [^\n]+\n)+)/m.exec(code)?.[1] || "";
const permissionRows = Object.fromEntries([...permissionBlock.matchAll(/^  ([a-z-]+): ([a-z]+)$/gm)].map(match => [match[1], match[2]]));
const inputNames = [...trigger.matchAll(/^      ([a-z_]+):$/gm)].map(match => match[1]);
const inputBlock = name => new RegExp(`^      ${name}:\\n((?:        [^\\n]+\\n)+)`, "m").exec(trigger)?.[1] || "";
const prep = between(code, "      - name: Validate and mask the public inputs without printing them", "      - name: Prove and prepare");
const activation = between(code, "      - name: Prove and prepare the pons-only activation without logging its inputs", "      - name: Recheck the product boundary");
const review = between(code, "      - name: Commit only status-derived activation files and open the guarded review", "\n\u0000");
const statusCase = between(review, '            case "${status_line}" in', "            esac");
const allowedPaths = [...statusCase.matchAll(/" M ([^"]+)"/g)].map(match => match[1]);
const requiredPaths = /for required_path in ([^;]+); do/.exec(review)?.[1].trim().split(/\s+/) || [];
const exactChangedPaths = [
  "README.md",
  "site/404.html",
  "site/es/index.html",
  "site/index.html",
  "site/pt/index.html",
  "site/token.json"
];

ok(workflow.length > 0 && !workflow.includes("\t"), "the workflow exists and uses YAML spaces, not tabs");
ok(/^name: hour-x$/m.test(code), "the workflow has the stable hour-x name");
ok(same([...trigger.matchAll(/^  ([a-z_]+):$/gm)].map(match => match[1]), ["workflow_dispatch"]), "workflow_dispatch is the only trigger");
ok(same(inputNames, ["contract_address", "pons_url"]), "the manual form has exactly the two public inputs");
for (const name of ["contract_address", "pons_url"]) {
  const block = inputBlock(name);
  ok(/^        description: \S.+$/m.test(block) && /^        required: true$/m.test(block) && /^        type: string$/m.test(block) && !/^        default:/m.test(block),
    `${name} is a required string with no stored default`);
}
ok(JSON.stringify(permissionRows) === JSON.stringify({ contents: "write", "pull-requests": "write", actions: "write" }) && count(code, "permissions:") === 1,
  "the token has only the three explicit write scopes and no job override");
ok(/^concurrency:\n  group: hour-x\n  cancel-in-progress: false$/m.test(code), "concurrent Hour-X runs serialize without cancellation");

const uses = [...code.matchAll(/^\s*uses: (\S+)$/gm)].map(match => match[1]);
ok(uses.length === 2 && uses.every(value => /^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/.test(value)), "both external actions are pinned by full commit SHA");
ok(/uses: actions\/checkout@[0-9a-f]{40}\n        with:\n          persist-credentials: false/.test(code), "checkout never persists the write credential");
ok(/uses: actions\/setup-node@[0-9a-f]{40}\n        with:\n          node-version: "24"/.test(code), "the workflow uses the repository's pinned Node major");

ok(!code.includes("${{ inputs.") && !code.includes("${{ github.event.inputs."), "raw workflow expressions never interpolate public inputs into a step");
ok(prep.includes("process.env.GITHUB_EVENT_PATH") && prep.includes("event.inputs.contract_address") && prep.includes("event.inputs.pons_url"), "input preparation reads only the event file and both declared values");
ok(prep.includes('import { tokenConfigOf } from "./lib/config-contract.mjs"') && prep.includes("tokenConfigOf({ address, pons, uniswap: null })") && !prep.includes("1024") && !prep.includes("new URL("), "input validation reuses the shared activation contract without duplicated limits or URL rules");
ok(prep.includes('replace(/%/g, "%25")') && prep.includes("::add-mask::") && prep.indexOf("::add-mask::") < prep.indexOf("fs.writeFileSync"), "raw and canonical values are command-escaped and masked before leaving validation");
ok(count(prep, 'mode: 0o600') === 2 && prep.includes('"hour-x-ca.txt"), config.address + "\\n"') && prep.includes('"hour-x-pons.txt"), config.pons + "\\n"') && !prep.includes("GITHUB_OUTPUT"), "only canonical masked inputs enter two fixed private runner-temp files with readable line termination");

const secretExpression = "${{ secrets.LINTCHA_CHAIN_RPC_URL }}";
ok(count(code, secretExpression) === 1 && activation.includes(secretExpression), "the RPC secret is referenced exactly once, only by the activation step");
ok(!code.replace(activation, "").includes("LINTCHA_CHAIN_RPC_URL"), "the RPC setting does not escape the activation step");
const requireSecretAt = activation.indexOf('if [ -z "${LINTCHA_CHAIN_RPC_URL:-}" ]');
const invokeAt = activation.indexOf('node tools/activate-token.mjs "${HOUR_X_CA}" "${HOUR_X_PONS_URL}" > /dev/null');
ok(requireSecretAt >= 0 && invokeAt > requireSecretAt, "an empty repository secret fails before the guarded activator runs");
ok(activation.includes('IFS= read -r HOUR_X_CA < "${RUNNER_TEMP}/hour-x-ca.txt"') && activation.includes('IFS= read -r HOUR_X_PONS_URL < "${RUNNER_TEMP}/hour-x-pons.txt"') && activation.includes("trap cleanup_inputs EXIT"), "the masked inputs are read without printing and removed on every activation exit");
ok(invokeAt >= 0 && !code.includes("npm run activate-token"), "the activator's stdout and npm's argument echo cannot enter the log");
ok(!/set\s+-x|printenv|toJSON\s*\(|::debug::|::notice::|upload-artifact/i.test(code) && !/(?:echo|printf)[^\n]*\$\{(?:HOUR_X_CA|HOUR_X_PONS_URL|LINTCHA_CHAIN_RPC_URL)/.test(code),
  "the workflow has no tracing, environment dump, artifact upload or value-print command");

const recheckAt = code.indexOf("node tests/chain_token_states.mjs");
const vendorAfterAt = code.indexOf("node tools/verify-vendor.mjs", recheckAt);
const statusAt = code.indexOf("git status --porcelain=v1 --untracked-files=all >");
ok(recheckAt >= 0 && vendorAfterAt > recheckAt && statusAt > vendorAfterAt, "never digests and the vendor boundary are rechecked before status is trusted");
ok(same(allowedPaths, exactChangedPaths) && allowedPaths.length === exactChangedPaths.length, "the case guard allows exactly the six activation modifications");
ok(same(requiredPaths, exactChangedPaths) && requiredPaths.length === exactChangedPaths.length, "all six allowed modifications are required, so a no-op or partial build fails");
ok(!statusCase.includes("sitemap") && !statusCase.includes("manifest") && !statusCase.includes("src/i18n"), "token-independent and ignored build outputs cannot enter the Hour-X commit");
ok(review.includes("sed 's/^ M //' \"${status_file}\" | sort > \"${paths_file}\"") && review.includes('git add --pathspec-from-file="${paths_file}"') && count(review, "git add ") === 1,
  "staging paths come only from the verified porcelain output");
ok(review.includes('git diff --cached --name-only | sort > "${staged_file}"') && review.includes('cmp -s "${paths_file}" "${staged_file}"') && review.includes("git diff --quiet"), "the staged set is reproduced exactly and leaves no unstaged change");

ok(code.includes('if [ "${GITHUB_REF}" != "refs/heads/main" ]') && code.includes('if [ "${head_sha}" != "${GITHUB_SHA}" ]'), "dispatch is pinned to main and its exact event revision");
ok(count(code, "git fetch --no-tags origin main") >= 4 && count(code, "git rev-parse origin/main") >= 4 && review.includes('if [ "$(git rev-parse HEAD)" != "${BASE_SHA}" ]'), "main and local HEAD are guarded before mutation, before push and after review checks");
ok(review.includes('git commit -m "token: guarded Hour-X activation"') && review.includes('branch="automation/hour-x-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"'), "commit and branch metadata are fixed and contain no public input");
ok(review.includes('gh pr create --draft --base main --head "${branch}" --title "token: guarded Hour-X activation" --body "Manual Hour-X activation prepared by the repository guard.'), "the automation opens a fixed-prose draft PR against main");
ok(!/(?:commit -m|--title|--body|branch=)[^\n]*(?:HOUR_X_CA|HOUR_X_PONS_URL|LINTCHA_CHAIN_RPC_URL|token\.json)/.test(review), "no input, secret or activated file is interpolated into branch, commit or PR metadata");

for (const name of ["test", "vendor"]) {
  ok(review.includes(`gh workflow run ${name}.yml --ref "\${branch}"`) &&
     review.includes(`gh run list --workflow ${name}.yml --branch "\${branch}" --commit "\${generated_sha}" --event workflow_dispatch`),
    `${name}.yml is explicitly dispatched and found only for the exact generated head`);
}
ok(review.includes('gh run watch "${test_run}" --exit-status') && review.includes('gh run watch "${vendor_run}" --exit-status'), "both required workflow runs must finish successfully");
ok(review.includes('--json headSha') && review.includes('--json event') && review.includes('--json conclusion') && review.includes('!= "${generated_sha}"') && review.includes('!= "workflow_dispatch"') && review.includes('!= "success"'),
  "each completed run is rechecked for exact head, event and successful conclusion");
ok(review.includes('git ls-remote origin "refs/heads/${branch}"') && review.includes('--json headRefOid') && review.includes('--json headRefName') && review.includes('--json baseRefName') && review.includes('--json isDraft'),
  "remote branch and draft PR identity are checked after CI");
ok(count(review, 'gh pr ready "${pr_url}"') === 1 && review.indexOf('gh pr ready "${pr_url}"') > review.indexOf('gh run watch "${vendor_run}"') && review.includes('gh pr ready --undo "${pr_url}"'),
  "the PR becomes ready only after CI and is returned to draft if the final race check fails");
ok(!/gh pr merge|--auto|git push origin main|wrangler|deploy|release|git tag/i.test(review), "Hour-X neither merges nor deploys, releases or tags anything");
ok(!prep.includes("GITHUB_OUTPUT") && !activation.includes("GITHUB_OUTPUT") && !/(HOUR_X_CA|HOUR_X_PONS_URL|LINTCHA_CHAIN_RPC_URL)[^\n]*GITHUB_OUTPUT|GITHUB_OUTPUT[^\n]*(HOUR_X_CA|HOUR_X_PONS_URL|LINTCHA_CHAIN_RPC_URL)/.test(code), "no public input or RPC setting reaches a workflow output");
const outputLines = code.split("\n").filter(line => line.includes("GITHUB_OUTPUT"));
ok(outputLines.length === 1 && outputLines[0].includes('echo "sha=${head_sha}"') && !code.includes("GITHUB_ENV"), "the exact base SHA is the only workflow output and no input is exported globally");

console.log(`hour-x workflow: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
