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
const { resolve } = require('path');
const { writeFileSync } = require('fs');
const { execSync } = require('child_process');
const cwd = process.cwd();
const targetFile = resolve(cwd, 'package.json');
const sourcePackage = require(resolve(__dirname, '..', 'package.json'));
let targetPackage = require(targetFile);

const RX_SEMVER = new RegExp(
    '^v?(?:\\d+)(\\.(?:[x*]|\\d+)(\\.(?:[x*]|\\d+)(\\.(?:[x*]|\\d+))?' +
    '(?:-[\\da-z\\-]+(?:\\.[\\da-z\\-]+)*)?(?:\\+[\\da-z\\-]+' +
    '(?:\\.[\\da-z\\-]+)*)?)?)?$',
    'i',
);
const RX_V = /^v/;
const RX_ESC = /\+.*$/;
const RX_CLS = /^[~^]/;

function indexOrEnd(str, q) {
    return !~str.indexOf(q) ? str.length : str.indexOf(q);
}

function split(v) {
    const c = v.replace(RX_V, '').replace(RX_ESC, '');
    const patchIndex = indexOrEnd(c, '-');
    const arr = c.substring(0, patchIndex).split('.');

    arr.push(c.substring(patchIndex + 1));

    return arr;
}

function tryParse(v) {
    return isNaN(Number(v)) ? v : Number(v);
}

function ensureValid(version) {
    if (typeof version !== 'string') {
        throw new TypeError('Invalid argument expected string');
    }

    if (!RX_SEMVER.test(version)) {
        throw new Error(
            `Invalid argument not valid semver ('${version}' received)`,
        );
    }
}

function compareVersions(v1, v2) {
    [v1, v2].forEach(ensureValid);

    const s1 = split(v1);
    const s2 = split(v2);

    for (let i = 0; i < Math.max(s1.length - 1, s2.length - 1); i++) {
        const n1 = parseInt(s1[i] || 0, 10);
        const n2 = parseInt(s2[i] || 0, 10);

        if (n1 > n2) {
            return 1;
        }

        if (n2 > n1) {
            return -1;
        }
    }

    const sp1 = s1[s1.length - 1];
    const sp2 = s2[s2.length - 1];

    if (sp1 && sp2) {
        const p1 = sp1.split('.').map(tryParse);
        const p2 = sp2.split('.').map(tryParse);

        for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
            if (
                p1[i] === undefined ||
                typeof p2[i] === 'string' &&
                typeof p1[i] === 'number'
            ) {
                return -1;
            }

            if (
                p2[i] === undefined ||
                typeof p1[i] === 'string' &&
                typeof p2[i] === 'number'
            ) {
                return 1;
            }

            if (p1[i] > p2[i]) {
                return 1;
            }

            if (p2[i] > p1[i]) {
                return -1;
            }
        }
    } else if (sp1 || sp2) {
        return sp1 ? -1 : 1;
    }

    return 0;
}

const allowedOperators = [
    '>',
    '>=',
    '=',
    '<',
    '<=',
];

const operatorResMap = {
    '>': [1],
    '>=': [0, 1],
    '=': [0],
    '<=': [-1, 0],
    '<': [-1],
};

function validateOperator(op) {
    if (typeof op !== 'string') {
        throw new TypeError(
            'Invalid operator type, expected string but got ' + typeof op,
        );
    }

    if (allowedOperators.indexOf(op) === -1) {
        throw new TypeError(
            'Invalid operator, expected one of ' + allowedOperators.join('|'),
        );
    }
}

function compare(v1, v2, operator) {
    // Validate operator
    validateOperator(operator);

    // since result of compareVersions can only be -1 or 0 or 1
    // a simple map can be used to replace switch
    const res = compareVersions(v1, v2);

    return operatorResMap[operator].indexOf(res) > -1;
}

function clear(version) {
    return version.replace(RX_CLS, '');
}

function merge(src, dst) {
    if (!src.dependencies) {
        console.log('Wrong source package!');
        return process.exit(1);
    }

    if (!dst.dependencies) {
        dst.dependencies = {};
    }

    let pkg = null;

    for (const name of Object.keys(src.dependencies)) {
        const version = dst.dependencies[name];

        if (dst.dependencies[name]) {
            const greater = compare(
                clear(version),
                clear(dst.dependencies[name]),
                '>',
            );
            if (greater) {
                dst.dependencies[name] = version;
                pkg = dst;
            }
        } else {
            dst.dependencies[name] = version;
            pkg = dst;
        }
    }

    return pkg;
}

const pkg = merge(sourcePackage, targetPackage);

if (pkg) {
    writeFileSync(
        targetFile,
        JSON.stringify(pkg, null, 2),
        { encoding: 'utf8' },
    );
    execSync(
        'npm install --ignore-scripts',
        { cwd, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    execSync(
        'npm install -g @imqueue/cli',
        { cwd, stdio: ['ignore', 'ignore', 'inherit'] },
    );
}
