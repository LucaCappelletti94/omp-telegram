// Serves a batched pr-watch GraphQL query from a table file, so the fake responses carry the same
// field set as a real `gh api graphql` answer, whatever the aliases the query asks for.
//
// Table shape, keyed by "<owner>/<name>/<number>":
//   { ...pull request fields }            -> found, served under the alias
//   { __gone: "pr" }                      -> pullRequest null, NOT_FOUND on [alias, "pullRequest"]
//   { __gone: "repo" }                    -> alias null, NOT_FOUND on [alias]
//   { __error: "message" }                -> alias null, a non-NOT_FOUND error on [alias]
import { readFileSync } from "node:fs";

const table = JSON.parse(readFileSync(process.argv[2], "utf8"));
const arg = process.argv.slice(3).find((a) => a.startsWith("query="));
if (typeof arg !== "string") {
	process.stderr.write("watch-gh: no query argument\n");
	process.exit(1);
}
const aliasRe =
	/(\w+):\s*repository\(owner:\s*"([^"]+)",\s*name:\s*"([^"]+)"\)\s*\{\s*pullRequest\(number:\s*(\d+)\)/gu;
const data = {};
const errors = [];
for (const match of arg.slice("query=".length).matchAll(aliasRe)) {
	const alias = match[1];
	const owner = match[2];
	const name = match[3];
	const number = Number(match[4]);
	const key = `${owner}/${name}/${number}`;
	const entry = table[key];
	const location = { line: 1, column: 1 };
	if (entry === undefined || entry.__gone === "pr" || entry.__gone === true) {
		data[alias] = { pullRequest: null };
		errors.push({
			type: "NOT_FOUND",
			path: [alias, "pullRequest"],
			locations: [location],
			message: `Could not resolve to a PullRequest with the number of ${number}.`,
		});
	} else if (entry.__gone === "repo") {
		data[alias] = null;
		errors.push({
			type: "NOT_FOUND",
			path: [alias],
			locations: [location],
			message: `Could not resolve to a Repository with the name '${owner}/${name}'. (repository)`,
		});
	} else if (typeof entry.__error === "string") {
		data[alias] = null;
		errors.push({ type: "INTERNAL", path: [alias], locations: [location], message: entry.__error });
	} else {
		data[alias] = { pullRequest: entry };
	}
}
const out = { data };
if (errors.length > 0) out.errors = errors;
process.stdout.write(`${JSON.stringify(out)}\n`);
