#!/usr/bin/env node
/*!
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTUOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */

/**
 * imq-release - release a set of @imqueue packages in dependency order.
 *
 * THE PROBLEM. A change to @imqueue/core reaches @imqueue/cli only through
 * @imqueue/rpc, and the one order that works is core, then rpc, then cli - with
 * each consumer's dependency range raised to the version just published, then
 * committed and pushed, BEFORE its own version is bumped. Across a dozen repos
 * that is a lot of bookkeeping, and every way it goes wrong is quiet: a package
 * published against a range predating the fix it was released to carry, a version
 * bumped but never pushed, a consumer released before the dependency it points at
 * is installable.
 *
 * WHAT THIS DOES. Reads every sibling checkout, works out which have commits
 * since their last version tag, adds the packages that depend on those, sorts the
 * result topologically, and for each in turn:
 *
 *   1. raises the range of every @imqueue dependency this run already published,
 *      then commits and pushes that by itself;
 *   2. npm version <type>;
 *   3. git push --follow-tags;
 *   4. npm publish;
 *   5. waits until the registry actually serves the new version before any
 *      dependent tries to install it.
 *
 * SAFETY. It prints a plan and stops. Nothing is committed, pushed or published
 * without --yes. Every repo is fetched and checked before any repo is touched, so
 * the run either starts from a wholly sane state or does not start. If a step
 * fails the run halts there and prints how to resume; anything already on the
 * registry is detected and skipped, so resuming is safe and re-running a finished
 * release is a no-op.
 *
 * WHAT IT WILL NOT DO. It does not run tests - the premise is that CI is already
 * green, and it verifies that through `gh` rather than taking it on trust. It
 * will not touch a repo that is dirty, ahead, behind, or on a non-default branch.
 * It never runs `git add -A`; only package.json and package-lock.json are staged,
 * by explicit path.
 */

'use strict';

const { spawnSync } = require('child_process');
const { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } = require('fs');
const { resolve, join } = require('path');
const https = require('https');

const SCOPE = '@imqueue/';
const STATE_FILE = '.imq-release-state.json';

// Ranges are what a consumer installs by. `dependencies` and `peerDependencies`
// are the fields that make a dependent worth releasing at all; a devDependency
// reaches nobody downstream, so it is refreshed while we are in the repo anyway
// but never drags a package into the release on its own.
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies'];
const ALL_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'];

// Record and field separators for `git log --format`. ASCII RS and US, which
// cannot appear in a commit subject, so a body containing newlines or pipes
// cannot corrupt the parse.
const RS = '\u001e';
const US = '\u001f';

// ---------------------------------------------------------------- output

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const blue = c('36');

const log = (...a) => console.log(...a);
const fail = (m) => { log(`${red('error')} ${m}`); process.exit(1); };

// ---------------------------------------------------------------- shell

/**
 * Run a command and return { code, out, err }.
 *
 * `interactive` hands the child our stdio instead of capturing it. `npm publish`
 * needs that: a registry with 2FA prompts for a one-time password, and a captured
 * stdin turns that prompt into a hang with nothing on screen to explain it.
 */
function sh(cmd, args, { cwd, interactive = false } = {}) {
    const r = spawnSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    if (r.error && r.error.code === 'ENOENT') {
        fail(`\`${cmd}\` is not on PATH - this script needs git, npm and gh.`);
    }

    return {
        code: r.status === null ? 1 : r.status,
        out: (r.stdout || '').trim(),
        err: (r.stderr || '').trim(),
    };
}

const git = (cwd, ...args) => sh('git', args, { cwd });

/** Run, and abort the release if it fails. */
function must(label, cmd, args, opts = {}) {
    const r = sh(cmd, args, opts);

    if (r.code !== 0) {
        log(`${red('FAILED')} ${label}`);
        log(dim(`  $ ${cmd} ${args.join(' ')}`));
        r.out && log(r.out.split('\n').map((l) => '  ' + l).join('\n'));
        r.err && log(r.err.split('\n').map((l) => '  ' + l).join('\n'));

        throw new Error(label);
    }

    return r;
}

// ---------------------------------------------------------------- registry

/**
 * Ask the registry directly rather than shelling out to `npm view`.
 *
 * registry.npmjs.org answers scripted requests. www.npmjs.com serves them bot
 * detection, which is the whole reason imqueue.org publishes /status.json. Do not
 * "improve" this into a website fetch.
 */
function registry(name) {
    return new Promise((ok) => {
        const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
        const req = https.get(url, { timeout: 15000 }, (res) => {
            let body = '';

            res.on('data', (d) => (body += d));
            res.on('end', () => {
                if (res.statusCode === 404) {
                    return ok({ missing: true, versions: {} });
                }

                if (res.statusCode !== 200) {
                    return ok({ error: `HTTP ${res.statusCode}`, versions: {} });
                }

                try {
                    const d = JSON.parse(body);

                    ok({ latest: (d['dist-tags'] || {}).latest, versions: d.versions || {} });
                } catch (e) {
                    ok({ error: 'unparseable registry response', versions: {} });
                }
            });
        });

        req.on('timeout', () => { req.destroy(); ok({ error: 'registry timeout', versions: {} }); });
        req.on('error', (e) => ok({ error: e.message, versions: {} }));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until the registry serves `version`, or give up.
 *
 * Not belt-and-braces. The next package in the order runs
 * `npm install --save @imqueue/<this>@<version>`, which npm resolves against the
 * registry: publish exiting 0 is not the same as the version being installable,
 * and that gap is the exact window in which a dependent gets released pointing at
 * something nobody can install yet.
 */
async function awaitPublished(name, version, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    let waited = 0;

    for (;;) {
        const r = await registry(name);

        if (r.versions && r.versions[version]) {
            waited && log(dim(`      registry served ${version} after ${waited}s`));

            return true;
        }

        if (Date.now() >= deadline) {
            return false;
        }

        await sleep(3000);
        waited += 3;
    }
}

// ---------------------------------------------------------------- discovery

function readJSON(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        return null;
    }
}

/** The GitHub slug, from repository.url, falling back to the directory name. */
function slugOf(pkg, dir) {
    const url = ((pkg.repository || {}).url) || '';
    const m = url.match(/github\.com[/:]+([^/]+)\/([^/]+?)(?:\.git)?$/);

    return m ? `${m[1]}/${m[2]}` : `imqueue/${dir}`;
}

function discover(root) {
    const repos = [];

    for (const dir of readdirSync(root).sort()) {
        const path = join(root, dir);
        const pkgPath = join(path, 'package.json');

        if (!existsSync(join(path, '.git')) || !existsSync(pkgPath)) {
            continue;
        }

        const pkg = readJSON(pkgPath);

        if (!pkg || typeof pkg.name !== 'string') {
            continue;
        }

        // Not a publishable member of the scope: the website, anything private.
        if (!pkg.name.startsWith(SCOPE) || pkg.private) {
            continue;
        }

        const deps = {};

        for (const field of ALL_FIELDS) {
            for (const [n, range] of Object.entries(pkg[field] || {})) {
                if (n.startsWith(SCOPE)) {
                    deps[n] = { field, range };
                }
            }
        }

        repos.push({
            dir,
            path,
            name: pkg.name,
            version: pkg.version,
            slug: slugOf(pkg, dir),
            deps,
            runtimeDeps: Object.entries(deps)
                .filter(([, d]) => RUNTIME_FIELDS.includes(d.field))
                .map(([n]) => n),
        });
    }

    return repos;
}

// ---------------------------------------------------------------- git facts

function defaultBranch(repo) {
    // origin/HEAD is the honest answer and it is what `git clone` records. mcp is
    // on `main` while everything else is on `master`, so assuming either is wrong.
    const r = git(repo.path, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');

    if (r.code === 0 && r.out) {
        return r.out.replace('refs/remotes/origin/', '');
    }

    const g = git(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD');

    return g.code === 0 ? g.out : 'master';
}

function lastTag(repo) {
    const r = git(repo.path, 'describe', '--tags', '--abbrev=0');

    return r.code === 0 && r.out ? r.out : null;
}

function commitsSince(repo, tag) {
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const r = git(repo.path, 'log', '--no-merges', `--format=%H${US}%s${US}%b${RS}`, range);

    if (r.code !== 0 || !r.out) {
        return [];
    }

    return r.out.split(RS)
        .map((rec) => rec.trim())
        .filter(Boolean)
        .map((rec) => {
            const [sha, subject, body] = rec.split(US);

            return { sha, subject: (subject || '').trim(), body: (body || '').trim() };
        });
}

/**
 * Conventional-commit bump inference.
 *
 * `feat!:` or a BREAKING CHANGE trailer means major, `feat:` means minor, and
 * everything else - fix, docs, chore, refactor - means patch. A package pulled in
 * only because a dependency moved has no commits of its own and gets a patch.
 */
function inferBump(commits) {
    let bump = 'patch';

    for (const { subject, body } of commits) {
        if (/^[a-z]+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(body)) {
            return 'major';
        }

        if (/^feat(\([^)]*\))?:/.test(subject)) {
            bump = 'minor';
        }
    }

    return bump;
}

/** Local semver bump, so the plan shows the real number before anything runs. */
function bumpOf(version, type) {
    const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);

    if (!m) {
        return `(${type})`;
    }

    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3]);

    if (type === 'major') {
        return `${major + 1}.0.0`;
    }

    if (type === 'minor') {
        return `${major}.${minor + 1}.0`;
    }

    return `${major}.${minor}.${patch + 1}`;
}

// ---------------------------------------------------------------- ordering

/** Kahn's algorithm over the release set. Reports cycles rather than hanging. */
function topoSort(names, byName) {
    const inSet = new Set(names);
    const indeg = new Map([...inSet].map((n) => [n, 0]));
    const out = new Map([...inSet].map((n) => [n, []]));

    for (const n of inSet) {
        for (const dep of Object.keys(byName.get(n).deps)) {
            if (!inSet.has(dep)) {
                continue;
            }

            out.get(dep).push(n);
            indeg.set(n, indeg.get(n) + 1);
        }
    }

    // Alphabetical within a tier, so two runs over the same set order identically
    // and today's plan can be diffed against yesterday's.
    const ready = [...inSet].filter((n) => indeg.get(n) === 0).sort();
    const order = [];

    while (ready.length) {
        const n = ready.shift();

        order.push(n);

        for (const m of out.get(n).sort()) {
            indeg.set(m, indeg.get(m) - 1);

            if (indeg.get(m) === 0) {
                ready.push(m);
                ready.sort();
            }
        }
    }

    if (order.length !== inSet.size) {
        const cycle = [...inSet].filter((n) => !order.includes(n));

        fail(`dependency cycle among: ${cycle.join(', ')}\n`
            + '        No order can satisfy it. Break the cycle before releasing.');
    }

    return order;
}

// ---------------------------------------------------------------- args

function usage() {
    log(`
${bold('imq-release')} - release @imqueue packages in dependency order.

  ${dim('imq-release [options] [package...]')}

Works out which sibling checkouts have commits since their last version tag, adds
everything that depends on them, sorts that topologically, and for each in turn
raises its @imqueue ranges to what this run just published, commits and pushes
that, bumps, pushes tags and publishes - waiting for the registry to serve each
version before the next package tries to install it.

Prints a plan and stops. ${bold('Nothing is written without --yes.')}

  ${blue('--yes, -y')}         actually do it (default: plan only)
  ${blue('--only a,b')}        restrict the changed set (same as naming packages)
  ${blue('--no-cascade')}      do not pull in dependents of changed packages
  ${blue('--bump <type>')}     force major|minor|patch for every changed package
  ${blue('--bump p=minor,q=patch')}
                    force per package; the rest stay inferred
  ${blue('--skip-ci')}         do not require a green CI run for HEAD
  ${blue('--allow-new')}       permit first-ever publishes (default: refuse)
  ${blue('--root <dir>')}      where the checkouts live (default: this repo's parent)
  ${blue('--timeout <sec>')}   how long to wait for the registry (default 300)
  ${blue('--resume')}          continue a halted run, skipping what already shipped
  ${blue('--no-docs')}         do not refresh imqueue.org afterwards (default: refresh)
  ${blue('--docs-timeout <sec>')}  how long to watch that run (default 1800)
  ${blue('--site-repo <slug>')}    the site repo (default imqueue/imqueue.com)
  ${blue('--site-only')}       refresh the site and nothing else; releases no package

After every package publishes, the site's ${bold('refresh-api-docs')} workflow is
dispatched and watched. It regenerates the /api/ reference for whatever npm now
reports as stale - which also refreshes the version rows on /intro/, since those
render from the same apiVersions.json - rebuilds /status/ and /status.json from
the registry unconditionally, runs the site's checks, and pushes, which deploys.

Bumps are inferred from conventional commits: \`feat!:\` or a BREAKING CHANGE
trailer gives major, \`feat:\` gives minor, anything else patch. A package pulled
in only because a dependency moved gets a patch.
`);
}

function parseArgs(argv) {
    const o = {
        root: null,
        only: null,
        cascade: true,
        yes: false,
        bumps: {},
        defaultBump: null,
        skipCi: false,
        allowNew: false,
        timeout: 300,
        resume: false,
        docs: true,
        docsTimeout: 1800,
        siteRepo: 'imqueue/imqueue.com',
        siteWorkflow: 'refresh-api-docs.yml',
        siteOnly: false,
    };
    const rest = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => {
            const v = argv[++i];

            if (v === undefined) {
                fail(`${a} needs a value`);
            }

            return v;
        };

        if (a === '--root') {
            o.root = val();
        } else if (a === '--only') {
            o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
        } else if (a === '--no-cascade') {
            o.cascade = false;
        } else if (a === '--yes' || a === '-y') {
            o.yes = true;
        } else if (a === '--resume') {
            o.resume = true;
        } else if (a === '--skip-ci') {
            o.skipCi = true;
        } else if (a === '--allow-new') {
            o.allowNew = true;
        } else if (a === '--no-docs') {
            o.docs = false;
        } else if (a === '--site-only') {
            o.siteOnly = true;
        } else if (a === '--site-repo') {
            o.siteRepo = val();
        } else if (a === '--docs-timeout') {
            o.docsTimeout = parseInt(val(), 10);

            if (!Number.isFinite(o.docsTimeout) || o.docsTimeout < 0) {
                fail('--docs-timeout needs a number of seconds');
            }
        } else if (a === '--timeout') {
            o.timeout = parseInt(val(), 10);

            if (!Number.isFinite(o.timeout) || o.timeout < 0) {
                fail('--timeout needs a number of seconds');
            }
        } else if (a === '--bump') {
            const v = val();

            if (v.includes('=')) {
                for (const part of v.split(',')) {
                    const [k, t] = part.split('=');

                    if (!['major', 'minor', 'patch'].includes(t)) {
                        fail(`bad bump type: ${part}`);
                    }

                    o.bumps[k.trim().replace(SCOPE, '')] = t;
                }
            } else {
                if (!['major', 'minor', 'patch'].includes(v)) {
                    fail(`bad bump type: ${v}`);
                }

                o.defaultBump = v;
            }
        } else if (a === '-h' || a === '--help') {
            usage();
            process.exit(0);
        } else if (a.startsWith('-')) {
            fail(`unknown option ${a} (try --help)`);
        } else {
            rest.push(a);
        }
    }

    if (rest.length) {
        o.only = (o.only || []).concat(rest);
    }

    if (o.only) {
        o.only = o.only.map((s) => s.replace(SCOPE, ''));
    }

    return o;
}

// ---------------------------------------------------------------- preflight

function ciStatus(repo, sha, skip) {
    if (skip) {
        return { ok: true, level: 'skip', note: 'skipped' };
    }

    const r = sh('gh', [
        'run', 'list', '--repo', repo.slug, '--commit', sha,
        '--json', 'conclusion,workflowName,status', '--limit', '20',
    ]);

    if (r.code !== 0) {
        return { ok: true, level: 'warn', note: dim('gh unavailable - not checked') };
    }

    let runs;

    try {
        runs = JSON.parse(r.out || '[]');
    } catch (e) {
        return { ok: true, level: 'warn', note: dim('unreadable') };
    }

    // No run at all is not evidence of failure - a docs-only commit may match no
    // workflow trigger - so it warns rather than blocks. An actual failure blocks.
    if (!runs.length) {
        return { ok: true, level: 'warn', note: yellow('no CI run for HEAD') };
    }

    // Judge per WORKFLOW, not per run. One commit can trigger the same workflow
    // twice - pushing the commit and pushing its tag both fire `on: push` - and
    // when a flaky test makes one of those go red while the other goes green, the
    // code is not broken and the release should not stop. Blocking on any red run
    // anywhere teaches the operator to reach for --skip-ci, and a check that is
    // routinely skipped protects nothing. So: a workflow with at least one green
    // run on this commit is green, and the flake is reported rather than hidden.
    const byWorkflow = new Map();

    for (const r of runs) {
        if (!byWorkflow.has(r.workflowName)) {
            byWorkflow.set(r.workflowName, []);
        }

        byWorkflow.get(r.workflowName).push(r);
    }

    const flaky = [];

    for (const [name, list] of byWorkflow) {
        if (list.some((x) => x.status !== 'completed')) {
            return { ok: false, level: 'block', note: yellow(`CI still running: ${name}`) };
        }

        const passed = list.some((x) => x.conclusion === 'success');
        const failed = list.filter((x) =>
            ['failure', 'timed_out', 'cancelled'].includes(x.conclusion));

        if (!passed && failed.length) {
            return { ok: false, level: 'block', note: red(`CI ${failed[0].conclusion}: ${name}`) };
        }

        if (passed && failed.length) {
            flaky.push(name);
        }
    }

    if (flaky.length) {
        return { ok: true, level: 'warn', note: yellow(`green, but ${flaky.join(', ')} also failed on this commit (flaky)`) };
    }

    return { ok: true, level: 'green', note: green('green') };
}

/**
 * Check every repo before touching any of them.
 *
 * The fetch is not optional and it comes first. Without it `git status` compares
 * against refs that may be days old and will cheerfully report a repo as level
 * with origin when origin has moved on - which is how a release gets built on a
 * stale tree. Judging sync from unfetched refs is not a weaker check; it is a
 * check that lies.
 */
async function preflight(repos, opts) {
    log(bold('\nPreflight'));

    const problems = [];

    for (const repo of repos) {
        // Branches and tags are fetched separately and on purpose. `--tags` fails
        // the WHOLE fetch when one local tag disagrees with origin's ("would
        // clobber existing tag"), which would otherwise report a perfectly healthy
        // repo as unreachable and bury the real cause.
        const f = git(repo.path, 'fetch', '--quiet', '--prune', 'origin');

        if (f.code !== 0) {
            const why = f.err.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';

            problems.push([repo.dir, `cannot fetch origin: ${why}`]);
            repo.blocked = true;
            continue;
        }

        // Deliberately NOT --quiet: the "! [rejected] <tag> (would clobber
        // existing tag)" lines are the whole diagnosis, and --quiet discards
        // them, leaving a bare non-zero exit and nothing to report. Both streams
        // are captured here, so this still prints nothing to the console.
        const t = git(repo.path, 'fetch', '--tags', 'origin');

        if (t.code !== 0) {
            const clobbered = (t.err.match(/! \[rejected\]\s+(\S+)/g) || [])
                .map((m) => m.replace(/! \[rejected\]\s+/, ''));

            if (clobbered.length) {
                // A local version tag pointing somewhere other than origin's is a
                // disagreement about what a released version IS, and `git describe`
                // reads those tags to decide what changed. Not auto-forced: throwing
                // away a local tag is the kind of thing a human should choose.
                problems.push([repo.dir,
                    `local tag(s) differ from origin: ${clobbered.join(', ')}`
                    + ` - reconcile with \`git -C ${repo.dir} fetch --tags --force origin\``]);
            } else {
                const why = t.err.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';

                problems.push([repo.dir, `cannot fetch tags: ${why}`]);
            }

            repo.blocked = true;
            continue;
        }

        repo.branch = defaultBranch(repo);

        const cur = git(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD').out;

        if (cur !== repo.branch) {
            problems.push([repo.dir, `on '${cur}', not '${repo.branch}'`]);
        }

        const dirty = git(repo.path, 'status', '--porcelain').out;

        if (dirty) {
            problems.push([repo.dir, `${dirty.split('\n').length} uncommitted change(s)`]);
        }

        const ahead = git(repo.path, 'rev-list', '--count', `origin/${repo.branch}..HEAD`).out;
        const behind = git(repo.path, 'rev-list', '--count', `HEAD..origin/${repo.branch}`).out;

        if (ahead !== '0') {
            problems.push([repo.dir, `${ahead} commit(s) not pushed`]);
        }

        if (behind !== '0') {
            problems.push([repo.dir, `${behind} commit(s) behind origin`]);
        }

        repo.head = git(repo.path, 'rev-parse', 'HEAD').out;
        repo.tag = lastTag(repo);
        repo.commits = commitsSince(repo, repo.tag);

        const reg = await registry(repo.name);

        repo.published = reg.versions || {};
        repo.npmLatest = reg.latest;
        repo.isNew = !!reg.missing;

        // The tree must describe what the registry already has, or the bump is
        // computed from the wrong base. This catches the classic "npm version and
        // npm publish, forgot to push", and its mirror image.
        if (!reg.missing && reg.latest && reg.latest !== repo.version) {
            problems.push([repo.dir,
                `package.json says ${repo.version} but npm serves ${reg.latest}`]);
        }
    }

    for (const repo of repos) {
        if (repo.blocked) {
            continue;
        }

        const ci = ciStatus(repo, repo.head, opts.skipCi);

        repo.ci = ci;

        if (!ci.ok) {
            problems.push([repo.dir, ci.note]);
        }
    }

    if (problems.length) {
        log(`\n${red('Preflight failed.')} Nothing has been changed.\n`);

        for (const [dir, msg] of problems) {
            log(`  ${bold(dir.padEnd(26))} ${msg}`);
        }

        log(`\n  Fix these and run again. ${dim('--skip-ci relaxes only the CI checks.')}`);
        process.exit(1);
    }

    log(`  ${green('ok')}    ${repos.length} repo(s): clean, on their default branch, level with origin`);
    log(`  ${green('ok')}    every package.json version agrees with the registry`);
    log(`  ${green('ok')}    CI ${opts.skipCi ? dim('(skipped)') : 'green for every HEAD'}`);

    // Tolerated, but never silent. A flaky workflow and a commit no workflow ran
    // on are both things the operator should know before publishing, even though
    // neither is grounds to stop.
    for (const r of repos.filter((x) => x.ci && x.ci.level === 'warn')) {
        log(`  ${yellow('note')}  ${r.dir}: ${r.ci.note}`);
    }
}

// ---------------------------------------------------------------- the site

/**
 * Regenerate imqueue.org once every package is out.
 *
 * WHY THIS BELONGS IN THE RELEASE. imqueue.org is the only place an agent can
 * read what version, licence and Node floor a package has - npmjs.com serves bot
 * detection to scripted fetches, which is why /status.json exists at all. A
 * release that does not refresh it leaves the one authoritative answer stale, and
 * the daily cron will not catch up until 04:17 UTC tomorrow.
 *
 * It dispatches the site's own refresh-api-docs workflow rather than duplicating
 * what that does. That workflow:
 *
 *   - rebuilds the /api/ reference for whatever npm now reports as stale, which
 *     also rewrites src/_data/apiVersions.json;
 *   - and so updates the version rows on /intro/, which are not hand-written:
 *     src/_data/atAGlance.js reads apiVersions.json, and the at-a-glance include
 *     renders it into /intro/, its markdown mirror and llms-full.txt;
 *   - rebuilds /status/ and /status.json from the registry UNCONDITIONALLY -
 *     a licence or engines.node change moves no version number, so a staleness
 *     gate would miss it;
 *   - runs the site's full checks, and pushes, which is what deploys.
 *
 * A failure here does NOT mean the release failed; every package is already on
 * the registry and cannot be unpublished. It does mean the site is advertising
 * old versions, which is worth a non-zero exit so it cannot pass unnoticed. The
 * recovery is `--resume --yes`: every package is skipped as already published and
 * this step runs again.
 */
async function refreshSite(opts, shipped, force = false) {
    log(bold('\nimqueue.org'));

    if (!shipped.length && !force) {
        log(`  ${dim('skip')}  nothing was published, so the site cannot be out of date`);

        return true;
    }

    const wf = ['--repo', opts.siteRepo, '--workflow', opts.siteWorkflow];

    // No --jq here on purpose. A jq format string is full of backslashes, and a
    // backslash that has to survive both a JS string literal and a shell-less
    // argv is a quoting bug waiting to happen - the first cut of this silently
    // asked jq for a literal string and polled forever. Ask for JSON and parse it
    // in the one language that is definitely not going to mangle it.
    const newest = () => {
        const r = sh('gh', ['run', 'list', ...wf, '--limit', '1',
            '--json', 'databaseId,status,conclusion']);

        if (r.code !== 0 || !r.out) {
            return null;
        }

        try {
            const [run] = JSON.parse(r.out);

            return run ? { id: String(run.databaseId), status: run.status, conclusion: run.conclusion } : null;
        } catch (e) {
            return null;
        }
    };

    // Remember which run was newest BEFORE dispatching. `gh workflow run` returns
    // no run id, and GitHub takes a moment to create one, so "the newest run" is
    // ambiguous until it differs from what was there a second ago.
    const before = newest();
    const beforeId = before ? before.id : null;

    const d = sh('gh', ['workflow', 'run', opts.siteWorkflow, '--repo', opts.siteRepo]);

    if (d.code !== 0) {
        log(`  ${red('failed')} to dispatch: ${d.err.split('\n').pop() || 'unknown error'}`);
        log(`  ${dim('run it yourself:')} gh workflow run ${opts.siteWorkflow} --repo ${opts.siteRepo}`);

        return false;
    }

    log(`  ${green('dispatched')} ${opts.siteWorkflow} on ${opts.siteRepo}`);

    const deadline = Date.now() + opts.docsTimeout * 1000;
    let id = null;

    for (;;) {
        const cur = newest();

        if (cur && cur.id !== beforeId) {
            id = cur.id;

            if (cur.status === 'completed') {
                if (cur.conclusion === 'success') {
                    log(`  ${green('ok')}    /api/, /intro/, /status/ and /status.json regenerated and deployed`);
                    log(dim(`        https://github.com/${opts.siteRepo}/actions/runs/${id}`));

                    return true;
                }

                log(`  ${red('failed')} the site refresh concluded '${cur.conclusion}'`);
                log(dim(`        https://github.com/${opts.siteRepo}/actions/runs/${id}`));

                return false;
            }
        }

        if (Date.now() >= deadline) {
            log(`  ${yellow('timed out')} after ${opts.docsTimeout}s - the run may still finish`);
            id && log(dim(`        https://github.com/${opts.siteRepo}/actions/runs/${id}`));

            return false;
        }

        await sleep(10000);
    }
}

// ---------------------------------------------------------------- state

const statePath = (root) => join(root, STATE_FILE);

function loadState(root) {
    const p = statePath(root);

    return existsSync(p) ? readJSON(p) || { done: {} } : { done: {} };
}

function saveState(root, state) {
    writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------- main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const root = resolve(opts.root || resolve(__dirname, '..', '..'));

    if (!existsSync(root)) {
        fail(`--root ${root} does not exist`);
    }

    log(bold('\nimq-release') + dim(`  root=${root}`));

    // Refresh the site and nothing else. Useful on its own, and it is the recovery
    // path when a release published cleanly but the site step failed afterwards.
    if (opts.siteOnly) {
        const ok = await refreshSite(opts, [], true);

        log('');
        process.exit(ok ? 0 : 1);
    }

    const repos = discover(root);

    if (!repos.length) {
        fail(`no @imqueue package checkouts under ${root}`);
    }

    const byName = new Map(repos.map((r) => [r.name, r]));
    const byDir = new Map(repos.map((r) => [r.dir, r]));

    if (opts.only) {
        for (const nm of opts.only) {
            if (!byDir.has(nm) && !byName.has(SCOPE + nm)) {
                fail(`no checkout for '${nm}' under ${root}`);
            }
        }
    }

    await preflight(repos, opts);

    // ---- which packages changed on their own
    const changed = new Set();

    for (const repo of repos) {
        const named = !!opts.only
            && (opts.only.includes(repo.dir) || opts.only.includes(repo.name.replace(SCOPE, '')));

        if (opts.only && !named) {
            continue;
        }

        if (repo.isNew && !opts.allowNew) {
            continue;
        }

        // Named explicitly with no new commits: trust the human, they may be
        // re-releasing deliberately.
        if (repo.commits.length || named) {
            changed.add(repo.name);
        }
    }

    if (!changed.size) {
        log(`\n${green('Nothing to release.')} Every package is level with its last version tag.\n`);

        return;
    }

    // ---- and which get dragged in because something they use moved
    const release = new Set(changed);

    if (opts.cascade) {
        for (let grew = true; grew;) {
            grew = false;

            for (const repo of repos) {
                if (release.has(repo.name) || (repo.isNew && !opts.allowNew)) {
                    continue;
                }

                if (repo.runtimeDeps.some((d) => release.has(d))) {
                    release.add(repo.name);
                    grew = true;
                }
            }
        }
    }

    const order = topoSort([...release], byName);
    const state = opts.resume ? loadState(root) : { done: {} };

    // ---- decide each new version, in order, so dependents can see it
    const planned = new Map();

    for (const name of order) {
        const repo = byName.get(name);
        const forced = opts.bumps[repo.dir] || opts.bumps[name.replace(SCOPE, '')];
        let type;
        let why;

        if (changed.has(name)) {
            type = forced || opts.defaultBump || inferBump(repo.commits);
            why = (forced || opts.defaultBump) ? 'forced' : `${repo.commits.length} commit(s)`;
        } else {
            type = forced || 'patch';

            const trigger = repo.runtimeDeps.filter((d) => release.has(d));

            why = `depends on ${trigger.map((t) => t.replace(SCOPE, '')).join(', ')}`;
        }

        planned.set(name, { repo, type, why, next: bumpOf(repo.version, type) });
    }

    // ---- show it
    log(bold('\nPlan') + dim(`  ${order.length} package(s), in dependency order`));
    log(dim('  ' + '-'.repeat(78)));

    order.forEach((name, i) => {
        const p = planned.get(name);
        const deps = p.repo.runtimeDeps.filter((d) => release.has(d));
        const doneMark = state.done[name] ? green('  [already published]') : '';

        log(`  ${dim(String(i + 1).padStart(2))} ${bold(name.padEnd(34))}`
            + ` ${p.repo.version} ${dim('->')} ${green(p.next)}`
            + `  ${dim(`(${p.type}: ${p.why})`)}${doneMark}`);

        for (const d of deps) {
            log(`     ${dim('raise')} ${d} ${dim('->')} ^${planned.get(d).next}`);
        }
    });

    log(dim('  ' + '-'.repeat(78)));

    if (!opts.yes) {
        log(`\n${yellow('Plan only.')} Re-run with ${bold('--yes')} to publish.\n`);

        return;
    }

    // ---- do it
    log(bold('\nReleasing'));

    for (const name of order) {
        const { repo, type, next } = planned.get(name);

        if (state.done[name]) {
            log(`  ${dim('skip')}  ${name} - already published by this run`);
            continue;
        }

        // Cheapest possible resume: if the registry already has it, an earlier run
        // finished this package and died later on.
        const reg = await registry(name);

        if (reg.versions && reg.versions[next]) {
            log(`  ${dim('skip')}  ${name}@${next} is already on the registry`);
            state.done[name] = next;
            saveState(root, state);
            continue;
        }

        log(`\n  ${bold(name)} ${repo.version} ${dim('->')} ${green(next)}`);

        try {
            // 1. raise the ranges this run has already published
            const bumpedDeps = [];

            for (const dep of Object.keys(repo.deps)) {
                const shipped = state.done[dep];

                if (!shipped || repo.deps[dep].range === `^${shipped}`) {
                    continue;
                }

                log(`      ${dim('npm i --save')} ${dep}@${shipped}`);
                must(`${repo.dir}: install ${dep}@${shipped}`,
                    'npm', ['install', '--save', `${dep}@${shipped}`], { cwd: repo.path });
                bumpedDeps.push(`${dep.replace(SCOPE, '')} -> ^${shipped}`);
            }

            // 2. commit and push that by itself, before the version bump, so the
            //    tag lands on a tree already pointing at the right dependencies
            if (bumpedDeps.length) {
                // Only manifests that exist and are actually trackable. `git add`
                // errors on a pathspec matching nothing and on an ignored file, and
                // an error here aborts a release halfway through - with some
                // packages already published and unpublishable. Not every repo in
                // the world commits its lockfile.
                const manifests = ['package.json', 'package-lock.json'].filter((f) =>
                    existsSync(join(repo.path, f))
                    && git(repo.path, 'check-ignore', '-q', '--', f).code !== 0);

                const dirty = git(repo.path, 'status', '--porcelain', '--', ...manifests).out;

                if (dirty) {
                    // Explicit pathspec. A release tool must never `git add -A`:
                    // whatever else is lying around is not ours to commit.
                    must(`${repo.dir}: stage manifests`, 'git',
                        ['add', '--', ...manifests], { cwd: repo.path });
                    must(`${repo.dir}: commit deps`, 'git',
                        ['commit', '-m', `chore(deps): ${bumpedDeps.join(', ')}`], { cwd: repo.path });
                    must(`${repo.dir}: push deps`, 'git', ['push'], { cwd: repo.path });
                    log(`      ${green('pushed')} chore(deps): ${bumpedDeps.join(', ')}`);
                }
            }

            // 3. bump
            must(`${repo.dir}: npm version ${type}`, 'npm', ['version', type], { cwd: repo.path });
            log(`      ${green('bumped')} ${type} -> ${next}`);

            // 4. push commit AND tag. Never publish what the remote has not seen:
            //    an unpushed tag is a published version nobody can check out.
            must(`${repo.dir}: push --follow-tags`, 'git',
                ['push', '--follow-tags'], { cwd: repo.path });
            log(`      ${green('pushed')} commit + tag`);

            // 5. publish, with our stdio so a 2FA prompt actually works
            const pub = sh('npm', ['publish'], { cwd: repo.path, interactive: true });

            if (pub.code !== 0) {
                throw new Error(`${repo.dir}: npm publish exited ${pub.code}`);
            }

            // 6. and do not move on until it is genuinely installable
            if (!await awaitPublished(name, next, opts.timeout)) {
                throw new Error(`${name}@${next} published, but the registry has not served it`
                    + ` within ${opts.timeout}s - stopping rather than releasing a dependent`
                    + ' against a version that cannot yet be installed');
            }

            log(`      ${green('published')} ${name}@${next}`);
            state.done[name] = next;
            saveState(root, state);
        } catch (e) {
            saveState(root, state);
            log(`\n${red('Halted')} at ${bold(name)}: ${e.message}`);
            log(`\n  ${Object.keys(state.done).length} package(s) published before this one.`);
            log('  Fix the cause, then resume with:\n');
            log(`      ${bold('imq-release --resume --yes')}\n`);
            log(dim(`  State: ${statePath(root)}`));
            process.exit(1);
        }
    }

    log(bold('\nDone'));

    for (const name of order) {
        log(`  ${green('published')} ${name}@${state.done[name]}`);
    }

    let siteOk = true;

    if (opts.docs) {
        siteOk = await refreshSite(opts, order.filter((n) => state.done[n]));
    } else {
        log(bold('\nimqueue.org'));
        log(`  ${yellow('skipped')} --no-docs: /api/, /intro/ and /status/ still describe the previous versions.`);
        log(dim(`          The daily cron will catch up, or: `)
            + `gh workflow run ${opts.siteWorkflow} --repo ${opts.siteRepo}`);
    }

    // The state file exists only to survive a failure. A clean finish should not
    // leave one behind for the next run to misread as history.
    existsSync(statePath(root)) && unlinkSync(statePath(root));

    if (!siteOk) {
        // Every package is on the registry and none of it can be undone, so this is
        // emphatically not a failed release - but the site is advertising versions
        // that no longer exist, and that must not slip by in a wall of green.
        log(`\n${red('Every package published, but imqueue.org was not refreshed.')}`);
        log('  /status.json is the only version, licence and Node-floor source an');
        log('  agent can actually read, and it - along with /api/ and /intro/ - is');
        log('  now behind. Re-run with:\n');
        log(`      ${bold('imq-release --resume --yes')}`);
        log(dim('  (every package is skipped as already published; only the site runs)\n'));
        process.exit(1);
    }

    log('');
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
