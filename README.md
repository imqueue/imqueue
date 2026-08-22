# @imqueue/imqueue

[![License](https://img.shields.io/badge/license-GPL-blue.svg)](https://github.com/imqueue/imqueue/blob/master/LICENSE)

Maintainer tooling for the [@imqueue](https://imqueue.org) framework. Not a
published package and nothing to install — it is the home of the scripts that
operate the other repositories.

**Not published to npm.** `package.json` carries `"private": true`, so `npm
publish` refuses to run here — this is deliberate, not an oversight. A `0.0.20`
was published by accident once and had to be removed from the registry. Drop the
flag only as part of an intentional first release.

Current version, licence and Node floor for every published package:
[imqueue.org/status.json](https://imqueue.org/status.json).

## `bin/imq-release.js`

Releases a set of @imqueue packages in dependency order.

The problem it solves: a change to `@imqueue/core` reaches `@imqueue/cli` only
through `@imqueue/rpc`, and the one order that works is core, then rpc, then cli —
with each consumer's dependency range raised to the version just published, then
committed and pushed, *before* its own version is bumped. Done by hand across a
dozen repositories that is a lot of bookkeeping, and every way it goes wrong is
quiet: a package published against a range predating the fix it was released to
carry, a version bumped but never pushed, a consumer released before the
dependency it points at is installable.

~~~bash
# what would happen — reads everything, writes nothing
./bin/imq-release.js

# do it
./bin/imq-release.js --yes
~~~

It reads every sibling checkout, works out which have commits since their last
version tag, adds everything that depends on those, sorts that topologically, and
for each package in turn:

1. raises the range of every @imqueue dependency this run already published, then
   commits and pushes that by itself;
2. `npm version <type>`;
3. `git push --follow-tags`;
4. `npm publish`;
5. waits until the registry actually **serves** the new version — `npm publish`
   returning 0 is not the same as the version being installable, and that gap is
   the window in which a dependent gets released pointing at something nobody can
   install yet.

### It finishes on imqueue.org

When every package is out it dispatches the site's `refresh-api-docs` workflow and
watches it to completion. That workflow:

- rebuilds the `/api/` reference for whatever npm now reports as stale, which also
  rewrites `src/_data/apiVersions.json`;
- and so refreshes the version rows on **`/intro/`**, which are not hand-written:
  `src/_data/atAGlance.js` reads `apiVersions.json` and the `at-a-glance` include
  renders it into `/intro/`, its markdown mirror and `llms-full.txt`;
- rebuilds **`/status/`** and **`/status.json`** from the registry
  *unconditionally* — a licence or `engines.node` change moves no version number,
  so a staleness gate would miss it;
- runs the site's full checks, and pushes, which is what deploys.

`--no-docs` skips that step. `--site-only` does only that step and releases
nothing.

### Options

| | |
|---|---|
| `--yes`, `-y` | actually do it. Default is plan-only |
| `--only a,b` | restrict the changed set (same as naming packages) |
| `--no-cascade` | do not pull in dependents of changed packages |
| `--bump <type>` | force `major`/`minor`/`patch` for every changed package |
| `--bump p=minor,q=patch` | force it per package; the rest stay inferred |
| `--skip-ci` | do not require a green CI run for HEAD |
| `--allow-new` | permit first-ever publishes. Default is to refuse |
| `--root <dir>` | where the checkouts live. Default is this repo's parent |
| `--timeout <sec>` | how long to wait for the registry (default 300) |
| `--resume` | continue a halted run, skipping what already shipped |
| `--no-docs` | do not refresh imqueue.org afterwards |
| `--site-only` | refresh imqueue.org and nothing else; release no package |
| `--docs-timeout <sec>` | how long to watch that run (default 1800) |
| `--site-repo <slug>` | the site repo (default `imqueue/imqueue.com`) |

Bump types are inferred from conventional commits: `feat!:` or a `BREAKING CHANGE`
trailer gives major, `feat:` gives minor, anything else patch. A package pulled in
only because a dependency moved gets a patch.

### What it refuses to do

It prints a plan and stops. Nothing is committed, pushed or published without
`--yes`.

Every repository is fetched and checked **before any repository is touched**, so a
run either starts from a wholly sane state or does not start at all. It will not
proceed past a checkout that is dirty, ahead of origin, behind origin, on a
non-default branch, whose `package.json` version disagrees with what npm serves,
or whose local tags disagree with origin's. The fetch is not optional and it comes
first: judging sync against unfetched refs is not a weaker check, it is a check
that lies.

CI is judged per workflow rather than per run. One commit can trigger the same
workflow twice — pushing the commit and pushing its tag both fire `on: push` — and
a flaky test can make one go red while the other goes green. A workflow with at
least one green run on the commit counts as green, and the flake is reported
rather than hidden. Blocking on any red run anywhere just teaches you to reach for
`--skip-ci`, and a check that is routinely skipped protects nothing.

It never runs `git add -A`. Only `package.json` and `package-lock.json` are
staged, by explicit path, and only when they exist and are not ignored.

It does not run tests. The premise is that CI is already green, and it verifies
that through `gh` rather than taking it on trust.

### When something fails

The run halts at the package that failed and prints how to resume. Anything
already on the registry is detected and skipped, so resuming is safe and
re-running a finished release is a no-op:

~~~bash
./bin/imq-release.js --resume --yes
~~~

A failure in the site refresh is reported separately and exits non-zero, but it is
not a failed release — every package is already published and cannot be
unpublished. It means imqueue.org is advertising versions that no longer exist,
which the same `--resume --yes` fixes.

## Requirements

`git`, `npm` and [`gh`](https://cli.github.com/) on `PATH` and authenticated.
Node 18 or newer. No dependencies — the script uses Node built-ins only.

## Contributing

Any contributions greatly appreciated. Feel free to fork, propose PRs, open
issues, do whatever you think may be helpful to this project. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the GNU General Public License v3.0.
See the [LICENSE](LICENSE)

Happy Coding!
